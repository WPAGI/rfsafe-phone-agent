'use strict';
// Unified admin (John, Nov 16, 2026, 9:13-9:22 PM ET): one home behind one magic-link sign-in, separate pages in the
// Mailbox look, every feature of the old one-page admin and the Subscribers page kept. Each test names the
// FEATURE_PARITY.md ids it checks; the last test fails if an id in FEATURE_PARITY.md has no test here.
// Demo/mock mode only: the sign-in email goes to the in-memory mock sender, never a real inbox.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path'); const os = require('os'); const http = require('http'); const crypto = require('crypto');
const { startApp, ENV } = require('./helpers');
const UI = require('../src/adminui');

const cookieOf = (r, name) => { const m = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(name + '=')); return m ? m.slice(name.length + 1) : null; };
const setCookie = (r, name) => (r.headers.getSetCookie?.() || []).filter((c) => c.startsWith(name + '='));
const csrfIn = (html) => (html.match(/name="csrf" value="([^"]*)"/) || [])[1];
const post = (base, p, form, cookie, extra = {}) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}), ...extra }, body: new URLSearchParams(form).toString() });
const unesc = (s) => s.replace(/&#39;|&amp;|&quot;/g, (x) => ({ '&#39;': "'", '&amp;': '&', '&quot;': '"' }[x]));

// Sign in with the mocked sender. loginQs (e.g. '?next=kb') is the page the owner came from.
async function signIn(a, loginQs = '', forcedNext = null) {
  const g = await fetch(a.base + '/admin/login' + loginQs); const html = await g.text();
  const csrf = cookieOf(g, 'pa_csrf'); const next = forcedNext || cookieOf(g, 'pa_next');
  const jar = 'pa_csrf=' + csrf + (next ? '; pa_next=' + next : '');
  const r = await post(a.base, '/admin/login', { csrf: csrfIn(html) }, jar); assert.strictEqual(r.status, 200);
  const sent = a.deps.emailFor(null).sent; const link = sent[sent.length - 1].text.match(/https?:\/\/\S+\/admin\/auth#t=\S+/)[0];
  const g2 = await fetch(link.replace(/^https?:\/\/[^/]+/, a.base)); const h2 = await g2.text(); const c2 = cookieOf(g2, 'pa_csrf');
  const p = await post(a.base, '/admin/auth', { csrf: csrfIn(h2), t: new URL(link).hash.slice(3) }, 'pa_csrf=' + c2 + (next ? '; pa_next=' + next : ''));
  assert.strictEqual(p.status, 303);
  const sess = cookieOf(p, 'pa_admin'); return { p, sess, cookie: 'pa_admin=' + sess, location: p.headers.get('location'), next };
}
const page = async (a, p, cookie) => { const r = await fetch(a.base + p, { headers: { cookie, accept: 'text/html' }, redirect: 'manual' }); return { r, html: await r.text() }; };

async function startSitemail(extra = {}) {
  const { buildDeps } = require('../src/runtime'); const { createApp } = require('../src/app');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ua-'));
  const env = { ...ENV, SITEMAIL_MOCK: '1', SITEMAIL_KB_WRITE_HASH: crypto.createHash('sha256').update('ua-kb-key-0123456789').digest('hex'), SITEMAIL_ENC_KEY: crypto.randomBytes(32).toString('base64'), SITEMAIL_SESSION_SECRET: crypto.randomBytes(24).toString('base64'), MAIL_DOMAINS: 'callbots.org', RESEND_MAIL_READ_KEY: 're_test_host_reader', ...extra };
  const deps = buildDeps({ mode: 'demo', env, tenantsDir: path.join(__dirname, '../demo/tenants'), dataDir, log: () => {} });
  deps.tenants.save = () => {}; deps.mailFetch = require('../src/mail/mock').mockFetch();
  const app = createApp(deps); const srv = http.createServer(app.handler); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port; deps.publicBaseUrl = base;
  return { deps, base, close: () => new Promise((r) => srv.close(r)) };
}

test('F01-F08: sign-in, session, Bearer fallback, signed-out redirects', async () => {
  const a = await startApp();
  try {
    // F08 every admin HTML page sends a signed-out browser to the sign-in page; scripts get 401
    for (const p of ['/admin', '/admin/calls', '/admin/newsletter', '/admin/channels', '/admin/messages?type=sms', '/admin/subscribers', '/admin/outbound', '/admin/owner-feedback', '/admin/usage', '/admin/mail', '/admin/go/inbox', '/admin/go/kb']) {
      const r = await fetch(a.base + p, { redirect: 'manual', headers: { accept: 'text/html' } });
      assert.strictEqual(r.status, 303, p); assert.match(r.headers.get('location'), /^\/admin\/login(\?next=(inbox|kb))?$/, p);
    }
    for (const p of ['/admin/calls', '/admin/newsletter', '/admin/channels', '/admin/newsletter.csv', '/admin/calls.csv', '/admin/kb-gaps.csv', '/admin/messages.csv?type=sms']) assert.strictEqual((await fetch(a.base + p, { redirect: 'manual' })).status, 401, p);
    // F01 sign-in page, F02 link goes to the fixed address via the mocked sender, F03 sent page with countdown + resend
    const g = await fetch(a.base + '/admin/login'); const lh = await g.text();
    assert.match(lh, /Send sign-in link/); assert.match(lh, /One sign-in opens the whole admin/); assert.ok(cookieOf(g, 'pa_csrf'));
    assert.match(setCookie(g, 'pa_csrf')[0], /HttpOnly; Secure; SameSite=Strict; Path=\/admin/);
    const r = await post(a.base, '/admin/login', { csrf: csrfIn(lh) }, 'pa_csrf=' + cookieOf(g, 'pa_csrf')); const sh = await r.text();
    assert.strictEqual(r.status, 200); assert.match(sh, /Sign-in link sent/); assert.match(sh, /id="resend" disabled/); assert.match(sh, /id="ttl">15:00/);
    const sent = a.deps.emailFor(null).sent; assert.strictEqual(sent.at(-1).to, 'support@quantaxtechnology.com'); assert.match(sent.at(-1).text, /\/admin\/auth#t=/);
    // F04 fragment token page, session cookie flags; F05 legacy ?t= refused
    const ap = await fetch(a.base + '/admin/auth'); assert.strictEqual(ap.status, 200); assert.match(ap.headers.get('content-security-policy'), /nonce-/);
    assert.strictEqual((await fetch(a.base + '/admin/auth?t=abc')).status, 400);
    const s = await signIn(a); assert.strictEqual(s.location, '/admin');
    assert.match(setCookie(s.p, 'pa_admin')[0], /HttpOnly; Secure; SameSite=Strict; Path=\/admin; Max-Age=43200/);
    // F28 sign out sits in the top bar of every page; F06 logout needs the session CSRF, revokes, clears Mailbox cookies too
    const home = await page(a, '/admin', s.cookie); const csrf = csrfIn(home.html);
    assert.match(home.html, /<header class="top glass">[\s\S]*action="\/admin\/logout"[\s\S]*Sign out[\s\S]*<\/header>/);
    for (const p of ['/admin/calls', '/admin/newsletter', '/admin/channels', '/admin/subscribers', '/admin/messages?type=sms', '/admin/outbound', '/admin/owner-feedback']) assert.match((await page(a, p, s.cookie)).html, /action="\/admin\/logout"/, p);
    assert.strictEqual((await post(a.base, '/admin/logout', { csrf: 'nope' }, s.cookie)).status, 403);
    assert.strictEqual((await fetch(a.base + '/admin/logout', { redirect: 'manual', headers: { cookie: s.cookie } })).status, 405);
    const out = await post(a.base, '/admin/logout', { csrf }, s.cookie); assert.strictEqual(out.status, 303); assert.strictEqual(out.headers.get('location'), '/admin/login');
    const cleared = out.headers.getSetCookie().join('\n'); assert.match(cleared, /pa_admin=; [^\n]*Max-Age=0/); assert.match(cleared, /mail_session=; [^\n]*Path=\/mail; Max-Age=0/);
    assert.strictEqual((await page(a, '/admin', s.cookie)).r.status, 303);
    // F07 Bearer admin token: JSON status on /admin, data pages + CSVs still open for scripts
    const B = { authorization: 'Bearer ' + a.deps.adminToken };
    const st = await fetch(a.base + '/admin', { headers: B }); assert.strictEqual(st.status, 200); assert.match(st.headers.get('content-type'), /json/);
    for (const p of ['/admin/newsletter.csv', '/admin/calls.csv', '/admin/kb-gaps.csv', '/admin/calls', '/admin/newsletter', '/admin/channels', '/admin/messages?type=sms', '/admin/messages.csv?type=email']) assert.strictEqual((await fetch(a.base + p, { headers: B })).status, 200, p);
    assert.strictEqual((await fetch(a.base + '/admin/newsletter.csv', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  } finally { await a.close(); }
});

test('N01-N03, F10, F22, F30 links: home tiles by section, left nav on every page, scrollable top menu on small screens', async () => {
  const a = await startApp();
  try {
    const s = await signIn(a); const { html } = await page(a, '/admin', s.cookie);
    // N01 tiles grouped by section; every tool of the old page is a tile (F10, F22, F30 links)
    const sections = [...html.matchAll(/<section><h2>([^<]+)<\/h2>/g)].map((m) => m[1]);
    assert.deepStrictEqual(sections, ['Callbots', 'People', 'Mailbox', 'Downloads']);
    for (const [href, label] of [['/admin/calls', 'Call log'], ['/admin/channels', 'Texting &amp; email'], ['/admin/messages?type=sms', 'Review texts'], ['/admin/messages?type=email', 'Review emails'], ['/admin/outbound', 'Outbound &amp; owner briefing'], ['/admin/owner-feedback', 'Owner feedback'], ['/admin/usage', 'Usage &amp; costs'], ['/admin/subscribers', 'Subscribers'], ['/admin/newsletter', 'Newsletter'], ['/admin/mail', 'Mail viewer'], ['/admin/calls.csv', 'Calls (CSV)'], ['/admin/newsletter.csv', 'Newsletter (CSV)'], ['/admin/kb-gaps.csv', 'Unanswered questions (CSV)'], ['/admin/messages.csv?type=sms', 'Sent texts (CSV)'], ['/admin/messages.csv?type=email', 'Sent emails (CSV)']]) {
      assert.match(html, new RegExp(`<a class="tile" href="${href.replace(/[?.]/g, '\\$&')}"><svg[^]*?<span>${label.replace(/[()]/g, '\\$&')}</span></a>`), href);
    }
    for (const [href, label] of [['/admin/go/inbox', 'Mailbox'], ['/admin/go/kb', 'Brain box']]) assert.match(html, new RegExp(`<a class="tile" href="${href}"><svg[^]*?<span>${label}</span></a>`), href); // N04 (package on in the test app)
    assert.match(UI.ADMIN_CSS, /\.tile\{width:128px;height:128px/); // N01 about 100-150px
    // N02 left nav on every admin page, with the current page marked; no Mailbox folder column outside the Mailbox
    for (const [p, id] of [['/admin', 'Home'], ['/admin/calls', 'Call log'], ['/admin/newsletter', 'Newsletter'], ['/admin/channels', 'Texting &amp; email'], ['/admin/subscribers', 'Subscribers'], ['/admin/messages?type=sms', 'Review texts'], ['/admin/messages?type=email', 'Review emails'], ['/admin/outbound', 'Outbound &amp; owner briefing'], ['/admin/owner-feedback', 'Owner feedback']]) {
      const h = (await page(a, p, s.cookie)).html;
      assert.match(h, /<div class="app wide"><nav class="nav glass" aria-label="Admin">/, p);
      assert.match(h, new RegExp(`class="nb on" href="[^"]*" aria-current="page"><svg[^]*?<span>${id}</span>`), p);
      assert.doesNotMatch(h, /data-f="inbox"|id="n-inbox"/, p);
      assert.match(h, /--bg:#070b16/, p); // Mailbox colors
    }
    // N03 small screens: the Mailbox's own @media (max-width:980px) rules turn the side nav into a scrollable top menu. No hamburger.
    assert.match(html, /@media \(max-width:980px\)\{\.app\.wide\{grid-template-columns:minmax\(0,1fr\)\}[^}]*\}\.nav\{flex-direction:row;overflow-x:auto/);
    assert.ok(html.includes(require('../vendor/sitemail/src/mailbox/views').CSS2), 'reuses the Mailbox CSS as is');
    assert.doesNotMatch(html, /hamburger|aria-expanded|menu-toggle/i);
    assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
    // pages carry no script (default CSP) except where they always had a nonce'd one
    assert.match((await page(a, '/admin', s.cookie)).r.headers.get('content-security-policy'), /default-src 'none'/);
    assert.doesNotMatch(html, /<script/);
  } finally { await a.close(); }
});

test('F11-F17: Texting & email page keeps every switch, warning, error banner and change log', async () => {
  const a = await startApp();
  try {
    const s = await signIn(a); const t = a.deps.tenants.get('rfsafe-demo'); t.sms_enabled = false; t.email_enabled = false; t.approval_mode = true; t.instant_link_reply = false;
    let { html } = await page(a, '/admin/channels', s.cookie); const csrf = csrfIn(html);
    assert.match(html, /<h1>Texting and email<\/h1>/);
    assert.match(html, /data-ch="sms">OFF/); assert.match(html, /Turn texting on/); // F11
    assert.match(html, /data-ch="email">OFF/); assert.match(html, /Turn email on/); // F12
    assert.match(html, /data-ch="instant">HOLD FOR REVIEW/); assert.match(html, /Send texts instantly/); // F13
    assert.match(html, /texting and email are both off, so callers cannot receive links/); // F14
    assert.match(html, /Texts only ever go to the number the caller is calling from/); // F17
    assert.match(html, /No changes yet\./); // F16 empty log
    let r = await post(a.base, '/admin/channels', { csrf, tenant: 'rfsafe-demo', channel: 'email', enabled: 'on' }, s.cookie);
    assert.strictEqual(r.status, 303); assert.strictEqual(r.headers.get('location'), '/admin/channels'); assert.strictEqual(t.email_enabled, true);
    r = await post(a.base, '/admin/channels', { csrf, tenant: 'rfsafe-demo', channel: 'instant', enabled: 'on' }, s.cookie); assert.strictEqual(t.instant_link_reply, true);
    r = await post(a.base, '/admin/channels', { csrf, tenant: 'nope', channel: 'email', enabled: 'on' }, s.cookie);
    assert.match(r.headers.get('location'), /^\/admin\/channels\?err=/); // F15
    html = (await page(a, r.headers.get('location'), s.cookie)).html;
    assert.match(html, /Could not change setting:<\/strong> Unknown line or setting/);
    assert.match(html, /<td>Email<\/td><td>on<\/td><td>done<\/td>/); assert.match(html, /Texts: send instantly<\/td><td>on<\/td>/); // F16
    // the old /admin?err= link still lands on the error banner
    const old = await fetch(a.base + '/admin?err=' + encodeURIComponent('Old link'), { redirect: 'manual', headers: { cookie: s.cookie } });
    assert.strictEqual(old.status, 303); assert.strictEqual(old.headers.get('location'), '/admin/channels?err=Old%20link');
    assert.strictEqual((await post(a.base, '/admin/channels', { csrf: 'bad', tenant: 'rfsafe-demo', channel: 'email', enabled: 'off' }, s.cookie)).status, 403);
    assert.strictEqual((await post(a.base, '/admin/channels', { csrf, tenant: 'rfsafe-demo', channel: 'email', enabled: 'off' })).status, 403);
    assert.strictEqual((await fetch(a.base + '/admin/channels', { method: 'PUT', headers: { cookie: s.cookie } })).status, 405);
  } finally { await a.close(); }
});

test('F18-F21, F23-F27: Newsletter and Call log pages keep counters, tables, filters and downloads', async () => {
  const a = await startApp();
  try {
    const s = await signIn(a);
    fs.appendFileSync(a.deps.newsletterFile, JSON.stringify({ kind: 'confirmed', email: 'pat@example.com', name: 'Pat Mock', tenant: 'rfsafe', at: '2026-10-28T10:00:00.000Z', source: 'phone', ip: '203.0.113.9', ua: 'UA1' }) + '\n' + JSON.stringify({ kind: 'confirmed', email: 'sam@example.com', name: '=Sam', tenant: 'rfsafe', at: '2026-09-01T10:00:00.000Z', source: 'phone' }) + '\n' + JSON.stringify({ kind: 'unsubscribed', email: 'sam@example.com', tenant: 'rfsafe', at: '2026-10-01T10:00:00.000Z' }) + '\n');
    a.deps.callRecords.add({ at: '2026-10-29T13:00:00.000Z', caller: '+17275550100', seconds: 95, tools: ['kb_answer', 'send_email'], kb_queries: ['FCC limits'], emails: [{ to_masked: 'p***@e***.com', topic: 'FCC limits', ok: true }, { to_masked: 'x***@e***.com', topic: null, ok: false }], newsletter_optin: true, summary: 'FCC limits' });
    a.deps.callRecords.add({ at: '2026-10-20T13:00:00.000Z', caller: null, seconds: 20, tools: [], kb_queries: [], emails: [], newsletter_optin: false, summary: null });
    let { html } = await page(a, '/admin/newsletter', s.cookie);
    for (const k of ['email confirmed (active)', 'email unsubscribed', 'news texts confirmed', 'news texts awaiting YES', 'news texts stopped', 'new, last 7 days', 'new, last 30 days']) assert.match(html, new RegExp(`<span class="k"><b>\\d+</b>${k.replace(/[()]/g, '\\$&')}</span>`), k); // F18
    assert.match(html, /<b>1<\/b>email confirmed \(active\)/); assert.match(html, /<b>1<\/b>email unsubscribed/);
    assert.match(html, /href="\/admin\/subscribers"><b>Manage subscribers<\/b><\/a> \(search, edit, unsubscribe, merge, delete\)/); // F19
    assert.match(html, /href="\/admin\/newsletter.csv">Download CSV/); // F20
    assert.match(html, /<th>Name<\/th><th>Email<\/th><th>Tenant<\/th><th>Confirmed \(UTC\)<\/th><th>Source<\/th><th>Confirm IP<\/th><th>Unsubscribed<\/th><th>Phone<\/th><th>Email<\/th><th>News texts<\/th>/); // F21
    assert.match(html, /Pat Mock<\/td><td>pat@example.com/); assert.match(html, /&#39;|=Sam/);
    const csv = await (await fetch(a.base + '/admin/newsletter.csv', { headers: { cookie: s.cookie } })).text(); // F20 columns + formula guard
    assert.ok(csv.startsWith('name,email,tenant,confirmed_at,source,consent_method,confirm_ip,user_agent,unsubscribed_at,phone,email_optin,sms_optin,')); assert.match(csv, /'=Sam/);
    ({ html } = await page(a, '/admin/calls', s.cookie));
    assert.match(html, /<form method="get" action="\/admin\/calls">From <input type="date" name="from"[^>]*> To <input type="date" name="to"[^>]*> Number <input name="number"[^>]*> <button type="submit">Filter<\/button> <a href="\/admin\/calls">Clear<\/a><\/form>/); // F23
    assert.match(html, /2 call\(s\)\. <a href="\/admin\/calls.csv">Download CSV<\/a>/); // F24
    assert.match(html, /href="\/admin\/kb-gaps.csv">Unanswered questions \(CSV\)/); // F25
    assert.match(html, /href="\/admin\/messages\?type=sms">Review texts<\/a> · <a href="\/admin\/messages\?type=email">Review emails<\/a> <small>Call records are kept 180 days\. Times are UTC\./); // F26
    assert.match(html, /<th>Time \(UTC\)<\/th><th>Caller<\/th><th>Duration<\/th><th>Asked about<\/th><th>Tools<\/th><th>Emails sent<\/th><th>Newsletter opt-in<\/th>/); // F27
    assert.match(html, /\+17275550100<\/td><td>95s<\/td><td>FCC limits<\/td><td>kb_answer, send_email<\/td><td>p\*\*\*@e\*\*\*.com: FCC limits<br>x\*\*\*@e\*\*\*.com: links \(failed\)<\/td><td>yes/);
    assert.match(html, /<td>withheld<\/td>/);
    // F23 filters (and the old /admin?number= link redirects to them), F24 the CSV keeps the filter
    ({ html } = await page(a, '/admin/calls?from=2026-10-25', s.cookie)); assert.match(html, /1 call\(s\)\. <a href="\/admin\/calls.csv\?from=2026-10-25">/);
    const old = await fetch(a.base + '/admin?number=7275550100&from=2026-10-01', { redirect: 'manual', headers: { cookie: s.cookie } });
    assert.strictEqual(old.status, 303); assert.strictEqual(old.headers.get('location'), '/admin/calls?number=7275550100&from=2026-10-01');
    ({ html } = await page(a, '/admin/calls?number=7275550100', s.cookie)); assert.match(html, /1 call\(s\)/);
    const ccsv = await (await fetch(a.base + '/admin/calls.csv?from=2026-10-25', { headers: { cookie: s.cookie } })).text();
    assert.match(ccsv, /^at,ended_at,tenant,caller,seconds,summary,kb_queries,tools,emails,texts,newsletter_optin/); assert.match(ccsv, /\+17275550100/); assert.strictEqual(ccsv.trim().split('\r\n').length, 2);
    const gaps = await fetch(a.base + '/admin/kb-gaps.csv', { headers: { cookie: s.cookie } }); assert.match(gaps.headers.get('content-type'), /text\/csv/); assert.match(await gaps.text(), /^at,tenant,channel,reason,question/); // F25
  } finally { await a.close(); }
});

test('F30-F31, F40-F49: Review texts/emails and the Subscribers page keep every action', async () => {
  const a = await startApp();
  try {
    const s = await signIn(a);
    // F30 sent-message review: list, detail, 404, CSV per type
    a.deps.sentMessages.add({ channel: 'sms', tenant: 'rfsafe-demo', to: '+17275550101', text: 'Mock text one https://callbots.org/x', links: ['https://callbots.org/x'], status: 'sent' });
    const rows = a.deps.sentMessages.list('sms'); const id = rows[0].id;
    let { html } = await page(a, '/admin/messages?type=sms', s.cookie); assert.match(html, /Mock text one/); assert.match(html, /href="\/admin\/messages.csv\?type=sms"/);
    assert.strictEqual((await page(a, '/admin/messages?type=sms&id=' + encodeURIComponent(id), s.cookie)).r.status, 200);
    const nf = await page(a, '/admin/messages?type=sms&id=missing', s.cookie); assert.strictEqual(nf.r.status, 404); assert.match(nf.html, /class="nav glass"/);
    assert.match(await (await fetch(a.base + '/admin/messages.csv?type=sms', { headers: { cookie: s.cookie } })).text(), /Mock text one/);
    assert.strictEqual((await page(a, '/admin/messages?type=email', s.cookie)).r.status, 200); // F31
    // Subscribers (F40-F49)
    const nl = a.deps.newsletter;
    nl.record({ e: 'ann@example.com', n: 'Ann Mock', t: 'rfsafe-demo' }, 'confirmed');
    nl.record({ e: 'bo@example.com', n: 'Bo Mock', t: 'rfsafe-demo' }, 'confirmed');
    const sp = await page(a, '/admin/subscribers', s.cookie); html = sp.html;
    assert.match(sp.r.headers.get('content-security-policy'), /script-src 'nonce-/); assert.match(html, /<h1>Subscribers<\/h1>/);
    assert.match(html, /<form method="get" action="\/admin\/subscribers"><input name="q"/); assert.match(html, /2 entries/); assert.match(html, /href="\/admin\/newsletter.csv">Download CSV/); // F40, F47
    assert.match(html, /<h2>Audit log<\/h2>/); // F46
    const csrf = csrfIn(html); const key = (k) => { const m = html.match(new RegExp(`name="key" value="([^"]*)">\\s*<input name="name" value="${k}"`)); return m ? unesc(m[1]) : null; };
    const ann = key('Ann Mock'); assert.ok(ann);
    let q = (await page(a, '/admin/subscribers?q=ann', s.cookie)).html; assert.match(q, /1 entry/); assert.match(q, /<a href="\/admin\/subscribers">Clear<\/a>/); // F40
    let r = await post(a.base, '/admin/subscribers/edit', { csrf, key: ann, name: 'Ann Edited', email: 'ann@example.com', phone: '' }, s.cookie); // F41
    assert.strictEqual(r.status, 303); assert.strictEqual(r.headers.get('location'), '/admin/subscribers?msg=Saved.');
    html = (await page(a, '/admin/subscribers?msg=Saved.', s.cookie)).html; assert.match(html, /Ann Edited/); assert.match(html, /role="status"[^>]*>Saved\./); // F49 banner
    const ann2 = unesc((html.match(/name="key" value="([^"]*)">\s*<input name="name" value="Ann Edited"/) || [])[1]);
    r = await post(a.base, '/admin/subscribers/unsubscribe', { csrf, key: ann2, channel: 'email' }, s.cookie); assert.match(r.headers.get('location'), /Channel%20turned%20off/); // F42
    assert.ok(!nl.isSubscriber('rfsafe-demo', 'ann@example.com'));
    r = await post(a.base, '/admin/subscribers/unsubscribe', { csrf, key: ann2, channel: 'sms' }, s.cookie); assert.strictEqual(r.status, 303); // F43 (route answers; consent rules in subscribers-admin.test.js)
    r = await post(a.base, '/admin/subscribers/merge', { csrf, into: ann2, from: '' }, s.cookie); assert.match(r.headers.get('location'), /err=/); // F44 guarded
    const bo = key('Bo Mock');
    r = await post(a.base, '/admin/subscribers/delete', { csrf, key: bo }, s.cookie); const conf = await r.text(); // F45 server confirm page, in the layout
    assert.strictEqual(r.status, 200); assert.match(conf, /Delete this entry\?/); assert.match(conf, /class="nb on" href="\/admin\/subscribers"/);
    r = await post(a.base, '/admin/subscribers/delete', { csrf, key: bo, confirm: 'yes' }, s.cookie); assert.match(r.headers.get('location'), /Entry%20deleted/);
    html = (await page(a, '/admin/subscribers', s.cookie)).html; assert.match(html, /<td>delete<\/td>|>delete</); assert.match(html, /<td>edit<\/td>|>edit</); // F46 audit rows
    assert.match(html, /window\.confirm\('Delete '/); // F45 browser confirm kept
    assert.strictEqual((await post(a.base, '/admin/subscribers/edit', { csrf: 'bad', key: ann2, name: 'x' }, s.cookie)).status, 403); // F49
    assert.strictEqual((await post(a.base, '/admin/subscribers/edit', { csrf, key: ann2, name: 'x' }, s.cookie, { origin: 'https://evil.example' })).status, 403);
    const j = await fetch(a.base + '/admin/subscribers?q=ann', { headers: { authorization: 'Bearer ' + a.deps.adminToken } }); // F48
    assert.strictEqual(j.status, 200); const body = await j.json(); assert.ok(Array.isArray(body.entries)); assert.ok(body.entries.every((e) => !('key' in e)));
  } finally { await a.close(); }
});

test('F50-F57, F70-F71: Outbound, Owner feedback, Usage and the token APIs answer exactly as before', async () => {
  const a = await startApp();
  try {
    const s = await signIn(a);
    let { r, html } = await page(a, '/admin/outbound', s.cookie); assert.strictEqual(r.status, 200);
    assert.match(html, /class="nb on" href="\/admin\/outbound"/); // F50 in the layout
    assert.match(html, /action="\/admin\/outbound\/pin"/); // F51
    assert.match(html, /action="\/admin\/outbound\/settings"/); // F52
    assert.match(html, /action="\/admin\/outbound\/test-call"/); // F53
    assert.strictEqual((await post(a.base, '/admin/outbound/pin', { csrf: 'bad', t: 'rfsafe-demo', pin: '8317', pin_confirm: '8317' }, s.cookie)).status, 403);
    ({ r, html } = await page(a, '/admin/owner-feedback', s.cookie)); assert.strictEqual(r.status, 200); // F55
    assert.strictEqual((await fetch(a.base + '/admin/owner-feedback.json?tenant=rfsafe-demo')).status, 401);
    ({ r, html } = await page(a, '/admin/usage', s.cookie)); assert.strictEqual(r.status, 200); assert.match(html, /Usage &amp; costs/); assert.match(html, /href="\/admin"/); // F56 (own page, links home)
    assert.strictEqual((await fetch(a.base + '/admin/usage.json', { headers: { cookie: s.cookie } })).status, 200);
    assert.strictEqual((await fetch(a.base + '/admin/usage/snapshot', { method: 'POST', body: '{}' })).status, 503); // F57 no secret configured in demo
    const B = { authorization: 'Bearer ' + a.deps.adminToken };
    assert.strictEqual((await fetch(a.base + '/admin/status', { headers: B })).status, 200); // F70
    assert.strictEqual((await fetch(a.base + '/admin/tenants/rfsafe-demo', { headers: B })).status, 200);
    assert.strictEqual((await fetch(a.base + '/admin/tenants/rfsafe-demo/status', { headers: B })).status, 200);
    assert.strictEqual((await fetch(a.base + '/admin/tenants/rfsafe-demo')).status, 401);
    const ns = await fetch(a.base + '/admin/newsletter/subscribers', { headers: B }); assert.strictEqual(ns.status, 200); assert.ok('subscribers' in await ns.json()); // F71
    assert.strictEqual((await fetch(a.base + '/admin/newsletter/subscribers')).status, 401);
  } finally { await a.close(); }
});

test('F60-F61: /admin/mail hands the same session to /mail; the /mail sign-in page still works', async () => {
  const a = await startApp();
  try {
    const s = await signIn(a);
    const r = await fetch(a.base + '/admin/mail', { redirect: 'manual', headers: { cookie: s.cookie } });
    assert.strictEqual(r.status, 303); assert.strictEqual(r.headers.get('location'), '/mail'); assert.strictEqual(cookieOf(r, 'mail_session'), s.sess);
    assert.match(setCookie(r, 'mail_session')[0], /HttpOnly; Secure; SameSite=Strict; Path=\/mail/);
    assert.strictEqual((await fetch(a.base + '/mail/login')).status, 200); // F61 unchanged fallback
  } finally { await a.close(); }
});

test('N04-N09: one session for Admin, Mailbox and Brain box; Mailbox sign-in hands over; no open redirect', async () => {
  const a = await startSitemail();
  try {
    // N06 the Mailbox sign-in page sends the owner to the admin sign-in, keeping where they were going
    let r = await fetch(a.base + '/inbox', { redirect: 'manual' }); assert.strictEqual(r.headers.get('location'), '/inbox/login');
    r = await fetch(a.base + '/inbox/login', { redirect: 'manual' }); assert.strictEqual(r.status, 303); assert.strictEqual(r.headers.get('location'), '/admin/login?next=inbox');
    r = await fetch(a.base + '/inbox/kb', { redirect: 'manual' }); assert.strictEqual(r.headers.get('location'), '/inbox/login?next=kb');
    r = await fetch(a.base + '/inbox/login?next=kb', { redirect: 'manual' }); assert.strictEqual(r.headers.get('location'), '/admin/login?next=kb');
    const viaKb = await signIn(a, '?next=kb'); assert.strictEqual(viaKb.next, 'kb'); assert.strictEqual(viaKb.location, '/admin/go/kb');
    assert.match(setCookie(viaKb.p, 'pa_next')[0], /pa_next=; [^]*Max-Age=0/);
    // N08 next is a fixed list: anything else is ignored (no cookie, lands on /admin)
    for (const bad of ['https://evil.example', '//evil.example', '__proto__', 'constructor', '/admin/logout', 'inbox%0d%0aSet-Cookie:x=1']) {
      const g = await fetch(a.base + '/admin/login?next=' + encodeURIComponent(bad)); assert.strictEqual(cookieOf(g, 'pa_next'), null, bad);
    }
    // a forged pa_next cookie can only ever pick from the fixed list: an outside URL lands on /admin
    const s = await signIn(a, '', encodeURIComponent('https://evil.example')); assert.strictEqual(s.location, '/admin');
    // N01 with the package on, the Mailbox section has Mailbox + Brain box tiles
    const home = (await page(a, '/admin', s.cookie)).html;
    assert.match(home, /<section><h2>Mailbox<\/h2><div class="grid"><a class="tile" href="\/admin\/go\/inbox">[^]*?Mailbox<\/span><\/a><a class="tile" href="\/admin\/go\/kb">[^]*?Brain box<\/span><\/a><a class="tile" href="\/admin\/mail">/);
    // N04 handover: the admin session becomes the Mailbox session (same value, Path=/inbox)
    r = await fetch(a.base + '/admin/go/inbox', { redirect: 'manual', headers: { cookie: s.cookie } });
    assert.strictEqual(r.status, 303); assert.strictEqual(r.headers.get('location'), '/inbox'); assert.strictEqual(cookieOf(r, 'mail_session'), s.sess);
    assert.match(setCookie(r, 'mail_session')[0], /HttpOnly; Secure; SameSite=Strict; Path=\/inbox; Max-Age=43200/);
    r = await fetch(a.base + '/admin/go/kb', { redirect: 'manual', headers: { cookie: s.cookie } }); assert.strictEqual(r.headers.get('location'), '/inbox/kb');
    assert.strictEqual((await fetch(a.base + '/admin/go/inbox', { method: 'POST', redirect: 'manual', headers: { cookie: s.cookie } })).status, 405);
    // N05 that one session opens the Mailbox, the Brain box and its API
    const mc = 'mail_session=' + s.sess;
    const ib = await fetch(a.base + '/inbox', { redirect: 'manual', headers: { cookie: mc } }); assert.strictEqual(ib.status, 200); assert.match(await ib.text(), /Mailbox/);
    const kb = await fetch(a.base + '/inbox/kb', { redirect: 'manual', headers: { cookie: mc } }); assert.strictEqual(kb.status, 200);
    const sid = s.sess.split('.')[0]; const mcsrf = a.deps.adminAuth.csrfFor(sid);
    assert.strictEqual((await fetch(a.base + '/inbox/kb/api/entries', { headers: { cookie: mc, 'x-csrf': mcsrf } })).status !== 401, true);
    assert.strictEqual((await fetch(a.base + '/inbox/kb/api/entries', { headers: { cookie: mc, 'x-csrf': 'wrong' } })).status, 403);
    // a forged or old-secret Mailbox cookie is refused
    const old = require('../vendor/sitemail/src/mail/auth'); const other = new old.MagicAuth({ secret: 'old-mail-secret-0123456789', email: 'support@quantaxtechnology.com' });
    assert.strictEqual((await fetch(a.base + '/inbox', { redirect: 'manual', headers: { cookie: 'mail_session=' + other.newSession() } })).status, 303);
    // N05 sign out in the Mailbox ends the admin session too
    const out = await fetch(a.base + '/inbox/logout', { method: 'POST', redirect: 'manual', headers: { cookie: mc, 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrf=' + encodeURIComponent(mcsrf) });
    assert.strictEqual(out.status, 303); assert.strictEqual((await page(a, '/admin', s.cookie)).r.status, 303);
    // ...and sign out in the admin ends the Mailbox session, and clears its cookie
    const s2 = await signIn(a); const c2 = csrfIn((await page(a, '/admin', s2.cookie)).html);
    const o2 = await post(a.base, '/admin/logout', { csrf: c2 }, s2.cookie); assert.match(o2.headers.getSetCookie().join('\n'), /mail_session=; [^\n]*Path=\/inbox; Max-Age=0/);
    assert.strictEqual((await fetch(a.base + '/inbox', { redirect: 'manual', headers: { cookie: 'mail_session=' + s2.sess } })).status, 303);
    // public pages and APIs of the package are unchanged
    assert.strictEqual((await fetch(a.base + '/kb')).status, 200);
    assert.strictEqual((await fetch(a.base + '/admin/kb/entries')).status, 401); // F72 KB write key API
    assert.strictEqual((await fetch(a.base + '/admin/mail/messages')).status, 401); // F72 read key API
  } finally { await a.close(); }
});

test('N09: Mailbox package off: no Mailbox/Brain box tiles, handover explains instead of failing', async () => {
  const a = await startSitemail({ SITEMAIL_ENABLED: '0' });
  try {
    const s = await signIn(a);
    assert.doesNotMatch((await page(a, '/admin', s.cookie)).html, /\/admin\/go\//);
    const r = await page(a, '/admin/go/inbox', s.cookie); assert.strictEqual(r.r.status, 404); assert.match(r.html, /Mailbox is off/);
    assert.strictEqual((await fetch(a.base + '/inbox/login', { redirect: 'manual' })).status, 404); // package routes stay off
  } finally { await a.close(); }
});

test('N07: every old admin URL still answers or redirects (signed in)', async () => {
  const a = await startApp();
  try {
    const s = await signIn(a);
    for (const p of ['/admin', '/admin/subscribers', '/admin/subscribers?q=x', '/admin/messages?type=sms', '/admin/messages?type=email', '/admin/outbound', '/admin/owner-feedback', '/admin/usage', '/admin/usage.json', '/admin/newsletter.csv', '/admin/calls.csv', '/admin/kb-gaps.csv', '/admin/messages.csv?type=sms', '/admin/messages.csv?type=email', '/admin/login']) {
      assert.strictEqual((await fetch(a.base + p, { redirect: 'manual', headers: { cookie: s.cookie } })).status, 200, p);
    }
    for (const [p, to] of [['/admin?from=2026-10-01', '/admin/calls?from=2026-10-01'], ['/admin?to=2026-10-31', '/admin/calls?to=2026-10-31'], ['/admin?number=727', '/admin/calls?number=727'], ['/admin?err=x', '/admin/channels?err=x'], ['/admin/mail', '/mail']]) {
      const r = await fetch(a.base + p, { redirect: 'manual', headers: { cookie: s.cookie } }); assert.strictEqual(r.status, 303, p); assert.strictEqual(r.headers.get('location'), to, p);
    }
  } finally { await a.close(); }
});

test('FEATURE_PARITY.md: every listed id is checked by a test in this file', () => {
  const doc = fs.readFileSync(path.join(__dirname, '../FEATURE_PARITY.md'), 'utf8');
  const ids = [...new Set([...doc.matchAll(/^\| (F\d\d|N\d\d) \|/gm)].map((m) => m[1]))];
  assert.ok(ids.length >= 50, 'inventory has ' + ids.length + ' rows');
  const src = fs.readFileSync(__filename, 'utf8');
  const covered = new Set(); for (const m of src.matchAll(/test\('([^']+)'/g)) for (const r of m[1].matchAll(/([FN])(\d\d)(?:-[FN](\d\d))?/g)) { const lo = +r[2]; const hi = r[3] ? +r[3] : lo; for (let i = lo; i <= hi; i++) covered.add(r[1] + String(i).padStart(2, '0')); }
  for (const m of src.matchAll(/\/\/ ([FN]\d\d)\b/g)) covered.add(m[1]);
  const missing = ids.filter((id) => !covered.has(id)); assert.deepStrictEqual(missing, []);
});
