'use strict';
const test = require('node:test'); const assert = require('node:assert');
const path = require('path'); const fs = require('fs'); const os = require('os');
const { UsageService, TokenCounter, SimpleLimiter, tokenCost, PRICING } = require('../src/usage');
const { page } = require('../src/usagepage');
const { startApp } = require('./helpers');

const SID = 'ACtest' + 'X'.repeat(28); const TOK = 'twtok_test_SECRET_9f8e7d6c5b4a';
const FAKE = { TWILIO_ACCOUNT_SID: SID, RFSAFE_TWILIO_AUTH_TOKEN: TOK, XAI_API_KEY: 'xai-test-SECRET-abcdefghijklmnop', RESEND_API_KEY: 're_test_SECRET_abcdefghijkl', RENDER_API_KEY: 'rnd_test_SECRET_abcdefghijkl', RFSAFE_SHOPIFY_STOREFRONT_TOKEN: 'sk_test_SECRET_shopify123456' };
const SECRETS = [TOK, FAKE.XAI_API_KEY, FAKE.RESEND_API_KEY, FAKE.RENDER_API_KEY, FAKE.RFSAFE_SHOPIFY_STOREFRONT_TOKEN, Buffer.from(SID + ':' + TOK).toString('base64')];
const NOW = Date.parse('2026-11-01T12:00:00Z');
const ok = (j) => ({ ok: true, status: 200, json: async () => j });
function stubFetch({ fail = {}, calls = [] } = {}) {
  return async (url, o) => {
    calls.push({ url, auth: o?.headers?.authorization });
    if (url.includes('twilio.com')) {
      if (fail.twilio) return { ok: false, status: fail.twilio, json: async () => ({ message: 'bad token ' + TOK }) };
      if (url.includes('/Daily.json')) return ok({ usage_records: [{ category: 'totalprice', start_date: '2026-10-31', price: '1.25' }, { category: 'totalprice', start_date: '2026-11-01', price: '0.40' }] });
      const p = url.includes('/LastMonth') ? 30 : url.includes('/Today') ? 0.4 : 0.4;
      return ok({ usage_records: [{ category: 'totalprice', price: String(p) }, { category: 'calls', count: '3', usage: '12', price: '0.30' }, { category: 'sms', count: '5', price: '0.10' }] });
    }
    if (url.includes('api.render.com')) { if (fail.render) throw new Error('ECONNRESET ' + FAKE.RENDER_API_KEY); return ok([{ service: { name: 'rfsafe-phone-agent', type: 'web_service', serviceDetails: { plan: 'starter' } } }]); }
    throw new Error('unexpected ' + url);
  };
}
function svc(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-')); const logs = [];
  const tokens = new TokenCounter({ file: path.join(dir, 't.json'), now: () => NOW });
  const callRecords = { read: () => [{ at: '2026-11-01T10:00:00Z', seconds: 300 }, { at: '2026-10-15T10:00:00Z', seconds: 600 }] };
  const sentMessages = { read: () => [{ channel: 'email', status: 'sent', at: '2026-11-01T09:00:00Z' }, { channel: 'email', status: 'failed', at: '2026-11-01T09:00:00Z' }, { channel: 'sms', status: 'sent', at: '2026-11-01T09:00:00Z' }] };
  const calls = []; let t = NOW;
  const s = new UsageService({ env: FAKE, fetchImpl: stubFetch({ calls, ...over }), now: () => t, tokens, callRecords, sentMessages, log: (e, f) => logs.push(JSON.stringify({ e, ...f })), ...over.opts });
  return { s, tokens, logs, calls, adv: (ms) => { t += ms; }, dir };
}
const by = (snap, id) => snap.services.find((x) => x.id === id);

test('estimate math: grok-4.7 tokens x published price; voice minutes x $0.08', async () => {
  assert.strictEqual(tokenCost({ in: 1e6, cached: 1e6, out: 1e6 }, 'grok-4.7'), 2 + 0.5 + 6);
  const m = svc(); m.tokens.add('grok-4.7', { prompt_tokens: 1500000, prompt_tokens_details: { cached_tokens: 500000 }, completion_tokens: 100000 });
  const snap = await m.s.snapshot(); const x = by(snap, 'xai_text');
  assert.strictEqual(x.kind, 'estimated'); assert.strictEqual(x.mtd, Math.round((1 * 2 + 0.5 * 0.5 + 0.1 * 6) * 100) / 100);
  const v = by(snap, 'xai_voice'); assert.strictEqual(v.mtd, 0.4); assert.strictEqual(v.last, 0.8); assert.strictEqual(PRICING.xai.voice_per_min, 0.08);
  const tw = by(snap, 'twilio'); assert.strictEqual(tw.kind, 'exact'); assert.strictEqual(tw.mtd, 0.4); assert.strictEqual(tw.last, 30); assert.ok(tw.figures.every((f) => f.kind === 'exact'));
  assert.strictEqual(by(snap, 'render').kind, 'plan'); assert.strictEqual(by(snap, 'render').mtd, 7.25);
  const re = by(snap, 'resend'); assert.strictEqual(re.figures.find((f) => f.label === 'Emails sent this month').value, 1);
  assert.ok(snap.services.every((s) => s.updated)); assert.strictEqual(snap.mtd, Math.round((0.4 + 0.4 + x.mtd + 0 + 7.25 + 0) * 100) / 100);
  assert.ok(JSON.parse(fs.readFileSync(path.join(m.dir, 't.json'), 'utf8'))['2026-11-01']['grok-4.7'].req === 1, 'counters persisted');
});
test('cache: second snapshot within TTL makes no provider calls; refetches after TTL', async () => {
  const m = svc(); await m.s.snapshot(); const n = m.calls.length; assert.ok(n >= 5);
  m.adv(10 * 60000); await m.s.snapshot(); assert.strictEqual(m.calls.length, n);
  m.adv(3 * 60000); await m.s.snapshot(); assert.ok(m.calls.length > n);
});
test('per-service error isolation; provider error bodies and keys are never surfaced or logged', async () => {
  const m = svc({ fail: { twilio: 401, render: true } }); const snap = await m.s.snapshot();
  assert.strictEqual(by(snap, 'twilio').status, 'error'); assert.match(by(snap, 'twilio').error, /HTTP 401/);
  assert.strictEqual(by(snap, 'render').status, 'error'); assert.strictEqual(by(snap, 'xai_voice').status, 'ok'); assert.strictEqual(by(snap, 'resend').status, 'ok');
  const out = JSON.stringify(snap) + page({ snap, nonce: 'n' }) + m.logs.join('\n');
  for (const s of SECRETS) assert.ok(!out.includes(s), 'leaked ' + s.slice(0, 6)); assert.ok(!/bad token|ECONNRESET/.test(out));
});
test('not connected shows the env var name needed', async () => {
  const s = new UsageService({ env: {}, fetchImpl: async () => { throw new Error('no'); }, now: () => NOW });
  const snap = await s.snapshot(); const html = page({ snap, nonce: 'n' });
  for (const id of ['twilio', 'xai_text', 'xai_voice', 'resend', 'render', 'shopify']) assert.strictEqual(by(snap, id).status, 'not_connected', id);
  assert.deepStrictEqual(by(snap, 'render').needs, ['RENDER_API_KEY']); assert.ok(by(snap, 'render').figures.some((f) => f.value === 'starter'), 'falls back to render.yaml plan');
  assert.match(html, /Not connected — needs <code>RENDER_API_KEY<\/code>/); assert.match(html, /XAI_API_KEY/); assert.match(html, /RESEND_API_KEY/);
});
test('rate limiter: per key sliding window', () => {
  let t = 0; const l = new SimpleLimiter({ max: 2, windowMs: 1000, now: () => t });
  assert.ok(l.allow('a')); assert.ok(l.allow('a')); assert.ok(!l.allow('a')); assert.ok(l.allow('b')); t = 1001; assert.ok(l.allow('a'));
});

// ---- HTTP ----
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
test('HTTP: session-only, GET-only, nonce CSP, nav link, no secrets in HTML/JSON/logs, rate limited', async () => {
  const a = await startApp();
  try {
    const m = svc(); a.deps.usage = m.s; m.s.log = (e, f) => a.logs.push({ e, ...f });
    assert.strictEqual((await fetch(a.base + '/admin/usage.json')).status, 401);
    assert.strictEqual((await fetch(a.base + '/admin/usage', { redirect: 'manual', headers: { accept: 'text/html' } })).status, 303);
    assert.strictEqual((await fetch(a.base + '/admin/usage.json', { headers: { authorization: 'Bearer demo-admin-token-EXAMPLE' } })).status, 401, 'no Bearer access');
    const sess = await signIn(a);
    assert.match(await (await fetch(a.base + '/admin', { headers: { cookie: sess } })).text(), /href="\/admin\/usage"/);
    assert.strictEqual((await fetch(a.base + '/admin/usage', { method: 'POST', headers: { cookie: sess } })).status, 405);
    const pg = await fetch(a.base + '/admin/usage', { headers: { cookie: sess } }); const html = await pg.text();
    assert.strictEqual(pg.status, 200); assert.match(pg.headers.get('content-security-policy'), /script-src 'nonce-/); assert.match(html, /Usage &amp; costs/); assert.match(html, /<svg/); assert.match(html, /b-exact/);
    const js = await (await fetch(a.base + '/admin/usage.json', { headers: { cookie: sess } })).text(); JSON.parse(js);
    const all = html + js + JSON.stringify(a.logs);
    for (const s of SECRETS) assert.ok(!all.includes(s), 'leaked ' + s.slice(0, 6));
    let last; for (let i = 0; i < 30; i++) last = await fetch(a.base + '/admin/usage.json', { headers: { cookie: sess } });
    assert.strictEqual(last.status, 429);
  } finally { await a.close(); }
});
test('XaiTextBrain reports token usage to the counter', async () => {
  const { XaiTextBrain } = require('../src/sms'); const seen = [];
  const b = new XaiTextBrain({ apiKey: 'k', onUsage: (m, u) => seen.push([m, u.prompt_tokens]), fetchImpl: async () => ok({ usage: { prompt_tokens: 10, completion_tokens: 2 }, choices: [{ message: { content: 'hi' } }] }) });
  assert.strictEqual(await b.reply({ tools: { definitions: () => [] }, text: 'x', instructions: 'i' }), 'hi'); assert.deepStrictEqual(seen, [['grok-4.7', 10]]);
});
