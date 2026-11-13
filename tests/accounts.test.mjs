import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { openAccounts } from '../backend/dist/accounts.js';
import { configureSecurity } from '../backend/dist/security.js';

test('account authentication, persistence, expiry, roles and revocation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'noc-test-'));
  const file = join(directory, 'test.db');
  const origin = 'http://127.0.0.1';
  process.env.DASHBOARD_ORIGIN = origin;
  process.env.ALLOW_INSECURE_LAN_HTTP = 'true';
  const password = 'fictional-password-123';
  let accounts = openAccounts(file);
  let server;

  async function start() {
    const app = express();
    configureSecurity(app, false, '127.0.0.1', accounts);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }

  async function stop() {
    if (server) await new Promise(resolve => server.close(resolve));
    server = undefined;
    accounts.close();
  }

  function request(path, method = 'GET', body, cookie) {
    return fetch('http://127.0.0.1:' + server.address().port + '/api/' + path, {
      method, headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  const login = (username, value = password, remember = false) =>
    request('auth/login', 'POST', { username, password: value, remember });
  const cookie = response => response.headers.get('set-cookie').split(';')[0];

  try {
    assert.ok(await accounts.create('admin', password, 'admin'));
    assert.ok(await accounts.create('viewer', password, 'viewer'));
    await start();
    const wrong = await login('admin', 'incorrect-password');
    const missing = await login('missing', 'incorrect-password');
    assert.equal(wrong.status, 401);
    assert.equal(missing.status, 401);
    assert.deepEqual(await wrong.json(), await missing.json());
    const valid = await login('admin', password, true);
    assert.equal(valid.status, 200);
    assert.match(valid.headers.get('set-cookie'), /Max-Age=2592000/);
    const admin = cookie(valid);
    const viewer = cookie(await login('viewer'));
    assert.equal((await request('users', 'GET', undefined, viewer)).status, 403);
    assert.equal((await request('users', 'GET', undefined, admin)).status, 200);
    assert.equal((await request('layout', 'PUT', { layout: { firewall: { x: 1, y: 2 } } }, admin)).status, 204);
    assert.equal((await (await request('layout', 'GET', undefined, viewer)).json()).layout, null);
    await stop();
    accounts = openAccounts(file);
    await start();
    assert.equal((await request('auth/me', 'GET', undefined, admin)).status, 200);
    assert.deepEqual((await (await request('layout', 'GET', undefined, admin)).json()).layout, { firewall: { x: 1, y: 2 } });
    accounts.db.prepare("UPDATE sessions SET expires_at=0 WHERE user_id=(SELECT id FROM users WHERE username='viewer')").run();
    assert.equal((await request('auth/me', 'GET', undefined, viewer)).status, 401);
    const another = cookie(await login('admin'));
    assert.equal((await request('auth/change-password', 'POST', {
      currentPassword: password, password: 'changed-password-123',
    }, admin)).status, 204);
    for (const old of [admin, another]) assert.equal((await request('auth/me', 'GET', undefined, old)).status, 401);
    for (let i = 0; i < 10; i++) assert.equal((await login('admin', 'incorrect-password')).status, 401);
    assert.equal((await login('admin', 'changed-password-123')).status, 429);
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
