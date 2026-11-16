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

test('sitemail v1.2 verification (rfsafe.app #73-#75): Rerun and Redraft on the rerun key only, single-variant color Black, host routes unchanged', async () => {
  const RERUN = 'test-sitemail-rerun-key-0123456789'; const READ = 'test-sitemail-read-key-01234567890';
  const h = (k) => crypto.createHash('sha256').update(k).digest('hex');
  const a = await startWith({ ...on, SITEMAIL_RERUN_HASH: h(RERUN), SITEMAIL_READ_HASH: h(READ) });
  try {
    const post = async (p, key) => (await fetch(a.base + p, { method: 'POST', headers: key ? { authorization: 'Bearer ' + key } : {} })).status;
    assert.equal(await post('/admin/mail/messages/r.unknown-0001/redraft'), 401);
    assert.equal(await post('/admin/mail/messages/r.unknown-0001/redraft', READ), 403);
    assert.equal(await post('/admin/mail/messages/r.unknown-0001/redraft', RERUN), 404);
    assert.equal(await post('/admin/mail/messages/r.unknown-0001/rerun', RERUN), 404);
    const hl = await (await fetch(a.base + '/health')).json(); assert.equal(hl.ok, true); assert.equal(hl.active_calls, 0);
    assert.equal((await fetch(a.base + '/mail', { redirect: 'manual' })).headers.get('location'), '/mail/login', 'host /mail unchanged');
    const cfg = require('../vendor/sitemail/site.config.js'); assert.equal(cfg.store.single_variant_color, 'Black'); assert.equal(cfg.modules.kb_growth, true);
    assert.ok(fs.existsSync(path.join(__dirname, '../vendor/sitemail/src/mailbox/revise.js')));
  } finally { await a.close(); }
});

test('sitemail /kb port: full public rfsafe.app KB with Callbots chrome, phone KB on top read-only, filters, Brain box seed import, public number on the page', async () => {
  const READ = 'test-sitemail-read-key-01234567890';
  const dataDir0 = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sitemail-kb-'));
  const wiki = path.join(dataDir0, 'kb', 'rfsafe-wiki', 'wiki');
  const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(wiki, rel)), { recursive: true }); fs.writeFileSync(path.join(wiki, rel), s); };
  w('answers/fcc-dose.md', '---\ntitle: "4,200 Times Too High"\npage_type: answer\n---\n# 4,200 Times Too High\n\nThe FCC limit is far above the cancer-risk dose.\n');
  w('answers/phone-agent-build-brief.md', '---\ntitle: "phone-agent-build-brief"\npage_type: answer\n---\nBuild notes.\n');
  w('research/study-1.md', '---\ntitle: "A study"\npage_type: study\n---\nA rat study.\n');
  const hash = (d) => { const h = crypto.createHash('sha256'); const walk = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true }).sort((p, q) => p.name.localeCompare(q.name))) { const f = path.join(x, e.name); if (e.isDirectory()) walk(f); else { h.update(f); h.update(fs.readFileSync(f)); } } }; walk(d); return h.digest('hex'); };
  const before = hash(path.join(dataDir0, 'kb')); const curatedBefore = hash(path.join(__dirname, '../kb/curated/rfsafe'));
  const deps = buildDeps({ mode: 'demo', env: { ...ENV, ...on, SITEMAIL_READ_HASH: crypto.createHash('sha256').update(READ).digest('hex') }, tenantsDir: path.join(__dirname, '../demo/tenants'), dataDir: dataDir0, log: () => {} });
  deps.tenants.save = () => {}; deps.mailFetch = require('../src/mail/mock').mockFetch();
  const app = createApp(deps); const srv = http.createServer(app.handler); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  try {
    const start = await (await fetch(base + '/kb')).text();
    assert.match(start, /<title>CallBots Knowledge Base/); assert.match(start, /Start here · RF Safe's core position/); assert.doesNotMatch(start, /core position will appear here|rfsafe\.app home/);
    assert.match(start, /class="kb-site" href="\/">callbots\.org</);
    assert.match(start, /\(727\) 677-5572/);
    const phones = start.match(/(?:\+?1[-.\s]*)?\(?\d{3}\)?[-.\s]*\d{3}[-.\s]*\d{4}/g) || [];
    const digits = (s) => s.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    assert.ok(phones.length >= 1 && phones.every((p) => digits(p) === '7276775572'), 'only the approved QuantaCase number is shown');
    const j = await (await fetch(base + '/kb/api/v1/kb.json')).json();
    assert.ok(j.counts.entries >= 226 + 1, 'rfsafe.app entries + phone KB pages: ' + j.counts.entries); assert.ok(j.counts.topics >= 21); assert.equal(j.counts.body_systems, 13);
    assert.ok(j.body_systems.every((b) => b.summary && /studies/.test(b.summary) && b.research_url.startsWith('https://rfsafe.app/research?system=')));
    assert.equal((await fetch(base + '/kb/fcc-dose')).status, 200); assert.equal((await fetch(base + '/kb/mission')).status, 200, 'repo curated card shown');
    assert.equal((await fetch(base + '/kb/phone-agent-build-brief')).status, 404); assert.equal((await fetch(base + '/kb/study-1')).status, 404);
    const list = await (await fetch(base + '/admin/kb/entries', { headers: { authorization: 'Bearer ' + KB_KEY } })).json();
    assert.ok(list.entries.length >= 200, 'rfsafe.app Q&A imported into the Callbots Brain box: ' + list.entries.length);
    const h = await (await fetch(base + '/health')).json(); assert.equal(h.ok, true); assert.equal(h.active_calls, 0); assert.ok(h.sitemail.seed_import.imported >= 200); assert.ok(h.sitemail.brain_box_coverage);
    assert.equal((await fetch(base + '/admin/mail/kb-coverage')).status, 401);
    const covRes = await fetch(base + '/admin/mail/kb-coverage', { headers: { authorization: 'Bearer ' + READ } });
    assert.equal(covRes.status, 200);
    const cov = await covRes.json();
    assert.ok(cov.coverage && typeof cov.coverage.questions === 'number');
    assert.ok('share' in cov.coverage);
    assert.ok(cov.seed_import && cov.seed_import.imported >= 200);
    assert.equal(hash(path.join(dataDir0, 'kb')), before, 'phone KB files on the data disk unchanged');
    assert.equal(hash(path.join(__dirname, '../kb/curated/rfsafe')), curatedBefore, 'repo curated KB unchanged');
  } finally { await new Promise(r => srv.close(r)); }
});
