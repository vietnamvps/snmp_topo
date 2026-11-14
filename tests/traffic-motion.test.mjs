import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import * as motion from '../frontend/src/traffic-motion.ts';

test('live low traffic qualifies and stale or offline links do not', () => {
  assert.equal(motion.trafficBps('online', 5000, null), 5000);
  assert.equal(motion.trafficBps('warning', 0, 1), 1);
  for (const status of ['offline', 'unknown', 'unconfigured']) {
    assert.equal(motion.trafficBps(status, 5000, 1000), null);
  }
  assert.equal(motion.trafficBps('online', null, null), null);
});

test('traffic changes preserve phase and smoothly increase speed past hysteresis', () => {
  const state = motion.createMotion('parent:child', 5000);
  const { phase, rate, target } = state;
  motion.updateMotion(state, 5900);
  assert.equal(state.target, target);
  motion.updateMotion(state, 1e9);
  assert.equal(state.phase, phase);
  assert.equal(state.rate, rate);
  motion.advanceMotion(state, 0.1);
  assert.ok(state.rate > rate && state.rate < state.target);
  assert.equal(motion.PARTICLE_DIRECTION, 'parent-to-child');
});

test('five snapshots preserve particle DOM and phase, sharing one frame and honoring reduced motion', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const { window } = dom;
  const frames = new Map();
  let handle = 0;
  const media = new window.EventTarget();
  media.matches = false;
  window.matchMedia = () => media;
  Object.defineProperty(window.document, 'hidden', { value: false, configurable: true });
  const globals = {
    window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: callback => { frames.set(++handle, callback); return handle; },
    cancelAnimationFrame: id => frames.delete(id),
  };
  const before = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  let root;
  let act;
  try {
    const require = createRequire(new URL('../frontend/package.json', import.meta.url));
    const React = require('react');
    act = React.act;
    const { createRoot } = require('react-dom/client');
    const source = readFileSync(new URL('../frontend/src/traffic-particles.tsx', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    const exports = {};
    Function('require', 'exports', compiled)(name => name === './traffic-motion' ? motion : require(name), exports);
    const { TrafficParticles } = exports;
    const create = window.document.createElementNS.bind(window.document);
    window.document.createElementNS = (namespace, name, ...rest) => {
      const node = create(namespace, name, ...rest);
      if (name === 'path') {
        node.getTotalLength = () => 100;
        node.getPointAtLength = x => ({ x, y: 0 });
      }
      return node;
    };
    root = createRoot(window.document.getElementById('root'));
    const render = async bps => act(() => root.render(React.createElement('svg', null,
      React.createElement(TrafficParticles, { id: 'parent:child', path: 'M0 0 L100 0', bps }),
      React.createElement(TrafficParticles, { id: 'parent:other', path: 'M0 0 L100 0', bps }))));
    const groups = () => [...window.document.querySelectorAll('.traffic-particles')];
    const positions = nodes => nodes.map(group => [...group.children].map(node => node.getAttribute('transform')));
    function frame(now) {
      assert.equal(frames.size, 1);
      const [id, callback] = frames.entries().next().value;
      frames.delete(id);
      callback(now);
    }

    await render(5000);
    frame(1000);
    frame(1016);
    const initial = groups();
    const phase = positions(initial);
    for (const bps of [7100, 15000, 40000, 50000, 1000]) {
      await render(bps);
      groups().forEach((group, index) => assert.equal(group, initial[index]));
      assert.deepEqual(positions(groups()), phase);
    }
    frame(1032);
    assert.notDeepEqual(positions(groups()), phase);
    Object.defineProperty(window.document, 'hidden', { value: true, configurable: true });
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    assert.equal(frames.size, 0);
    Object.defineProperty(window.document, 'hidden', { value: false, configurable: true });
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    assert.equal(frames.size, 1);
    media.matches = true;
    media.dispatchEvent(new window.Event('change'));
    assert.equal(frames.size, 0);
    const still = positions(groups());
    await render(8000);
    assert.deepEqual(positions(groups()), still);
    assert.equal(groups().length, 2);
  } finally {
    if (root) await act(() => root.unmount());
    for (const [key, descriptor] of Object.entries(before)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    window.close();
  }
});
