import { readFileSync } from 'node:fs';
import { get } from 'node:https';

export type Gateway = { name: string; status: string; latency_ms: number | null; loss_percent: number | null };

function metric(value: unknown, unit: string, maximum: number) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim().replace(unit, '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  return number <= maximum ? number : null;
}

export function parseGateways(input: unknown): Gateway[] {
  const body = input as { status?: unknown; items?: unknown } | null;
  if (body?.status !== 'ok' || !Array.isArray(body.items)) throw new Error('Invalid gateway response');
  return body.items.slice(0, 64).flatMap(item => {
    if (typeof item?.name !== 'string' || !item.name || item.name.length > 128) return [];
    const loss = metric(item.loss, '%', 100);
    const latency = metric(item.delay, 'ms', 60_000);
    const status = ['down', 'force_down'].includes(item.status) ? 'offline'
      : ['delay', 'loss', 'delay+loss'].includes(item.status) ? 'warning'
      : item.status === 'none' && (loss !== null || latency !== null) ? 'online' : 'unknown';
    return [{ name: item.name, status, latency_ms: latency, loss_percent: loss }];
  });
}

export function configureGatewayReader(env = process.env) {
  if (!env.OPNSENSE_API_URL) return undefined;
  const origin = new URL(env.OPNSENSE_API_URL);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('OPNSENSE_API_URL must be an HTTPS origin');
  }
  if (!env.OPNSENSE_API_KEY || !env.OPNSENSE_API_SECRET) throw new Error('Missing OPNsense API credentials');
  const authorization = 'Basic ' + Buffer.from(env.OPNSENSE_API_KEY + ':' + env.OPNSENSE_API_SECRET).toString('base64');
  const ca = env.OPNSENSE_API_CA_FILE ? readFileSync(env.OPNSENSE_API_CA_FILE) : undefined;
  const url = new URL('/api/routes/gateway/status', origin);
  return (signal: AbortSignal) => new Promise<Gateway[]>((resolve, reject) => {
    const request = get(url, {
      ca, rejectUnauthorized: true, headers: { Authorization: authorization, Accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    }, response => {
      response.on('error', reject);
      if (response.statusCode !== 200) {
        response.destroy();
        reject(new Error('OPNsense gateway request failed'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 256 * 1024) response.destroy(new Error('OPNsense response exceeds limit'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try { resolve(parseGateways(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
        catch { reject(new Error('Invalid OPNsense gateway response')); }
      });
    });
    request.on('error', reject);
  });
}
