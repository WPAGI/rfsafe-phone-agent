'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs');
const { startApp, ENV } = require('./helpers');
const US = require('../src/usagesnapshot');
const { page } = require('../src/usagepage');

const SECRET = 'fake-snapshot-secret-NOT-REAL-0001';
const BODY_MARK = 'BODYMARK_zz_should_not_be_logged';
const good = () => ({ version: 1, generated_at: '2026-11-01T11:05:00Z', services: [
  { service: 'Twilio', status: 'ok', items: [{ name: 'Calls ' + BODY_MARK, usd: 1.5, label: 'exact' }], total_usd_month_to_date: 1.5, daily: [{ date: '2026-11-01', usd: 1.5 }] },
  { service: 'Render', status: 'ok', items: [{ name: 'Pro plan', usd_month: 25, label: 'flat' }, { name: '<script>alert(1)</script>', usd_month: 25, label: 'plan' }] },
  { service: 'xAI', status: 'ok', items: [{ name: 'Tokens', usd: 0.42, label: 'estimated' }], note: '<img src=x onerror=1>' },
  { service: 'Resend', status: 'error', error: 'HTTP 500' },
] });
const cookieOf = (r, name) => { const m = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(name + '=')); return m ? m.slice(name.length + 1) : null; };
const csrfIn = (html) => (html.match(/name="csrf" value="([^"]*)"/) || [])[1];
const post = (base, p, f, cookie) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(f).toString() });
async function signIn(a) {
  const g0 = await fetch(a.base + '/admin/login'); const c0 = cookieOf(g0, 'pa_csrf');
  await post(a.base, '/admin/login', { csrf: csrfIn(await g0.text()) }, 'pa_csrf=' + c0);
  const sent = a.deps.emailFor(null).sent; const link = sent[sent.length - 1].text.match(/https?:\/\/\S+\/admin\/auth#t=\S+/)[0];
  const g = await fetch(link.replace(/^https?:\/\/[^/]+/, a.base)); const c = cookieOf(g, 'pa_csrf');
  const p = await post(a.base, '/admin/auth', { csrf: csrfIn(await g.text()), t: new URL(link).hash.slice(3) }, 'pa_csrf=' + c);
  return 'pa_admin=' + cookieOf(p, 'pa_admin');
}
const push = (a, body, auth = 'Bearer ' + SECRET, extra = {}) => fetch(a.base + '/admin/usage/snapshot', { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}), ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) });
async function withApp(secret, fn) { const a = await startApp(); a.deps.env = { ...ENV, ...(secret !== undefined ? { USAGE_SNAPSHOT_SECRET: secret } : {}) }; try { await fn(a); } finally { await a.close(); } }
const noLeak = (a, texts) => { const all = JSON.stringify(a.logs) + texts.join(''); assert.ok(!all.includes(SECRET), 'secret leaked'); assert.ok(!JSON.stringify(a.logs).includes(BODY_MARK), 'body logged'); };

test('snapshot: rejected when USAGE_SNAPSHOT_SECRET unset or empty', async () => {
  for (const s of [undefined, '']) await withApp(s, async (a) => { const r = await push(a, good()); assert.strictEqual(r.status, 503); assert.ok(!fs.existsSync(a.deps.usageSnapshotFile)); });
});
test('snapshot: wrong / missing / different-length token -> 401', async () => {
  await withApp(SECRET, async (a) => {
    for (const h of ['Bearer wrong', 'Bearer ' + SECRET + 'x', 'Bearer ' + SECRET.slice(0, -1) + '2', null, SECRET, 'Bearer demo-admin-token-EXAMPLE']) { const r = await push(a, good(), h); assert.strictEqual(r.status, 401, String(h)); }
    assert.ok(!fs.existsSync(a.deps.usageSnapshotFile)); noLeak(a, []);
  });
});
test('snapshot: right token stores atomically, no secret/body in logs or response', async () => {
  await withApp(SECRET, async (a) => {
    const r = await push(a, good()); const t = await r.text(); assert.strictEqual(r.status, 200, t);
    const j = JSON.parse(t); assert.strictEqual(j.ok, true); assert.ok(Date.parse(j.stored_at));
    const f = JSON.parse(fs.readFileSync(a.deps.usageSnapshotFile, 'utf8')); assert.strictEqual(f.services.length, 4); assert.strictEqual(f.stored_at, j.stored_at);
    const dir = require('path').dirname(a.deps.usageSnapshotFile); assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.tmp')), 'no tmp left');
    const second = good(); second.generated_at = '2026-11-02T11:05:00Z'; assert.strictEqual((await push(a, second)).status, 200);
    assert.strictEqual(JSON.parse(fs.readFileSync(a.deps.usageSnapshotFile, 'utf8')).generated_at, '2026-11-02T11:05:00Z', 'latest only');
    const lg = a.logs.filter((l) => l.e === 'admin.usage_snapshot'); assert.ok(lg.length >= 2); assert.deepStrictEqual(Object.keys(lg[0]).sort(), ['bytes', 'e', 'status']);
    noLeak(a, [t]);
  });
});
test('snapshot: oversized body -> 413 (content-length and chunked)', async () => {
  await withApp(SECRET, async (a) => {
    const big = JSON.stringify({ ...good(), pad: 'x'.repeat(300 * 1024) });
    assert.strictEqual((await push(a, big)).status, 413);
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < 30; i++) c.enqueue(new TextEncoder().encode('x'.repeat(10 * 1024))); c.close(); } });
    const r = await fetch(a.base + '/admin/usage/snapshot', { method: 'POST', headers: { authorization: 'Bearer ' + SECRET }, body: stream, duplex: 'half' });
    assert.strictEqual(r.status, 413); assert.ok(!fs.existsSync(a.deps.usageSnapshotFile)); noLeak(a, []);
  });
});
test('snapshot: bad JSON or bad shape -> 400', async () => {
  await withApp(SECRET, async (a) => {
    const bads = ['{not json', '[]', { ...good(), generated_at: 'nope' }, { ...good(), services: 'x' }, { ...good(), services: Array(31).fill({ service: 'a', status: 'ok' }) },
      { ...good(), services: [{ service: 'a', status: 'weird' }] }, { ...good(), services: [{ service: 'a', status: 'ok', items: [{ name: 'n', usd: 1, label: 'guess' }] }] },
      { ...good(), services: [{ service: 'a', status: 'ok', items: [{ name: 'n', usd: 1, usd_month: 2, label: 'exact' }] }] }, { ...good(), services: [{ service: 'a', status: 'ok', items: [{ name: 'x'.repeat(201), usd: 1, label: 'exact' }] }] },
      { ...good(), services: [{ service: 'a', status: 'ok', daily: [{ date: '11/01', usd: 1 }] }] }, { ...good(), services: [{ service: 'a', status: 'ok', items: [{ name: 'n', usd: '1', label: 'exact' }] }] }];
    for (let i = 0; i < bads.length; i += 8) await withApp(SECRET, async (b2) => { // 10/min per IP limit
      for (const b of bads.slice(i, i + 8)) { const r = await push(b2, b); assert.strictEqual(r.status, 400, JSON.stringify(b).slice(0, 80)); }
      assert.ok(!fs.existsSync(b2.deps.usageSnapshotFile)); noLeak(b2, []);
    });
  });
});
test('snapshot: rate limited per IP (429 after 10/min, even with a wrong token)', async () => {
  await withApp(SECRET, async (a) => { let last; for (let i = 0; i < 11; i++) last = await push(a, good(), 'Bearer wrong'); assert.strictEqual(last.status, 429); assert.strictEqual((await push(a, good())).status, 429); });
});
test('snapshot: GET (and other methods) not allowed', async () => {
  await withApp(SECRET, async (a) => {
    const r = await fetch(a.base + '/admin/usage/snapshot', { headers: { authorization: 'Bearer ' + SECRET } }); assert.strictEqual(r.status, 405); assert.strictEqual(r.headers.get('allow'), 'POST');
    assert.strictEqual((await fetch(a.base + '/admin/usage/snapshot', { method: 'PUT', headers: { authorization: 'Bearer ' + SECRET }, body: '{}' })).status, 405);
  });
});
test('page: renders stored snapshot with ET time, badges, escaped strings; JSON too; no secret', async () => {
  await withApp(SECRET, async (a) => {
    assert.strictEqual((await push(a, good())).status, 200);
    const sess = await signIn(a);
    const html = await (await fetch(a.base + '/admin/usage', { headers: { cookie: sess } })).text();
    assert.match(html, /Updated at Nov 1, 2026, 6:05 AM ET/);
    assert.ok(!html.includes('<script>alert(1)</script>') && html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('<img src=x') && html.includes('&lt;img src=x onerror=1&gt;'));
    for (const k of ['b-exact', 'b-estimated', 'b-plan']) assert.ok(html.includes(k), k);
    assert.match(html, /Unavailable: HTTP 500/);
    const js = JSON.parse(await (await fetch(a.base + '/admin/usage.json', { headers: { cookie: sess } })).text());
    assert.strictEqual(js.source, 'snapshot'); assert.strictEqual(js.mtd, 1.5 + 50 + 0.42);
    noLeak(a, [html, JSON.stringify(js)]);
  });
});
test('page: falls back to live fetch with no snapshot or an unreadable one', async () => {
  await withApp(SECRET, async (a) => {
    const sess = await signIn(a);
    let html = await (await fetch(a.base + '/admin/usage', { headers: { cookie: sess } })).text();
    assert.ok(!/Updated at .* ET/.test(html)); assert.match(html, /refreshed at most every/);
    fs.writeFileSync(a.deps.usageSnapshotFile, '{broken');
    html = await (await fetch(a.base + '/admin/usage', { headers: { cookie: sess } })).text();
    assert.ok(!/Updated at .* ET/.test(html)); assert.match(html, /refreshed at most every/);
  });
});
test('unit: bearerOk constant-time, length-safe; toEt formats America/New_York', () => {
  assert.ok(US.bearerOk('Bearer abc', 'abc')); assert.ok(!US.bearerOk('Bearer abcd', 'abc')); assert.ok(!US.bearerOk('Bearer abc', '')); assert.ok(!US.bearerOk('abc', 'abc')); assert.ok(!US.bearerOk(undefined, 'abc'));
  assert.strictEqual(US.toEt('2026-07-01T16:30:00Z'), 'Jul 1, 2026, 12:30 PM ET');
  const html = page({ snap: US.toPageSnap(US.validate(good()).value, Date.parse('2026-11-01T12:00:00Z')), nonce: 'n' }); assert.match(html, /Updated at/);
});
