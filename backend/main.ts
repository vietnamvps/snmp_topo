import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { projectRoot, type Device } from './configuration.js';
import { deviceRoutes } from './device-routes.js';
import { openSecrets } from './secrets.js';
import { probeIcmp } from './icmp.js';
import { openAccounts } from './accounts.js';
import { configureSecurity } from './security.js';
import { pollSnmp, probeSnmp, type Sample } from './snmp.js';
import { buildTopology, type Speedtest, type TrafficHistory } from './topology.js';

function envNumber(name: string, fallback: number, minimum: number) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value)) throw new Error(`Invalid ${name}`);
  return Math.max(minimum, value);
}

const accounts = openAccounts();
const secrets = openSecrets(accounts.db);
if (secrets.error) console.error(secrets.error);
accounts.devices.seed();
let devices = accounts.devices.read();
let revision = randomUUID();
const mock = (process.env.MOCK_MODE ?? 'true').trim().toLowerCase() === 'true';
const interval = envNumber('POLL_INTERVAL', 3, 0.5) * 1000;
const host = process.env.HOST || process.env.DASHBOARD_HOST || '127.0.0.1';
const port = Number(process.env.PORT || process.env.DASHBOARD_PORT || (process.env.NODE_ENV === 'production' ? 3000 : 8080));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT or DASHBOARD_PORT');

let speedtest: Speedtest | null = null;
let previous = new Map<string, Sample>();
const metadataCache = new Map<string, Pick<Sample['tables'], 'name' | 'lldp'>>();
const history: TrafficHistory = new Map();
let snapshot = buildTopology(devices, previous, previous, mock, speedtest);
let cycle = 0;
let stopped = false;
let activePoll: Promise<void> | undefined;
const activeProbes = new Set<string>();
let pollTimer: NodeJS.Timeout | undefined;
let speedtestTimer: NodeJS.Timeout | undefined;
const shutdown = new AbortController();

const app = express();
app.disable('x-powered-by');
const security = configureSecurity(app, mock, host, accounts);
await accounts.bootstrap();
if (!accounts.hasUsers()) console.warn('No accounts configured. Set ADMIN_USERNAME and ADMIN_PASSWORD or run user:create.');
accounts.prune();
const cleanupTimer = setInterval(() => accounts.prune(), 60_000).unref();
app.get('/healthz', (_request, response) => response.json({ status: 'ok' }));
app.get('/api/topology', (_request, response) => response.set('Cache-Control', 'no-store').json(snapshot));
function reloadDevices() {
  devices = accounts.devices.read();
  revision = randomUUID();
  previous.clear();
  history.clear();
  metadataCache.clear();
  publish(new Map(), false);
  void requestPoll();
}

app.post('/api/poll', async (request, response) => {
  if (request.get('X-Device-Config') !== '1') {
    response.sendStatus(403);
    return;
  }
  await requestPoll();
  response.json(snapshot);
});

app.post('/api/devices/:id/probe', async (request, response) => {
  if (request.get('X-Device-Config') !== '1') {
    response.sendStatus(403);
    return;
  }
  const device = devices.find(item => item.id === request.params.id);
  if (!device) {
    response.sendStatus(404);
    return;
  }
  if (mock) {
    response.json({ mock: true, status: snapshot.devices.find(item => item.id === device.id)?.status ?? 'unknown' });
    return;
  }
  if (!device.enabled || device.monitor_mode === 'none') {
    response.status(422).json({ error: 'Thiết bị chưa bật giám sát.' });
    return;
  }
  if (activeProbes.has(device.id) || activeProbes.size >= 8) {
    response.status(429).json({ error: 'Đang kiểm tra thiết bị. Hãy thử lại sau.' });
    return;
  }
  const credentials = device.monitor_mode === 'snmp' ? secrets.resolveCredentials(device) : undefined;
  if (device.monitor_mode === 'snmp' && !credentials) {
    response.json({ mock: false, status: 'unconfigured' });
    return;
  }
  activeProbes.add(device.id);
  try {
    const online = await (device.monitor_mode === 'icmp' ? probeIcmp(device) : probeSnmp(device, credentials!)).catch(() => false);
    response.json({ mock: false, status: online ? 'online' : 'offline' });
  } finally {
    activeProbes.delete(device.id);
  }
});

app.use('/api/devices', deviceRoutes(accounts.devices, security, reloadDevices, secrets));

app.use(express.static(resolve(projectRoot, 'frontend/dist')));
app.get(['/devices', '/users'], (_request, response) => response.sendFile(resolve(projectRoot, 'frontend/dist/index.html')));
app.use((error: { status?: number }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const status = error.status === 413 ? 413 : error.status === 400 ? 400 : 500;
  response.status(status).json({ error: 'Không xử lý được yêu cầu.' });
});

const server = createServer(app);
const streams = new WebSocketServer({ noServer: true, maxPayload: 1024 });
server.on('upgrade', (request, socket, head) => {
  const status = request.url !== '/ws/topology' ? '404 Not Found'
    : !security.originAllowed(request) ? '403 Forbidden'
    : !security.withinRateLimit('ws') ? '429 Too Many Requests'
    : !mock && !security.session(request) ? '401 Unauthorized' : null;
  if (status) {
    socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  streams.handleUpgrade(request, socket, head, client => streams.emit('connection', client, request));
});
streams.on('connection', (client, request) => {
  if (!mock) {
    const check = () => {
      const session = security.session(request);
      if (!session) {
        client.close(4401, 'Session expired');
        return;
      }
      timer = setTimeout(check, Math.min(1000, Math.max(1, session.expires_at - Date.now())));
    };
    let timer: NodeJS.Timeout;
    client.once('close', () => clearTimeout(timer));
    check();
  }
  client.on('error', () => client.terminate());
  client.send(JSON.stringify(snapshot));
});

function requestPoll() {
  if (activePoll) return activePoll;
  clearTimeout(pollTimer);
  activePoll = runPoller().finally(() => { activePoll = undefined; });
  return activePoll;
}

async function pollIcmp(devices: Device[], reachable: Map<string, boolean>) {
  const pending = devices.filter(device => device.enabled && device.monitor_mode === 'icmp');
  await Promise.all(Array.from({ length: Math.min(16, pending.length) }, async () => {
    for (let device = pending.pop(); device && !stopped; device = pending.pop()) {
      reachable.set(device.id, await probeIcmp(device).catch(() => false));
    }
  }));
}

async function runPoller() {
  const pollRevision = revision;
  const unconfigured = new Set<string>();
  const managed = mock ? [] : devices.flatMap(device => {
    if (!device.enabled || device.monitor_mode !== 'snmp') return [];
    const credentials = secrets.resolveCredentials(device);
    if (!credentials) unconfigured.add(device.id);
    return credentials ? [{ device, credentials }] : [];
  });
  const start = performance.now();
  const samples = new Map<string, Sample>();
  const reachable = new Map<string, boolean>();
  if (!mock) {
    const pings = pollIcmp(devices, reachable);
    const results = await Promise.allSettled(managed.map(({ device, credentials }) =>
      pollSnmp(device, cycle % 20 === 0 || !metadataCache.has(device.id), credentials)));
    await pings;
    if (stopped) return;
    if (pollRevision !== revision) {
      pollTimer = setTimeout(requestPoll, 0);
      return;
    }
    results.forEach((result, index) => {
      const { id } = managed[index].device;
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
  publish(samples, true, reachable, unconfigured);
  cycle += 1;
  pollTimer = setTimeout(requestPoll, Math.max(0, interval - (performance.now() - start)));
}

function publish(samples: Map<string, Sample>, record = true, reachable = new Map<string, boolean>(), unconfigured = new Set<string>()) {
  snapshot = buildTopology(devices, samples, previous, mock, speedtest, history, record, reachable, unconfigured);
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
  clearInterval(cleanupTimer);
  server.close(() => accounts.close());
}

const speedtestUrl = mock ? undefined : process.env.SPEEDTEST_URL;
const speedtestInterval = speedtestUrl ? envNumber('SPEEDTEST_INTERVAL', 300, 10) * 1000 : 0;
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
server.listen(port, host, () => {
  console.log(`Dashboard listening on ${host}:${port} (mock: ${mock})`);
  void requestPoll();
  if (speedtestUrl) void updateSpeedtest(speedtestUrl, speedtestInterval);
});
