import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configureGatewayReader, parseGateways } from '../backend/dist/opnsense.js';

test('gateway API maps dpinger state and retains valid zero metrics', () => {
  assert.deepEqual(parseGateways({ status: 'ok', items: [
    { name: 'WAN', status: 'none', delay: '12.3 ms', loss: '0.0%', address: 'hidden' },
    { name: 'WAN2', status: 'none', delay: '~', loss: '~' },
    { name: 'WAN3', status: 'loss', delay: '~', loss: '12%' },
    { name: 'WAN4', status: 'force_down' },
  ] }), [
    { name: 'WAN', status: 'online', latency_ms: 12.3, loss_percent: 0 },
    { name: 'WAN2', status: 'unknown', latency_ms: null, loss_percent: null },
    { name: 'WAN3', status: 'warning', latency_ms: null, loss_percent: 12 },
    { name: 'WAN4', status: 'offline', latency_ms: null, loss_percent: null },
  ]);
  assert.throws(() => parseGateways({ status: 'failed', items: [] }));
});

test('gateway API is opt-in and requires credentials and a plain HTTPS origin', () => {
  assert.equal(configureGatewayReader({}), undefined);
  assert.throws(() => configureGatewayReader({ OPNSENSE_API_URL: 'http://firewall.example' }), /HTTPS origin/);
  assert.throws(() => configureGatewayReader({ OPNSENSE_API_URL: 'https://firewall.example' }), /credentials/);
});
