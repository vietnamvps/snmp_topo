import assert from 'node:assert/strict';
import { test } from 'node:test';
import { counterRate } from '../backend/dist/snmp.js';

function sample(timestamp, receivedAt, counter, discontinuity = 0) {
  return {
    timestamp,
    counterTimestamps: { rx: new Map([['7', receivedAt]]) },
    tables: { rx: new Map([['7', counter]]), discontinuity: new Map([['7', discontinuity]]) },
  };
}

test('SNMP rates use elapsed time between counter responses, not completion of unrelated walks', () => {
  const previous = sample(1000, 100, 1000n);
  const current = sample(2100, 3100, 150001000n);
  assert.equal(counterRate(current, previous, 'rx', '7'), 400_000_000);
  assert.equal(counterRate(sample(4000, 3100, 151001000n), current, 'rx', '7'), null);
});

test('counter reset and discontinuity are discarded rather than reported as traffic spikes', () => {
  const previous = sample(1000, 100, 5000n);
  assert.equal(counterRate(sample(2000, 1100, 1n), previous, 'rx', '7'), null);
  assert.equal(counterRate(sample(2000, 1100, 8000n, 1), previous, 'rx', '7'), null);
  assert.equal(counterRate(sample(2000, 1100, 5000n), previous, 'rx', '7'), 0);
});
