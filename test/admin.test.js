'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { startApp } = require('./helpers');
const adm = require('../src/admin');
const { toolDetail } = require('../src/xai');

const cookieOf = (r, name) => { const m = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(name + '=')); return m ? m.slice(name.length + 1) : null; };
const csrfIn = (html) => (html.match(/name="csrf" value="([^"]*)"/) || [])[1];
const post = (base, path, form, cookie, extra = {}) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}), ...extra }, body: new URLSearchParams(form).toString() });

async function requestLink(a, extraForm = {}) {
  const g = await fetch(a.base + '/admin/login'); const html = await g.text(); const c = cookieOf(g, 'pa_csrf');
  const r = await post(a.base, '/admin/login', { csrf: csrfIn(html), ...extraForm }, 'pa_csrf=' + c);
  return { r, c };
}
async function signIn(a) {
  const { r } = await requestLink(a); assert.strictEqual(r.status, 200);
  const sent = a.deps.emailFor(null).sent; const link = sent[sent.length - 1].text.match(/https?:\/\/\S+\/admin\/auth\?t=\S+/)[0];
  const g = await fetch(link.replace(/^https?:\/\/[^/]+/, a.base)); const html = await g.text(); const c = cookieOf(g, 'pa_csrf');
  const tok = new URL(link).searchParams.get('t');
  const p = await post(a.base, '/admin/auth', { csrf: csrfIn(html), t: tok }, 'pa_csrf=' + c);
  return { p, tok, sess: cookieOf(p, 'pa_admin'), csrf: c };
}

test('login link goes only to the fixed admin address, needs CSRF, rate-limited 3/15min', async () => {
  const a = await startApp();
  try {
    assert.strictEqual(a.deps.adminAuth.email, 'support@quantaxtechnology.com');
    const page = await fetch(a.base + '/admin/login'); const html = await page.text();
    assert.match(html, /Send sign-in link/);
    const sc = page.headers.getSetCookie().join(';'); assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/); assert.match(sc, /SameSite=Strict/);
    const bad = await post(a.base, '/admin/login', { csrf: 'nope-nope-nope-nope-nope' }, 'pa_csrf=' + cookieOf(page, 'pa_csrf'));
    assert.strictEqual(bad.status, 403);
    const evil = await post(a.base, '/admin/login', { csrf: csrfIn(html) }, 'pa_csrf=' + cookieOf(page, 'pa_csrf'), { origin: 'https://evil.example' });
    assert.strictEqual(evil.status, 403);
    for (let i = 0; i < 3; i++) assert.strictEqual((await requestLink(a, { email: 'attacker@evil.example', to: 'attacker@evil.example' })).r.status, 200);
    assert.strictEqual((await requestLink(a)).r.status, 429);
    const sent = a.deps.emailFor(null).sent;
    assert.strictEqual(sent.length, 3);
    for (const m of sent) { assert.strictEqual(m.to, 'support@quantaxtechnology.com'); assert.match(m.subject, /sign-in/); }
  } finally { await a.close(); }
});

test('ADMIN_LOGIN_EMAIL overrides the default recipient', () => {
  const auth = new adm.AdminAuth({ secret: 'x'.repeat(32), email: 'ops@example.com' }); assert.strictEqual(auth.email, 'ops@example.com');
  assert.strictEqual(new adm.AdminAuth({ secret: 'x' }).email, 'support@quantaxtechnology.com');
});

test('link: GET does not consume, POST does, single use, expires in 15 minutes, stored hashed', () => {
  let t = 1_000_000; const auth = new adm.AdminAuth({ secret: 's'.repeat(32), now: () => t });
  const tok = auth.issueLink();
  assert.ok(![...auth.links.keys()].includes(tok));
  assert.ok(auth.checkLink(tok)); assert.ok(auth.checkLink(tok));
  assert.ok(auth.consumeLink(tok)); assert.ok(!auth.consumeLink(tok));
  const tok2 = auth.issueLink(); t += 15 * 60 * 1000 + 1; assert.ok(!auth.checkLink(tok2)); assert.ok(!auth.consumeLink(tok2));
  const s = auth.newSession(); assert.ok(auth.session(s)); t += 12 * 3600 * 1000 + 1; assert.ok(!auth.session(s));
  assert.ok(!auth.session(auth.newSession().replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))));
});

test('sign-in flow: session cookie, dashboard, CSVs, logout', async () => {
  const a = await startApp();
  try {
    assert.strictEqual((await fetch(a.base + '/admin', { redirect: 'manual', headers: { accept: 'text/html' } })).status, 303);
    assert.strictEqual((await fetch(a.base + '/admin/newsletter.csv')).status, 401);
    const { p, tok, sess } = await signIn(a);
    assert.strictEqual(p.status, 303); assert.ok(sess);
    const sc = p.headers.getSetCookie().find((c) => c.startsWith('pa_admin='));
    assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Max-Age=43200/);
    const again = await post(a.base, '/admin/auth', { csrf: 'whatever-whatever-whatever', t: tok }, 'pa_csrf=whatever-whatever-whatever');
    assert.strictEqual(again.status, 400);
    // data
    fs.appendFileSync(a.deps.newsletterFile, JSON.stringify({ kind: 'confirmed', email: 'jo@example.com', name: 'Jo', tenant: 'rfsafe', at: '2026-10-28T10:00:00.000Z', source: 'phone', ip: '203.0.113.9', ua: 'UA1' }) + '\n' + JSON.stringify({ kind: 'confirmed', email: 'al@example.com', name: '=Al', tenant: 'rfsafe', at: '2026-09-01T10:00:00.000Z', source: 'phone' }) + '\n' + JSON.stringify({ kind: 'unsubscribed', email: 'al@example.com', tenant: 'rfsafe', at: '2026-10-01T10:00:00.000Z' }) + '\n');
    a.deps.callRecords.add({ at: '2026-10-29T13:00:00.000Z', caller: '+17275551234', seconds: 95, tools: ['kb_answer', 'send_email'], kb_queries: ['FCC limits'], emails: [{ to_masked: 'j***@e***.com', topic: 'FCC limits', ok: true }], newsletter_optin: true, summary: 'FCC limits' });
    a.deps.callRecords.add({ at: '2026-10-20T13:00:00.000Z', caller: '+18135550000', seconds: 20, tools: [], kb_queries: [], emails: [], newsletter_optin: false, summary: null });
    const ck = 'pa_admin=' + sess;
    const dash = await (await fetch(a.base + '/admin', { headers: { cookie: ck } })).text();
    assert.match(dash, /Newsletter/); assert.match(dash, /jo@example.com/); assert.match(dash, /\+17275551234/); assert.match(dash, /j\*\*\*@e\*\*\*.com: FCC limits/);
    assert.match(dash, /<b>1<\/b>confirmed \(active\)/); assert.match(dash, /<b>1<\/b>unsubscribed/); assert.match(dash, /<b>1<\/b>new, last 7 days/);
    const filtered = await (await fetch(a.base + '/admin?number=8135550000', { headers: { cookie: ck } })).text();
    assert.doesNotMatch(filtered, /7275551234/); assert.match(filtered, /8135550000/);
    const byDate = await (await fetch(a.base + '/admin/calls.csv?from=2026-10-25', { headers: { cookie: ck } })).text();
    assert.match(byDate, /^at,ended_at,tenant,caller,seconds,summary,kb_queries,tools,emails,newsletter_optin/); assert.match(byDate, /\+17275551234/); assert.doesNotMatch(byDate, /8135550000/);
    const nl = await fetch(a.base + '/admin/newsletter.csv', { headers: { cookie: ck } }); const body = await nl.text();
    assert.match(nl.headers.get('content-type'), /text\/csv/);
    assert.strictEqual(body.split('\r\n')[0], 'name,email,tenant,confirmed_at,source,consent_method,confirm_ip,user_agent,unsubscribed_at');
    assert.match(body, /Jo,jo@example.com,rfsafe,2026-10-28T10:00:00.000Z,phone,phone verbal yes \+ email double opt-in click,203.0.113.9,UA1,/);
    assert.match(body, /'=Al,al@example.com.*2026-10-01T10:00:00.000Z/); // formula-injection guard
    // bearer still works for API/CSV
    assert.strictEqual((await fetch(a.base + '/admin/newsletter.csv', { headers: { authorization: 'Bearer ' + a.deps.adminToken } })).status, 200);
    // logout needs session CSRF
    assert.strictEqual((await post(a.base, '/admin/logout', { csrf: 'x' }, ck)).status, 403);
    const csrf = csrfIn(dash); const out = await post(a.base, '/admin/logout', { csrf }, ck);
    assert.strictEqual(out.status, 303);
    assert.strictEqual((await fetch(a.base + '/admin/newsletter.csv', { headers: { cookie: ck } })).status, 401);
  } finally { await a.close(); }
});

test('call records: tool detail, record shape, retention prune', () => {
  const d1 = toolDetail('kb_answer', { question: 'What are\nnon-thermal effects?' }, { ok: true });
  assert.deepStrictEqual(d1, { tool: 'kb_answer', ok: true, q: 'What are non-thermal effects?' });
  const d2 = toolDetail('send_email', { topic: 'Non-thermal', newsletter_optin: true, summary: 'long' }, { ok: true, to_masked: 'j***@g***.com' });
  assert.deepStrictEqual(d2, { tool: 'send_email', ok: true, topic: 'Non-thermal', to_masked: 'j***@g***.com', newsletter_optin: true });
  const r = adm.callRecord({ call: 'c1', tenant: 'rfsafe', started_at: '2026-10-29T13:00:00.000Z', seconds: 61, tools: [d1, d2, { tool: 'set_email_address', ok: true }] }, '+17275551234', '2026-10-29T13:01:01.000Z');
  assert.strictEqual(r.caller, '+17275551234'); assert.strictEqual(r.seconds, 61); assert.strictEqual(r.newsletter_optin, true);
  assert.deepStrictEqual(r.tools, ['kb_answer', 'send_email', 'set_email_address']);
  assert.deepStrictEqual(r.emails, [{ to_masked: 'j***@g***.com', topic: 'Non-thermal', ok: true }]);
  assert.strictEqual(r.summary, 'What are non-thermal effects?; Non-thermal');
  const file = require('path').join(require('os').tmpdir(), 'cr-' + Date.now() + '.jsonl');
  let t = Date.parse('2026-10-29T00:00:00Z'); const cr = new adm.CallRecords({ file, now: () => t });
  cr.add({ at: '2026-01-01T00:00:00.000Z' }); cr.add({ at: '2026-10-28T00:00:00.000Z' });
  t += 2 * 86400000; cr.add({ at: '2026-10-30T00:00:00.000Z' });
  assert.deepStrictEqual(cr.read().map((x) => x.at), ['2026-10-28T00:00:00.000Z', '2026-10-30T00:00:00.000Z']);
});

test('newsletter confirm records ip and user agent; privacy mentions call logs', async () => {
  const a = await startApp();
  try {
    const tok = a.deps.newsletter.token({ email: 'z@example.com', name: 'Zed', tenant: 'rfsafe', action: 'sub', ts: Date.now() });
    const r = await fetch(a.base + '/newsletter/confirm', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.7, 10.0.0.1', 'user-agent': 'TestBrowser/1' }, body: 't=' + tok });
    assert.strictEqual(r.status, 200);
    const rec = fs.readFileSync(a.deps.newsletterFile, 'utf8').trim().split('\n').map(JSON.parse).pop();
    assert.strictEqual(rec.ip, '198.51.100.7'); assert.strictEqual(rec.ua, 'TestBrowser/1');
    const priv = await (await fetch(a.base + '/privacy')).text();
    assert.match(priv, /Call logs for quality review/); assert.match(priv, /180 days/);
  } finally { await a.close(); }
});

test('regression: real browser POST (Origin header, Sec-Fetch-*) to /admin/login sends the link and shows the countdown page', async () => {
  const a = await startApp();
  try {
    const origin = new URL(a.deps.publicBaseUrl || a.base).origin;
    const g = await fetch(a.base + '/admin/login'); const html = await g.text(); const c = cookieOf(g, 'pa_csrf');
    assert.doesNotMatch(g.headers.get('referrer-policy') || '', /^no-referrer$/);
    const browser = { origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'x-forwarded-proto': 'https', 'user-agent': 'Mozilla/5.0 Chrome/130' };
    const r = await post(a.base, '/admin/login', { csrf: csrfIn(html) }, 'pa_csrf=' + c, browser);
    assert.strictEqual(r.status, 200); const body = await r.text();
    assert.match(body, /Sign-in link sent/); assert.match(body, /support@quantaxtechnology\.com/); assert.match(body, /15:00/); assert.match(body, /id="resend" disabled/);
    const nonce = (body.match(/<script nonce="([^"]+)"/) || [])[1]; assert.ok(nonce); assert.match(r.headers.get('content-security-policy'), new RegExp(`script-src 'nonce-${nonce.replace(/[+/=]/g, '\\$&')}'`));
    // Brave / no-referrer pages send Origin: null; the CSRF token still protects it.
    const r2 = await post(a.base, '/admin/login', { csrf: csrfIn(html) }, 'pa_csrf=' + c, { ...browser, origin: 'null' });
    assert.strictEqual(r2.status, 200);
    const sent = a.deps.emailFor(null).sent; assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[0].subject, 'Your callbots.org admin sign-in link'); assert.strictEqual(sent[0].to, 'support@quantaxtechnology.com');
    // still blocked: cross-site, foreign origin, or Origin null without a valid token
    assert.strictEqual((await post(a.base, '/admin/login', { csrf: csrfIn(html) }, 'pa_csrf=' + c, { ...browser, 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.strictEqual((await post(a.base, '/admin/login', { csrf: csrfIn(html) }, 'pa_csrf=' + c, { ...browser, origin: 'https://evil.example' })).status, 403);
    assert.strictEqual((await post(a.base, '/admin/login', { csrf: 'x'.repeat(32) }, 'pa_csrf=' + c, { ...browser, origin: 'null' })).status, 403);
  } finally { await a.close(); }
});

test('admin emails are sent from RF Safe <rfsafe@callbots.org>', () => {
  assert.match(fs.readFileSync(require.resolve('../src/email'), 'utf8'), /const FROM = 'RF Safe <rfsafe@callbots\.org>'/);
});
