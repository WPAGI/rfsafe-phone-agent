'use strict';
// Site Mail + Brain box (vendor/sitemail): mounted additively. The host /mail, /admin/mail, /twilio and /health keep
// working as before; the package answers only /inbox, /api/mail, /kb, /admin/kb/entries, /admin/mail/messages.
// SITEMAIL_ENABLED=0 turns it off. Mock mode only; no network.
const test = require('node:test'); const assert = require('node:assert');
const path = require('path'); const fs = require('fs'); const os = require('os'); const http = require('http'); const crypto = require('crypto');
const { buildDeps } = require('../src/runtime'); const { createApp } = require('../src/app'); const { ENV } = require('./helpers');
const KB_KEY = 'test-sitemail-kb-key-0123456789';
async function startWith(env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sitemail-'));
  const deps = buildDeps({ mode: 'demo', env: { ...ENV, ...env }, tenantsDir: path.join(__dirname, '../demo/tenants'), dataDir, log: () => {} });
  deps.tenants.save = () => {}; deps.mailFetch = require('../src/mail/mock').mockFetch();
  const app = createApp(deps); const srv = http.createServer(app.handler); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  return { dataDir, base, close: () => new Promise(r => srv.close(r)) };
}
const on = { SITEMAIL_MOCK: '1', SITEMAIL_KB_WRITE_HASH: crypto.createHash('sha256').update(KB_KEY).digest('hex'), SITEMAIL_ENC_KEY: crypto.randomBytes(32).toString('base64'), SITEMAIL_SESSION_SECRET: crypto.randomBytes(24).toString('base64'), MAIL_DOMAINS: 'callbots.org', RESEND_MAIL_READ_KEY: 're_test_host_reader' };

test('sitemail on: own routes answer, host routes unchanged, host data untouched', async () => {
  const a = await startWith(on);
  try {
    const st = (p, o) => fetch(a.base + p, { redirect: 'manual', ...(o || {}) });
    const h = await (await st('/health')).json(); assert.equal(h.ok, true); assert.equal(h.active_calls, 0); assert.equal(h.sitemail.enabled, true); assert.ok(h.sitemail.host_kb && h.sitemail.host_kb.files >= 0);
    const m = await st('/mail'); assert.equal(m.status, 303); assert.equal(m.headers.get('location'), '/mail/login'); // the host's own viewer
    const i = await st('/inbox'); assert.equal(i.status, 303); assert.equal(i.headers.get('location'), '/inbox/login');
    assert.equal((await st('/inbox/login')).status, 200);
    assert.equal((await st('/kb')).status, 200);
    assert.equal((await st('/api/mail/guide')).status, 200);
    assert.equal((await st('/admin/kb/entries')).status, 401);
    assert.equal((await st('/admin/mail/messages')).status, 401);
    assert.equal((await st('/', {})).status, 200);
    const put = await st('/admin/kb/entries/sitemail-test', { method: 'PUT', headers: { authorization: 'Bearer ' + KB_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Test', text: 'Test entry.', is_public: true }) });
    assert.equal(put.status, 201);
    assert.ok(fs.existsSync(path.join(a.dataDir, 'sitemail', 'kb-api')));
    assert.ok(!fs.existsSync(path.join(a.dataDir, 'kb', 'sitemail-test.md')));
  } finally { await a.close(); }
});

test('sitemail off (SITEMAIL_ENABLED=0): none of its routes answer, host unchanged', async () => {
  const a = await startWith({ ...on, SITEMAIL_ENABLED: '0' });
  try {
    const h = await (await fetch(a.base + '/health')).json(); assert.equal(h.ok, true); assert.equal(h.sitemail, undefined);
    for (const p of ['/inbox', '/kb', '/api/mail/guide']) assert.equal((await fetch(a.base + p, { redirect: 'manual' })).status, 404, p);
    assert.equal((await fetch(a.base + '/mail', { redirect: 'manual' })).status, 303);
  } finally { await a.close(); }
});
