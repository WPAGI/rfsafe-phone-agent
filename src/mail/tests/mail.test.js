'use strict';
// Self-contained tests for the mail viewer module (run: node --test src/mail/tests/).
const test = require('node:test'); const assert = require('node:assert'); const http = require('http');
const { createMail } = require('..'); const { MagicAuth } = require('../auth');
const { domains, recipients, merge, ReceivedMail } = require('../client'); const { sanitize, documentHtml } = require('../sanitizer'); const { mockFetch } = require('../mock');
const KEY = 're_test_SECRET_reader_key_never_shown';

async function start({ env = {}, fetchImpl, nowRef = { t: Date.parse('2026-11-14T04:00:00Z') } } = {}) {
  const sent = []; const calls = [];
  const f = fetchImpl || mockFetch(nowRef.t);
  const spy = async (url, opt) => { calls.push({ url, auth: opt && opt.headers && opt.headers.authorization }); return f(url, opt); };
  const mail = createMail({ env: { MAIL_DOMAINS: 'bestdealon.app', RESEND_MAIL_READ_KEY: KEY, MAIL_SESSION_SECRET: 'test-session-secret', ...env }, siteName: 'Site', fetchImpl: spy, now: () => nowRef.t, sendEmail: async (m) => { sent.push(m); return { ok: true }; } });
  const srv = http.createServer(async (req, res) => { if (!(await mail.route(req, res, new URL(req.url, 'http://x')))) { res.writeHead(404); res.end(); } });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  return { mail, base, sent, calls, nowRef, close: () => new Promise(r => srv.close(r)) };
}
const cookie = (r, n) => { const c = (r.headers.getSetCookie() || []).map(x => x.split(';')[0]).find(x => x.startsWith(n + '=')); return c ? c.slice(n.length + 1) : null; };
const csrfIn = (h) => (h.match(/name="csrf" value="([^"]*)"/) || [])[1];
const post = (a, p, form, ck) => fetch(a.base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ck || '' }, body: new URLSearchParams(form).toString() });
async function requestLink(a, email) { const g = await fetch(a.base + '/mail/login'); const h = await g.text(); const c = cookie(g, 'mail_csrf'); const r = await post(a, '/mail/login', { csrf: csrfIn(h), email }, 'mail_csrf=' + c); return { r, body: await r.text() }; }
async function useToken(a, tok) { const g = await fetch(a.base + '/mail/auth'); const h = await g.text(); const c = cookie(g, 'mail_csrf'); return post(a, '/mail/auth', { csrf: csrfIn(h), t: tok }, 'mail_csrf=' + c); }
const tokenOf = (m) => m.text.match(/#t=([A-Za-z0-9_-]+)/)[1];
async function signIn(a) { await requestLink(a, 'support@quantaxtechnology.com'); const p = await useToken(a, tokenOf(a.sent[a.sent.length - 1])); return 'mail_session=' + cookie(p, 'mail_session'); }

test('domain filter: exact, multi-domain, case-insensitive; spoofs and subdomains rejected; empty = nothing', () => {
  const one = domains('bestdealon.app'); const two = domains(' Bestdealon.app , othersite.example ,bad domain,');
  assert.deepStrictEqual([...two], ['bestdealon.app', 'othersite.example']);
  assert.deepStrictEqual(recipients({ to: ['Info@BESTDEALON.APP'] }, one), ['info@bestdealon.app']);
  assert.deepStrictEqual(recipients({ to: ['"Info" <info@bestdealon.app>'] }, one), ['info@bestdealon.app']);
  for (const spoof of ['info@bestdealon.app.evil.com', 'x@evil-bestdealon.app', 'x@mail.bestdealon.app', '"info@bestdealon.app" <x@evil.com>', 'bestdealon.app', 'x@bestdealon.app@evil.com', 'info@othersite.example'])
    assert.deepStrictEqual(recipients({ to: [spoof] }, one), [], spoof);
  assert.deepStrictEqual(recipients({ to: ['a@othersite.example'], cc: ['b@bestdealon.app'] }, two).sort(), ['a@othersite.example', 'b@bestdealon.app']);
  assert.deepStrictEqual(recipients({ to: ['a@bestdealon.app'] }, domains('')), []);
});

test('empty MAIL_DOMAINS shows nothing and never calls Resend', async () => {
  const a = await start({ env: { MAIL_DOMAINS: '' } });
  try { const ck = await signIn(a); const r = await (await fetch(a.base + '/mail/api/messages', { headers: { cookie: ck } })).json();
    assert.strictEqual(r.messages.length, 0); assert.strictEqual(a.calls.length, 0);
    assert.strictEqual((await fetch(a.base + '/mail/api/messages/r.demo-0001-aaaa', { headers: { cookie: ck } })).status, 404);
  } finally { await a.close(); }
});

test('both sources merged and deduped; other-domain inbox and outbound mail never shown', async () => {
  const c = new ReceivedMail({ key: KEY, allowed: 'bestdealon.app', fetchImpl: mockFetch(Date.parse('2026-11-14T04:00:00Z')) });
  const { messages, errors } = await c.list(); assert.deepStrictEqual(errors, []);
  const subj = messages.map(m => m.subject).join('|');
  assert.doesNotMatch(subj, /must never appear|Outbound must not show|other domain/i);
  assert.strictEqual(messages.filter(m => /Verify your new Northwind/.test(m.subject)).length, 1, 'deduped by Message-ID');
  assert.deepStrictEqual(messages.find(m => /Northwind/.test(m.subject)).sources.sort(), ['inbox', 'received']);
  assert.ok(messages.some(m => m.sources.join() === 'inbox'), 'inbox-only mail included');
  assert.strictEqual(messages.length, 6);
  for (let i = 1; i < messages.length; i++) assert.ok(Date.parse(messages[i - 1].created_at) >= Date.parse(messages[i].created_at), 'newest first');
  assert.strictEqual(await c.get('i.inbox-demo-other.thread-demo-9.tmail-demo-9'), null, 'other-domain inbox detail refused');
  assert.strictEqual(await c.get('i.inbox-demo-site.thread-demo-1.tmail-demo-3'), null, 'outbound refused');
  assert.strictEqual(await c.get('r.demo-0006-ffff'), null, 'received mail to other domain refused');
  assert.ok(await c.get('i.inbox-demo-site.thread-demo-1.tmail-demo-2'));
  // MAIL_INBOX_IDS pins inboxes, still filtered by the inbox address domain.
  const pinned = new ReceivedMail({ key: KEY, allowed: 'bestdealon.app', inboxIds: 'inbox-demo-other', fetchImpl: mockFetch() });
  assert.strictEqual((await pinned.allowedInboxes()).size, 0);
  // Same domain for another site: this site's mail never leaks the other way.
  const qd = await new ReceivedMail({ key: KEY, allowed: 'othersite.example', fetchImpl: mockFetch() }).list();
  assert.ok(qd.messages.every(m => m.to.every(t => t.endsWith('@othersite.example'))));
});

test('merge: dedupe by Resend id, then Message-ID, then sender+subject+minute', () => {
  const t = '2026-11-14T03:57:10.000Z';
  const out = merge([
    { id: 'r.1', resend_id: 'same', from: 'a', subject: 's', created_at: t, sources: ['received'] },
    { id: 'i.x.y.same', resend_id: 'same', from: 'zz', subject: 'other', created_at: t, sources: ['inbox'] },
    { id: 'r.2', resend_id: 'r2', message_id: '<M@x>', from: 'b', subject: 's2', created_at: t, sources: ['received'] },
    { id: 'i.2', resend_id: 'i2', message_id: 'm@X', from: 'b', subject: 's2', created_at: t, sources: ['inbox'] },
    { id: 'r.3', resend_id: 'r3', from: 'C', subject: 's3', created_at: '2026-11-14T03:50:01Z', sources: ['received'] },
    { id: 'i.3', resend_id: 'i3', from: 'c', subject: 's3', created_at: '2026-11-14T03:50:40Z', sources: ['inbox'] },
    { id: 'r.4', resend_id: 'r4', from: 'c', subject: 's3', created_at: '2026-11-14T03:52:00Z', sources: ['received'] },
  ]);
  assert.deepStrictEqual(out.map(m => m.id), ['r.1', 'r.2', 'r.4', 'r.3']);
  assert.deepStrictEqual(out[0].sources, ['received', 'inbox']);
});

test('sanitizer strips scripts, handlers, iframes, forms, styles and remote images', () => {
  const dirty = '<p onclick="x()">Hi<script>alert(1)</script><img src="https://t.example/p.gif" onerror="alert(2)"><iframe src="https://e.example"></iframe><form action="https://e.example"><input name=a></form><a href="javascript:alert(3)">j</a><a href="https://ok.example/x?a=1&b=2" onmouseover="x">ok</a><svg onload=alert(4)></svg><style>body{background:url(https://t.example/b)}</style><div style="background:url(https://t.example/c)">d</div></p>';
  const s = sanitize(dirty);
  for (const bad of [/<script/i, /onerror/i, /onclick/i, /onmouseover/i, /<img/i, /<iframe/i, /<form/i, /<input/i, /javascript:/i, /<svg/i, /<style/i, /style=/i, /t\.example/]) assert.doesNotMatch(s, bad);
  assert.match(s, /<a href="https:\/\/ok\.example\/x\?a=1&amp;b=2" target="_blank" rel="noreferrer noopener">ok<\/a>/);
  assert.match(documentHtml('<p>x</p>'), /img-src 'none'/);
  assert.strictEqual(sanitize('a < b & c'), 'a &lt; b &amp; c');
});

test('auth gate: signed-out redirect, 401 api, non-owner gets same page and no email, token single-use and expires', async () => {
  const a = await start();
  try {
    const r = await fetch(a.base + '/mail', { redirect: 'manual' }); assert.strictEqual(r.status, 303); assert.strictEqual(r.headers.get('location'), '/mail/login');
    assert.strictEqual((await fetch(a.base + '/mail/api/messages')).status, 401);
    assert.strictEqual((await fetch(a.base + '/mail/api/messages/r.demo-0001-aaaa/html')).status, 401);
    const other = await requestLink(a, 'attacker@evil.example'); assert.strictEqual(a.sent.length, 0);
    const owner = await requestLink(a, 'Support@QuantaXTechnology.com'); assert.strictEqual(a.sent.length, 1);
    assert.strictEqual(other.r.status, owner.r.status); assert.strictEqual(other.body, owner.body);
    assert.strictEqual(a.sent[0].to, 'support@quantaxtechnology.com');
    const tok = tokenOf(a.sent[0]);
    assert.strictEqual((await fetch(a.base + '/mail/auth?t=' + tok)).status, 400, 'query-string tokens are never accepted');
    const ok = await useToken(a, tok); assert.strictEqual(ok.status, 303); assert.ok(cookie(ok, 'mail_session'));
    assert.match(ok.headers.getSetCookie().join(';'), /HttpOnly; Secure; SameSite=Strict; Path=\/mail/);
    assert.strictEqual((await useToken(a, tok)).status, 400, 'single use');
    await requestLink(a, 'support@quantaxtechnology.com'); const t2 = tokenOf(a.sent[1]);
    a.nowRef.t += 15 * 60 * 1000 + 1; assert.strictEqual((await useToken(a, t2)).status, 400, 'expired after 15 minutes');
    const bad = await post(a, '/mail/login', { csrf: 'x'.repeat(30), email: 'support@quantaxtechnology.com' }, 'mail_csrf=' + 'y'.repeat(30)); assert.strictEqual(bad.status, 403);
  } finally { await a.close(); }
});

test('signed-in: no-store on every response, read-only methods, key never reaches the browser', async () => {
  const a = await start();
  try {
    const ck = await signIn(a); const bodies = [];
    const paths = ['/mail', '/mail/login', '/mail/api/messages', '/mail/api/messages?refresh=1', '/mail/api/messages/r.demo-0001-aaaa', '/mail/api/messages/r.demo-0001-aaaa/html', '/mail/api/messages/i.inbox-demo-site.thread-demo-1.tmail-demo-2', '/mail/api/messages/r.demo-0006-ffff', '/mail/nope'];
    for (const p of paths) {
      const r = await fetch(a.base + p, { headers: { cookie: ck }, redirect: 'manual' }); const b = await r.text(); bodies.push(b); assert.ok(!JSON.stringify([...r.headers]).includes(KEY));
      assert.match(r.headers.get('cache-control'), /no-store/, p); assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex, nofollow');
    }
    for (const b of bodies) assert.ok(!b.includes(KEY) && !b.includes('re_test_SECRET'), 'key leaked');
    assert.ok(a.calls.length > 0 && a.calls.every(c => c.auth === 'Bearer ' + KEY && c.url.startsWith('https://api.resend.com/')));
    const list = JSON.parse(bodies[2]); assert.strictEqual(list.messages.length, 6);
    assert.ok(list.messages.every(m => m.to.every(t => t.endsWith('@bestdealon.app'))));
    assert.ok(list.messages.every(m => /E[SD]T$/.test(m.when)), 'Eastern time');
    assert.ok(!('resend_id' in list.messages[0]) && !('message_id' in list.messages[0]));
    const one = JSON.parse(bodies[4]); assert.deepStrictEqual(one.codes, ['482915']); assert.match(one.text, /https:\/\/northwind\.example\/security/);
    const frame = bodies[5]; assert.doesNotMatch(frame, /<script|<img|tracker\.example/);
    assert.match(bodies[0], /sandbox="|setAttribute\('sandbox'/);
    assert.doesNotMatch(bodies[0], /reply|forward|delete/i);
    assert.strictEqual(JSON.parse(bodies[7]).error, 'not_found');
    for (const m of ['POST', 'DELETE', 'PUT']) assert.strictEqual((await fetch(a.base + '/mail/api/messages/r.demo-0001-aaaa', { method: m, headers: { cookie: ck } })).status, 405);
    const lo = await fetch(a.base + '/mail', { headers: { cookie: ck } }); const csrf = csrfIn(await lo.text());
    await post(a, '/mail/logout', { csrf }, ck);
    assert.strictEqual((await fetch(a.base + '/mail/api/messages', { headers: { cookie: ck } })).status, 401, 'logout revokes');
  } finally { await a.close(); }
});
