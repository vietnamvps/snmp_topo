import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { openAccounts } from '../backend/dist/accounts.js';
import { configureSecurity } from '../backend/dist/security.js';
import { deviceRoutes } from '../backend/dist/device-routes.js';
import { randomBytes } from 'node:crypto';
import { openSecrets, encryptSecret, decryptSecret } from '../backend/dist/secrets.js';
import { buildTopology } from '../backend/dist/topology.js';

const seed = `devices:
  - id: switch
    name: Switch
    ip: 192.0.2.1
    kind: switch
    snmp: v2c
    interface_map: { camera: 3 }
    community: fictional-secret-do-not-export
  - id: camera
    name: Camera
    ip: 192.0.2.2
    kind: camera
    parent_id: switch
`;

test('SQLite device seed, audit, ICMP topology and admin-only CRUD', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'noc-devices-'));
  const seedPath = join(dir, 'devices.yaml');
  process.env.DEVICES_FILE = seedPath;
  process.env.DEVICES_READ_ONLY = 'false';
  const accounts = openAccounts(join(dir, 'devices.db'));
  let server;
  try {
    await writeFile(seedPath, seed);
    accounts.devices.seed();
    await writeFile(seedPath, 'invalid YAML for later startups');
    accounts.devices.seed();
    assert.equal(accounts.db.pragma('user_version', { simple: true }), 3);
    const devices = accounts.devices.read();
    assert.equal(devices.find(device => device.id === 'switch').interface_map.camera, 3);
    const camera = devices.find(device => device.id === 'camera');
    assert.equal(camera.parent_if_index, 3);
    assert.equal(camera.monitor_mode, 'icmp');
    for (const [reachable, status] of [[true, 'online'], [false, 'offline']]) {
      const snapshot = buildTopology(devices, new Map(), new Map(), false, null, new Map(), false, new Map([['camera', reachable]]));
      assert.equal(snapshot.devices.find(device => device.id === 'camera').status, status);
    }
    assert.equal(accounts.db.prepare("SELECT count(*) AS count FROM audit_log WHERE entity='device'").get().count, 2);
    await accounts.create('admin', 'fictional-password', 'admin');
    await accounts.create('viewer', 'fictional-password', 'viewer');
    const token = name => accounts.issue(accounts.byName(name), 60000);
    const admin = token('admin');
    const viewer = token('viewer');
    const app = express();
    const security = configureSecurity(app, false, '127.0.0.1', accounts);
    const keyFile = join(dir, '.master.key');
    const secrets = openSecrets(accounts.db, keyFile);
    const community = 'test-only-' + crypto.randomUUID();
    process.env.SNMP_COMMUNITY = 'fallback-test';
    assert.equal(secrets.resolveCredentials(devices.find(device => device.id === 'switch')).community, 'fallback-test');
    let reloads = 0;
    app.use('/api/devices', deviceRoutes(accounts.devices, security, () => { reloads++; }, secrets));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const request = (path = '', method = 'GET', body, cookie = admin, type = 'application/json') =>
      fetch(base + '/api/devices' + path, { method, headers: {
        Cookie: 'dashboard_session=' + cookie, 'Content-Type': type, Origin: base, 'X-Device-Config': '1',
      }, body: type === 'application/json' && body !== undefined ? JSON.stringify(body) : body });
    assert.equal((await request('/camera', 'PATCH', { name: 'Denied' }, viewer)).status, 403);
    assert.equal((await request('/switch', 'PATCH', { parent_id: 'camera' })).status, 400);
    assert.equal((await request('/switch', 'PATCH', { community_env: 'ADMIN_PASSWORD' })).status, 400);
    assert.equal((await request('/switch', 'DELETE')).status, 400);
    const exported = await (await request('/export')).text();
    assert.doesNotMatch(exported, /fictional-secret|interface_map/);
    assert.match(exported, /parent_if_index: 3/);
    const preview = await request('/import?dryRun=true', 'POST', exported.replace('name: Camera', 'name: Updated'), admin, 'application/yaml');
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).changes[0].action, 'update');
    assert.equal(reloads, 0);
    const edited = await request('/camera', 'PATCH', { name: 'Updated' });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).devices.find(device => device.id === 'camera').parent_if_index, 3);
    assert.equal(reloads, 1);
    assert.equal((await request('/switch', 'PATCH', { community }, viewer)).status, 403);
    assert.equal((await request('/switch', 'PATCH', { community: '' })).status, 400);
    assert.equal((await request('/switch', 'PATCH', { community })).status, 200);
    const listing = await (await request()).text();
    assert.doesNotMatch(listing, new RegExp(community));
    assert.equal(JSON.parse(listing).devices.find(device => device.id === 'switch').has_community, true);
    assert.ok(!(await (await request('/export')).text()).includes(community));
    assert.ok(!JSON.stringify(accounts.db.prepare('SELECT * FROM audit_log').all()).includes(community));
    const device = devices.find(device => device.id === 'switch');
    assert.equal(secrets.resolveCredentials(device).community, community);
    secrets.rotate();
    assert.equal(openSecrets(accounts.db, keyFile).resolveCredentials(device).community, community);
    const wrongKey = openSecrets(accounts.db, keyFile, randomBytes(32).toString('base64'));
    assert.match(wrongKey.error, /fingerprint does not match/);
    assert.equal(wrongKey.resolveCredentials(device), undefined);
    const missingKey = openSecrets(accounts.db, join(dir, 'missing.key'));
    assert.match(missingKey.error, /missing/);
    assert.equal(missingKey.resolveCredentials(device), undefined);
    const unconfigured = buildTopology(devices, new Map(), new Map(), false, null, new Map(), false, new Map(), new Set(['switch']));
    assert.equal(unconfigured.devices.find(item => item.id === 'switch').status, 'unconfigured');
    assert.equal((await request('/switch', 'PATCH', { community: null })).status, 200);
    assert.equal(secrets.resolveCredentials(device).community, 'fallback-test');
    const extra = { id: 'test-v3', name: 'Test', ip: '192.0.2.3', kind: 'switch',
      snmp: 'v3', username: 'test', auth_key: community, priv_key: community };
    assert.equal((await request('', 'POST', extra)).status, 201);
    assert.equal(secrets.flags(extra.id).has_auth_key, true);
    assert.equal((await request('/' + extra.id, 'DELETE')).status, 200);
    assert.equal(accounts.db.prepare('SELECT count(*) AS count FROM device_secrets WHERE device_id=?').get(extra.id).count, 0);
    process.env.DEVICES_READ_ONLY = 'true';
    assert.equal((await request('/camera', 'DELETE')).status, 403);
    assert.equal((await request('/import?dryRun=false', 'POST', exported, admin, 'application/yaml')).status, 403);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    accounts.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('AES-GCM uses random IVs and binds device and field', () => {
  const key = randomBytes(32);
  const value = randomBytes(20).toString('base64');
  const first = encryptSecret(key, 'switch', 'community', value);
  const second = encryptSecret(key, 'switch', 'community', value);
  assert.notDeepEqual(first, second);
  assert.equal(decryptSecret(key, 'switch', 'community', first), value);
  assert.throws(() => decryptSecret(key, 'camera', 'community', first));
  assert.throws(() => decryptSecret(key, 'switch', 'auth_key', first));
});
