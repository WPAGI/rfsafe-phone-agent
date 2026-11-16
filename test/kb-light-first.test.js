'use strict';
// KB Light first, KB Full fallback on the phone line and texts (John, Nov 16, 2026, 3:06-3:08 AM ET:
// "Yes, deploy KB Light first then KB Full to callbots.org for email and phones once tests pass").
// KB Light = the Callbots Brain box (the 212 rfsafe.app public entries the mount imports). KB Full = the tenant's phone
// KB (repo curated cards + the data-disk wiki), read only. Mock mode only: no network, no texts, no calls.
const test = require('node:test'); const assert = require('node:assert');
const path = require('path'); const fs = require('fs'); const os = require('os'); const crypto = require('crypto'); const http = require('http');
const { buildDeps } = require('../src/runtime'); const { createApp } = require('../src/app'); const { ENV } = require('./helpers');
const KB_KEY = 'test-sitemail-kb-key-0123456789';
const on = { SITEMAIL_MOCK: '1', SITEMAIL_KB_WRITE_HASH: crypto.createHash('sha256').update(KB_KEY).digest('hex'), SITEMAIL_ENC_KEY: crypto.randomBytes(32).toString('base64'), SITEMAIL_SESSION_SECRET: crypto.randomBytes(24).toString('base64'), MAIL_DOMAINS: 'callbots.org', RESEND_MAIL_READ_KEY: 're_test_host_reader' };
const hash = (d) => { const h = crypto.createHash('sha256'); const walk = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true }).sort((p, q) => p.name.localeCompare(q.name))) { const f = path.join(x, e.name); if (e.isDirectory()) walk(f); else { h.update(f); h.update(fs.readFileSync(f)); } } }; walk(d); return h.digest('hex'); };
const QS = {
  west: 'How long does shipping take to the West Coast?',
  canada: 'Do you ship to Canada?',
  kids: 'Should my 10 year old have a cell phone?',
  magsafe: 'Will the case work with a MagSafe wallet and a wireless charger?',
};
// rfsafe.app's owner-approved MagSafe card (demo/kb/rfsafe-live/05-owner-magsafe-wireless-charging.md), word for word.
const MAGSAFE = { title: 'Owner-approved answer: is the QuantaCase MagSafe compatible, and does it work with wireless charging?', aliases: 'magsafe mag safe magnetic magnets magnet ring wireless charging wireless charger qi charging charging pad', text: 'Owner-approved answer (source: John Coates, Nov 14, 2026): The QuantaCase is not designed to be MagSafe compatible because we chose not to add extra metal and magnets to the case\'s design. It does not interfere with wireless charging.' };

async function start(extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-kbl-'));
  const wiki = path.join(dataDir, 'kb', 'rfsafe-wiki', 'wiki'); fs.mkdirSync(path.join(wiki, 'answers'), { recursive: true });
  fs.writeFileSync(path.join(wiki, 'answers/fcc-dose.md'), '---\ntitle: "4,200 Times Too High"\npage_type: answer\n---\nThe FCC limit is about 4,200 times the cancer-risk dose.\n');
  fs.writeFileSync(path.join(wiki, 'answers/staff-hours.md'), '---\ntitle: "Talk to a real person"\npage_type: answer\n---\nTo talk to a real person, leave a message and the QuantaCase team calls back on business days.\n');
  fs.writeFileSync(path.join(wiki, 'answers/old-shipping.md'), '---\ntitle: "Old shipping page"\npage_type: answer\n---\nShipping to Canada, the West Coast, MagSafe and children: an old phone KB page that must lose to KB Light.\n');
  const logs = []; const kbBefore = hash(path.join(dataDir, 'kb')); const curatedBefore = hash(path.join(__dirname, '../kb/curated/rfsafe'));
  const deps = buildDeps({ mode: 'demo', env: { ...ENV, ...on, ...extraEnv }, tenantsDir: path.join(__dirname, '../demo/tenants'), dataDir, log: () => {} });
  deps.tenants.save = () => {}; deps.mailFetch = require('../src/mail/mock').mockFetch(); deps.log = (e, f) => logs.push([e, f]);
  const app = createApp(deps); const srv = http.createServer(app.handler); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const demo = deps.tenants.get('rfsafe-demo'); const rfsafe = { ...demo, id: 'rfsafe' }; // the live phone tenant id
  const ask = (t, q, channel) => app.toolsFor(t).ctxCall({ channel, caller: '+15555550100', callId: 'c1' }).run('kb_answer', { question: q });
  return { dataDir, base, logs, deps, app, rfsafe, demo, ask, kbBefore, curatedBefore, close: () => new Promise((r) => srv.close(r)) };
}

test('phone and SMS: MagSafe, West Coast shipping, Canada and kids answer from KB Light; KB Full files unchanged', async () => {
  const a = await start();
  try {
    const put = await fetch(a.base + '/admin/kb/entries/quantacase-magsafe-wireless-charging', { method: 'PUT', headers: { authorization: 'Bearer ' + KB_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ ...MAGSAFE, owner_approved: true }) });
    assert.equal(put.status, 201);
    const want = { west: /4 to 6 business days on the West Coast/, canada: /orders ship only within the United States/, kids: /we don't recommend that children use cell phones/, magsafe: /not designed to be MagSafe compatible[^]*does not interfere with wireless charging/ };
    for (const ch of ['voice', 'sms']) for (const [k, q] of Object.entries(QS)) {
      a.logs.length = 0; const r = await a.ask(a.rfsafe, q, ch);
      assert.equal(r.ok, true); assert.equal(r.found, true, ch + ' ' + k);
      assert.match(r.passages.map((p) => p.text).join('\n'), want[k], ch + ' ' + k);
      assert.ok(!r.passages.some((p) => p.title === 'Old shipping page'), 'KB Full page not mixed in');
      assert.equal(r.kb_layer, undefined); assert.ok(r.passages.every((p) => p.layer === undefined), 'model sees the same answer shape');
      const l = a.logs.find(([e]) => e === 'kb.layer'); assert.ok(l, 'layer logged'); assert.deepEqual([l[1].layer, l[1].channel], ['light', ch]);
    }
    const h = await (await fetch(a.base + '/health')).json(); assert.equal(h.ok, true); assert.equal(h.active_calls, 0);
    assert.deepEqual([h.sitemail.kb_light_first.mail, h.sitemail.kb_light_first.phone, h.sitemail.kb_light_first.sms], [true, true, true]); assert.ok(h.sitemail.kb_light_first.light_entries >= 212);
    assert.equal(hash(path.join(a.dataDir, 'kb')), a.kbBefore, 'KB Full (data disk) unchanged'); assert.equal(hash(path.join(__dirname, '../kb/curated/rfsafe')), a.curatedBefore, 'repo curated KB unchanged');
  } finally { await a.close(); }
});

test('fallback: a question KB Light has no good match for is answered by KB Full exactly as before', async () => {
  const a = await start();
  try {
    for (const ch of ['voice', 'sms']) {
      a.logs.length = 0; const q = 'Can I talk to a real person?';
      const r = await a.ask(a.rfsafe, q, ch); const before = a.deps.kbFor(a.rfsafe).answer(q);
      assert.deepEqual(r.passages, before.passages); assert.equal(r.found, before.found); assert.equal(r.passages[0].title, 'Talk to a real person');
      assert.equal(a.logs.find(([e]) => e === 'kb.layer')[1].layer, 'full');
    }
    // Light wins where it has an approved answer, even when KB Full has a page on it too.
    a.logs.length = 0; await a.ask(a.rfsafe, 'Why does RF Safe say the FCC limit is 4,200 times too high?', 'voice'); assert.equal(a.logs.find(([e]) => e === 'kb.layer')[1].layer, 'light');
    // No MagSafe entry in today's Callbots Brain box: MagSafe falls back to KB Full.
    a.logs.length = 0; await a.ask(a.rfsafe, QS.magsafe, 'voice'); assert.equal(a.logs.find(([e]) => e === 'kb.layer')[1].layer, 'full');
  } finally { await a.close(); }
});

test('switches: KB_LIGHT_FIRST_PHONE=0 / _SMS=0 restore the old lookup; other tenants and SITEMAIL_ENABLED=0 untouched', async () => {
  const a = await start({ KB_LIGHT_FIRST_PHONE: '0' });
  try {
    const old = a.deps.kbFor(a.rfsafe).answer(QS.canada);
    const v = await a.ask(a.rfsafe, QS.canada, 'voice'); assert.deepEqual(v.passages || [], old.passages || []); assert.equal(v.found, old.found);
    assert.ok(!a.logs.some(([e]) => e === 'kb.layer'), 'phone switched off: no Light lookup');
    const s = await a.ask(a.rfsafe, QS.canada, 'sms'); assert.match(s.passages.map((p) => p.text).join('\n'), /only within the United States/, 'sms still Light first');
    const d = await a.ask(a.demo, QS.canada, 'voice'); const dOld = a.deps.kbFor(a.demo).answer(QS.canada); assert.deepEqual(d.passages || [], dOld.passages || [], 'unlisted tenant unchanged');
    const h = await (await fetch(a.base + '/health')).json(); assert.equal(h.sitemail.kb_light_first.phone, false); assert.equal(h.sitemail.kb_light_first.sms, true);
  } finally { await a.close(); }
  const b = await start({ KB_LIGHT_FIRST_SMS: 'off', KB_LIGHT_FIRST_MAIL: '0' });
  try { const s = await b.ask(b.rfsafe, QS.canada, 'sms'); assert.deepEqual(s.passages || [], b.deps.kbFor(b.rfsafe).answer(QS.canada).passages || []); const h = await (await fetch(b.base + '/health')).json(); assert.equal(h.sitemail.kb_light_first.mail, false); } finally { await b.close(); }
  const c = await start({ SITEMAIL_ENABLED: '0' });
  try { const v = await c.ask(c.rfsafe, QS.canada, 'voice'); assert.deepEqual(v.passages || [], c.deps.kbFor(c.rfsafe).answer(QS.canada).passages || []); assert.ok(!c.logs.some(([e]) => e === 'kb.layer')); } finally { await c.close(); }
});
