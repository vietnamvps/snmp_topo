import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { configureSecurity } from '../backend/dist/security.js';

const token = 't'.repeat(32);
const origin = 'http://192.168.1.20:3100';

function configure(t, dashboardOrigin, allowHttp) {
  const env = { DASHBOARD_TOKEN: token, DASHBOARD_ORIGIN: dashboardOrigin,
    ALLOW_INSECURE_LAN_HTTP: allowHttp, ALLOWED_ORIGINS: undefined };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const app = express();
  const security = configureSecurity(app, false, '0.0.0.0');
  return { app, security };
}

test('public HTTP IP and hostname are rejected even with opt-in', async t => {
  for (const host of ['8.8.8.8', 'localhost', '192.168.1.20.example.com', '[2001:4860::1]']) {
    await t.test(host, sub => assert.throws(() => configure(sub, 'http://' + host, 'true'), /private or loopback IP/));
  }
});

test('live mode defaults to HTTPS on non-loopback binds', async t => {
  await t.test('private HTTP requires explicit opt-in', sub => assert.throws(() => configure(sub, origin), /ALLOW_INSECURE_LAN_HTTP/));
  await t.test('missing origin is rejected', sub => assert.throws(() => configure(sub), /requires HTTPS/));
  await t.test('HTTPS remains accepted', sub => assert.doesNotThrow(() => configure(sub, 'https://noc.example')));
});

test('LAN HTTP permits authenticated requests with a non-Secure cookie and no HSTS', async t => {
  const { app, security } = configure(t, origin, 'true');
  assert.equal(security.originAllowed({ headers: { origin } }), true);
  assert.equal(security.originAllowed({ headers: { origin: 'http://192.168.1.21:3100' } }), false);
  app.get('/api/test', (_request, response) => response.sendStatus(204));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base + '/api/test')).status, 401);
  const response = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
    headers: { Origin: origin }, body: new URLSearchParams({ token }) });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('strict-transport-security'), null);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /; Secure/i);
  assert.equal((await fetch(base + '/api/test', { headers: { Cookie: cookie.split(';')[0] } })).status, 204);
});
