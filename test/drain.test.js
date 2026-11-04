'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { attachShutdown } = require('../src/shutdown');
const { startApp, ENV } = require('./helpers');
const { signWebhook } = require('../src/xai');

// Fake clock + interval so drain timing is deterministic.
function rig({ calls = 0, closeNow = true, drainMs = 280000 } = {}) {
  const st = { calls, t: 0, exits: [], logs: [], fn: null, cleared: false, onDrain: 0, closeCb: null };
  const server = { close(cb) { if (closeNow) cb(); else st.closeCb = cb; } };
  const shutdown = attachShutdown(server, {
    log: (e, f) => st.logs.push({ e, ...f }), exit: (c) => st.exits.push(c), activeCalls: () => st.calls,
    onDrain: () => { st.onDrain++; }, drainMs, pollMs: 1000, now: () => st.t, signals: false,
    setInterval: (fn) => { st.fn = fn; return {}; }, clearInterval: () => { st.cleared = true; } });
  st.tick = (ms) => { for (let i = 0; i < ms / 1000 && !st.exits.length; i++) { st.t += 1000; st.fn && st.fn(); } };
  return { st, shutdown };
}

test('(a) no active calls: exits immediately', () => {
  const { st, shutdown } = rig(); shutdown('SIGTERM');
  assert.deepStrictEqual(st.exits, [0]); assert.strictEqual(st.onDrain, 1);
  assert.ok(st.logs.some((l) => l.e === 'server.drain' && l.phase === 'exit' && l.reason === 'idle'));
});

test('(b) one live call: no exit at 10 s, exits once the call ends', () => {
  const { st, shutdown } = rig({ calls: 1 }); shutdown('SIGTERM');
  st.tick(60000); assert.deepStrictEqual(st.exits, [], 'old code exited at 10 s and dropped the call');
  st.calls = 0; st.tick(1000);
  assert.deepStrictEqual(st.exits, [0]); assert.ok(st.cleared);
});

test('(c) drain cap reached: exits even with a call still up', () => {
  const { st, shutdown } = rig({ calls: 1, drainMs: 5000 }); shutdown('SIGTERM');
  st.tick(4000); assert.deepStrictEqual(st.exits, []);
  st.tick(1000); assert.deepStrictEqual(st.exits, [0]);
  assert.ok(st.logs.some((l) => l.phase === 'exit' && l.reason === 'cap' && l.active_calls === 1));
});

test('(c2) PA_DRAIN_MAX_MS env sets the cap; default is 280 s', () => {
  const old = process.env.PA_DRAIN_MAX_MS; process.env.PA_DRAIN_MAX_MS = '3000';
  try {
    const logs = []; const s = attachShutdown({ close() {} }, { log: (e, f) => logs.push(f), exit() {}, activeCalls: () => 1, signals: false, setInterval: () => ({}), clearInterval() {} });
    s('SIGTERM'); assert.strictEqual(logs.find((f) => f && f.phase === 'start').max_ms, 3000);
    delete process.env.PA_DRAIN_MAX_MS;
    const l2 = []; attachShutdown({ close() {} }, { log: (e, f) => l2.push(f), exit() {}, activeCalls: () => 1, signals: false, setInterval: () => ({}), clearInterval() {} })('SIGTERM');
    assert.strictEqual(l2.find((f) => f && f.phase === 'start').max_ms, 280000);
  } finally { if (old === undefined) delete process.env.PA_DRAIN_MAX_MS; else process.env.PA_DRAIN_MAX_MS = old; }
});

test('no calls but server.close hangs on keep-alive: exits after 10 s grace', () => {
  const { st, shutdown } = rig({ closeNow: false }); shutdown('SIGTERM');
  st.tick(9000); assert.deepStrictEqual(st.exits, []);
  st.tick(1000); assert.deepStrictEqual(st.exits, [0]);
});

test('(e) double SIGTERM is idempotent', () => {
  const { st, shutdown } = rig({ calls: 1 }); shutdown('SIGTERM'); shutdown('SIGTERM'); shutdown('SIGINT');
  assert.strictEqual(st.onDrain, 1); assert.strictEqual(st.logs.filter((l) => l.e === 'server.shutdown').length, 1);
  st.calls = 0; st.tick(1000); assert.deepStrictEqual(st.exits, [0]);
});

test('(d) while draining: /health 503 and new calls refused with 503', async () => {
  const a = await startApp(); const ts = String(Math.floor(Date.now() / 1000));
  const call = () => { const id = 'evt_' + Math.random(); const body = JSON.stringify({ id, type: 'realtime.call.incoming', data: { call_id: 'c_' + id, sip_headers: [{ name: 'From', value: '+17275550142' }, { name: 'To', value: '+17275550100' }] } }); return { id, body }; };
  const post = (c) => fetch(a.base + '/xai/webhook', { method: 'POST', body: c.body, headers: { 'webhook-id': c.id, 'webhook-timestamp': ts, 'webhook-signature': signWebhook(ENV.DEMO_XAI_WEBHOOK_SECRET, c.id, ts, c.body) } });
  try {
    assert.strictEqual((await fetch(a.base + '/health')).status, 200);
    assert.strictEqual((await post(call())).status, 200); await new Promise((r) => setTimeout(r, 20));
    const live = a.app.calls.size; assert.strictEqual(live, 1);
    a.app.startDrain(); assert.ok(a.app.isDraining());
    const h = await fetch(a.base + '/health'); const hb = await h.json();
    assert.strictEqual(h.status, 503); assert.strictEqual(hb.draining, true); assert.strictEqual(hb.active_calls, 1);
    assert.strictEqual((await post(call())).status, 503);
    assert.strictEqual(a.app.calls.size, 1, 'live call kept, new one not started');
    assert.ok(a.logs.some((l) => l.e === 'call.refused_draining'));
  } finally { for (const s of a.app.calls.values()) try { s.finish(); } catch {} await a.close(); }
});
