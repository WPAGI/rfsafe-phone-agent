'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { createFetch } = require('../src/fetch');
const { attachShutdown } = require('../src/shutdown');

test('GET retries and POST does not, unless the call is idempotent', async () => {
  let gets = 0;
  const get = createFetch({ timeoutMs: 1000, retries: 2, backoffMs: 0, fetchImpl: async () => ({ ok: ++gets >= 3, status: gets >= 3 ? 200 : 503 }) });
  assert.strictEqual((await get('https://example.test/item')).status, 200);
  assert.strictEqual(gets, 3);
  let posts = 0;
  const post = createFetch({ timeoutMs: 1000, retries: 2, backoffMs: 0, fetchImpl: async () => { posts += 1; return { ok: false, status: 500 }; } });
  assert.strictEqual((await post('https://example.test/send', { method: 'POST' })).status, 500);
  assert.strictEqual(posts, 1);
  let hangs = 0;
  const idem = createFetch({ timeoutMs: 1000, retries: 0, backoffMs: 0, fetchImpl: async () => { hangs += 1; return { ok: hangs > 1, status: hangs > 1 ? 200 : 503 }; } });
  assert.strictEqual((await idem('https://example.test/hangup', { method: 'POST', idempotent: true })).status, 200);
  assert.strictEqual(hangs, 2);
});

test('outbound calls abort when the timeout fires', async () => {
  const f = createFetch({
    timeoutMs: 30, retries: 0, backoffMs: 0,
    fetchImpl: (_url, opts) => new Promise((_resolve, reject) => { opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }),
  });
  await assert.rejects(() => f('https://example.test/slow'), /aborted/);
});

test('SIGTERM closes the server once', () => {
  const seen = [];
  let code = null;
  const server = { close(cb) { seen.push('close'); cb(); } };
  const shutdown = attachShutdown(server, (e) => seen.push(e), (c) => { code = c; });
  shutdown('SIGTERM');
  shutdown('SIGTERM');
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(seen, ['server.shutdown', 'close']);
});
