import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { DeviceConfigError, loadDevices, projectRoot, saveDevices } from './configuration.js';
import { configureSecurity } from './security.js';
import { pollSnmp, type Sample } from './snmp.js';
import { buildTopology, type Speedtest } from './topology.js';

function envNumber(name: string, fallback: number, minimum: number) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value)) throw new Error(`Invalid ${name}`);
  return Math.max(minimum, value);
}

let devices = loadDevices();
let revision = randomUUID();
const mock = (process.env.MOCK_MODE ?? 'true').trim().toLowerCase() === 'true';
const interval = envNumber('POLL_INTERVAL', 3, 0.5) * 1000;
const host = process.env.HOST || process.env.DASHBOARD_HOST || '127.0.0.1';
const port = Number(process.env.PORT || process.env.DASHBOARD_PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT or DASHBOARD_PORT');

let speedtest: Speedtest | null = null;
let previous = new Map<string, Sample>();
const metadataCache = new Map<string, Pick<Sample['tables'], 'name' | 'lldp'>>();
let snapshot = buildTopology(devices, previous, previous, mock, speedtest);
let cycle = 0;
let stopped = false;
let pollTimer: NodeJS.Timeout | undefined;
let speedtestTimer: NodeJS.Timeout | undefined;
const shutdown = new AbortController();

const app = express();
app.disable('x-powered-by');
const security = configureSecurity(app, mock, host);
app.get('/healthz', (_request, response) => response.json({ status: 'ok' }));
app.get('/api/topology', (_request, response) => response.set('Cache-Control', 'no-store').json(snapshot));
app.get('/api/device-config', (_request, response) => {
  response.set('Cache-Control', 'no-store').json({ devices, revision });
});
app.put('/api/device-config', express.json({ limit: '256kb' }), (request, response) => {
  if (!request.is('application/json') || request.get('X-Device-Config') !== '1') {
    response.status(415).json({ error: 'Yêu cầu lưu cấu hình không hợp lệ.' });
    return;
  }
  if (request.body?.revision !== revision) {
    response.status(409).json({ error: 'Cấu hình đã thay đổi. Tải lại trang trước khi chỉnh sửa tiếp.' });
    return;
  }
  try {
    devices = saveDevices(request.body);
  } catch (error) {
    if (error instanceof DeviceConfigError) {
      response.status(400).json({ error: error.message });
    } else {
      console.error('Device configuration write failed');
      response.status(500).json({ error: 'Không ghi được cấu hình thiết bị.' });
    }
    return;
  }
  revision = randomUUID();
  previous.clear();
  metadataCache.clear();
  publish(new Map());
  response.json({ devices, revision });
});
app.use(express.static(resolve(projectRoot, 'frontend/dist')));
app.get('/devices', (_request, response) => response.sendFile(resolve(projectRoot, 'frontend/dist/index.html')));
app.use((error: { status?: number }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const status = error.status === 413 ? 413 : error.status === 400 ? 400 : 500;
  response.status(status).json({ error: 'Không xử lý được yêu cầu.' });
});

const server = createServer(app);
const streams = new WebSocketServer({ noServer: true, maxPayload: 1024 });
server.on('upgrade', (request, socket, head) => {
  const status = request.url !== '/ws/topology' ? '404 Not Found'
    : !security.originAllowed(request) ? '403 Forbidden'
    : !security.authenticated(request) ? '401 Unauthorized' : null;
  if (status) {
    socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  streams.handleUpgrade(request, socket, head, client => streams.emit('connection', client, request));
});
streams.on('connection', client => {
  client.on('error', () => client.terminate());
  client.send(JSON.stringify(snapshot));
});

async function runPoller() {
  const pollRevision = revision;
  const managed = devices.filter(device => device.snmp);
  const start = performance.now();
  const samples = new Map<string, Sample>();
  if (!mock) {
    const results = await Promise.allSettled(managed.map(device =>
      pollSnmp(device, cycle % 20 === 0 || !metadataCache.has(device.id))));
    if (stopped) return;
    if (pollRevision !== revision) {
      pollTimer = setTimeout(runPoller, 0);
      return;
    }
    results.forEach((result, index) => {
      const { id } = managed[index];
      if (result.status === 'rejected') {
        console.warn(`SNMP poll failed for ${id}`);
        return;
      }
      const sample = result.value;
      const cached = metadataCache.get(id);
      sample.tables.name ??= cached?.name;
      sample.tables.lldp ??= cached?.lldp;
      if (sample.tables.name || sample.tables.lldp) {
        metadataCache.set(id, { name: sample.tables.name, lldp: sample.tables.lldp });
      }
      samples.set(id, sample);
    });
  }
  if (stopped) return;
  publish(samples);
  cycle += 1;
  pollTimer = setTimeout(runPoller, Math.max(0, interval - (performance.now() - start)));
}

function publish(samples: Map<string, Sample>) {
  snapshot = buildTopology(devices, samples, previous, mock, speedtest);
  previous = samples;
  const payload = JSON.stringify(snapshot);
  for (const client of streams.clients) {
    if (client.readyState === WebSocket.OPEN && client.bufferedAmount === 0) client.send(payload);
  }
}

async function updateSpeedtest(url: string, intervalMs: number) {
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(5000)]) });
    if (!response.ok) throw new Error('Speedtest endpoint returned an error');
    const data = await response.json() as Record<string, unknown>;
    const result = { ping_ms: Number(data.ping_ms), down_bps: Number(data.down_bps), up_bps: Number(data.up_bps) };
    if (Object.values(result).some(value => !Number.isFinite(value) || value < 0)) {
      throw new Error('Invalid Speedtest metrics');
    }
    speedtest = result;
  } catch {
    if (!stopped) console.warn('Could not read Speedtest results');
  }
  if (!stopped) speedtestTimer = setTimeout(updateSpeedtest, intervalMs, url, intervalMs);
}

function stop() {
  stopped = true;
  clearTimeout(pollTimer);
  clearTimeout(speedtestTimer);
  shutdown.abort();
  for (const client of streams.clients) client.terminate();
  streams.close();
  server.close();
}

const speedtestUrl = mock ? undefined : process.env.SPEEDTEST_URL;
const speedtestInterval = speedtestUrl ? envNumber('SPEEDTEST_INTERVAL', 300, 10) * 1000 : 0;
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
server.listen(port, host, () => {
  console.log(`Dashboard listening on ${host}:${port} (mock: ${mock})`);
  void runPoller();
  if (speedtestUrl) void updateSpeedtest(speedtestUrl, speedtestInterval);
});
