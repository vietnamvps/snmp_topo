import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trafficMotion } from '../frontend/src/traffic-motion.ts';

test('traffic particles appear on live links with any positive traffic', () => {
  assert.ok(trafficMotion('online', 5000, null));
  assert.ok(trafficMotion('warning', 0, 1));
  for (const status of ['offline', 'unknown', 'unconfigured']) {
    assert.equal(trafficMotion(status, 5000, 1000), null);
  }
  assert.equal(trafficMotion('online', null, null), null);
  assert.equal(trafficMotion('online', 0, 0), null);
});

test('particle duration decreases with traffic and stays within bounds', () => {
  assert.equal(trafficMotion('online', 1, 0).duration, 6);
  assert.ok(trafficMotion('online', 5000, 0).duration > trafficMotion('online', 975000, 0).duration);
  assert.ok(Math.abs(trafficMotion('online', 1e12, 0).duration - 0.8) < 1e-12);
});

test('particles follow dominant traffic and use the default direction near a tie', () => {
  assert.equal(trafficMotion('online', 5000, 1000).direction, 'normal');
  assert.equal(trafficMotion('online', 1000, 5000).direction, 'reverse');
  assert.equal(trafficMotion('online', 4800, 5000).direction, 'normal');
});
