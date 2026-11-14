'use strict';
// Wiring for the reusable mail viewer (src/mail). Module unit tests live in src/mail/tests.
require('../src/mail/tests/mail.test.js');
const test = require('node:test'); const assert = require('node:assert');
const path = require('path'); const fs = require('fs'); const os = require('os'); const http = require('http');
const { buildDeps } = require('../src/runtime'); const { createApp } = require('../src/app'); const { ENV } = require('./helpers');
const { mockFetch } = require('../src/mail/mock');
const KEY = 're_test_wired_reader_key';
async function startWith(env) {
  const deps = buildDeps({ mode: 'demo', env: { ...ENV, ...env }, tenantsDir: path.join(__dirname, '../demo/tenants'), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pa-mail-')), log: () => {} });
  deps.tenants.save = () => {}; deps.mailFetch = mockFetch();
  const app = createApp(deps); const srv = http.createServer(app.handler); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port; deps.publicBaseUrl = base;
  return { deps, base, close: () => new Promise(r => srv.close(r)) };
}
const cookieOf = (r, n) => { const c = (r.headers.getSetCookie() || []).map(x => x.split(';')[0]).find(x => x.startsWith(n + '=')); return c ? c.slice(n.length + 1) : null; };
const csrfIn = (h) => (h.match(/name="csrf" value="([^"]*)"/) || [])[1];
const post = (base, p, form, ck) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ck }, body: new URLSearchParams(form).toString() });

test('mail viewer /mail: signed-out redirect, no-store, health and home unaffected', async () => {
  const a = await startWith({ MAIL_DOMAINS: 'bestdealon.app', RESEND_MAIL_READ_KEY: KEY });
  try {
    const r = await fetch(a.base + '/mail', { redirect: 'manual' }); assert.strictEqual(r.status, 303); assert.strictEqual(r.headers.get('location'), '/mail/login'); assert.match(r.headers.get('cache-control'), /no-store/);
    const l = await fetch(a.base + '/mail/login'); assert.strictEqual(l.status, 200); assert.match(l.headers.get('cache-control'), /no-store/); assert.ok(!(await l.text()).includes(KEY));
    assert.strictEqual((await fetch(a.base + '/mail/api/messages')).status, 401);
    assert.strictEqual((await fetch(a.base + '/health')).status, 200);
    assert.strictEqual((await fetch(a.base + '/')).status, 200);
  } finally { await a.close(); }
});

test('mail viewer /mail: owner link uses the existing admin sign-in and sender; admin session opens Mail', async () => {
  const a = await startWith({ MAIL_DOMAINS: 'bestdealon.app', RESEND_MAIL_READ_KEY: KEY });
  try {
    // Non-owner: same page, nothing sent.
    let g = await fetch(a.base + '/mail/login'); let c = cookieOf(g, 'mail_csrf');
    const other = await post(a.base, '/mail/login', { csrf: csrfIn(await g.text()), email: 'x@evil.example' }, 'mail_csrf=' + c);
    const sentBox = a.deps.emailFor(null).sent; assert.strictEqual(sentBox.length, 0); const otherBody = await other.text();
    g = await fetch(a.base + '/mail/login'); c = cookieOf(g, 'mail_csrf');
    const own = await post(a.base, '/mail/login', { csrf: csrfIn(await g.text()), email: 'support@quantaxtechnology.com' }, 'mail_csrf=' + c);
    assert.strictEqual(await own.text(), otherBody); assert.strictEqual(sentBox.length, 1); assert.strictEqual(sentBox[0].to, 'support@quantaxtechnology.com');
    const tok = sentBox[0].text.match(/\/mail\/auth#t=([A-Za-z0-9_-]+)/)[1];
    g = await fetch(a.base + '/mail/auth'); c = cookieOf(g, 'mail_csrf');
    const p = await post(a.base, '/mail/auth', { csrf: csrfIn(await g.text()), t: tok }, 'mail_csrf=' + c); assert.strictEqual(p.status, 303);
    const ck = 'mail_session=' + cookieOf(p, 'mail_session');
    const list = await (await fetch(a.base + '/mail/api/messages', { headers: { cookie: ck } })).json();
    assert.strictEqual(list.messages.length, 6); assert.ok(list.messages.every(m => m.to.every(t => t.endsWith('@bestdealon.app'))));
    // Admin dashboard bridge: signed out goes to admin sign-in; a valid admin session gets a Mail session.
    const adm = await fetch(a.base + '/admin/mail', { redirect: 'manual' }); assert.strictEqual(adm.status, 303); assert.strictEqual(adm.headers.get('location'), '/admin/login');
    const viaAdmin = await fetch(a.base + '/admin/mail', { redirect: 'manual', headers: { cookie: 'pa_admin=' + cookieOf(p, 'mail_session') } });
    assert.strictEqual(viaAdmin.status, 303); assert.strictEqual(viaAdmin.headers.get('location'), '/mail'); assert.ok(cookieOf(viaAdmin, 'mail_session'));
  } finally { await a.close(); }
});

test('mail viewer /mail: without MAIL_DOMAINS nothing is listed', async () => {
  const a = await startWith({ RESEND_MAIL_READ_KEY: KEY });
  try {
    const s = a.deps.adminAuth.newSession();
    const list = await (await fetch(a.base + '/mail/api/messages', { headers: { cookie: 'mail_session=' + s } })).json();
    assert.strictEqual(list.messages.length, 0);
  } finally { await a.close(); }
});
