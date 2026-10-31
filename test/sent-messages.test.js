'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Tools, Approvals } = require('../src/tools');
const { Consent, MockTwilio } = require('../src/twilio');
const { MockCallControl } = require('../src/mocks');
const { KB } = require('../src/kb');
const { MockEmail } = require('../src/email');
const { SmsRateLimit } = require('../src/ratelimit');
const { SentMessages, extractLinks, etTime } = require('../src/messages');
const { startApp } = require('./helpers');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sm-')), 'sent-messages.jsonl');
const voice = { channel: 'voice', callId: 'c1', caller: '+15555550142' };
function mk(over = {}, mailImpl) {
  const t = { id: 'r', name: 'RF Safe', numbers: ['+15555550100'], link_allowlist: ['rfsafe.org', 'quantacase.com'], sms_enabled: true, email_enabled: true, approval_mode: false, blocked_topics: [], ...over };
  const consent = new Consent(null); consent.record('r', '+15555550142', 'inbound');
  const sms = new MockTwilio(); const mail = mailImpl || new MockEmail(); const sm = new SentMessages({ file: tmp() });
  const tools = new Tools(t, { kbFor: () => new KB({ allowlist: t.link_allowlist }), smsFor: () => sms, consent, callControl: new MockCallControl(), notify: async () => {}, approvals: new Approvals(), log: () => {}, emailFor: () => mail, sentMessages: sm, rateLimit: new SmsRateLimit({ perCall: 3, perHour: 5, perDay: 10 }) });
  return { tools, sms, mail, sm };
}

test('archive: exact SMS body, full number, sid, links, caller fingerprint', async () => {
  const m = mk();
  await m.tools.run('set_text_number', { use_caller_id: true }, voice);
  assert.ok((await m.tools.run('send_link_sms', { url: 'https://quantacase.com/products/x' }, voice)).sent);
  const [r] = m.sm.list('sms');
  assert.strictEqual(r.text, m.sms.sent[0].body); assert.strictEqual(r.to, '+15555550142'); assert.strictEqual(r.provider_id, 'SM_mock_1');
  assert.strictEqual(r.status, 'sent'); assert.deepStrictEqual(r.links, ['https://quantacase.com/products/x']); assert.strictEqual(r.call, 'c1');
  assert.ok(r.caller_fp && !String(r.caller_fp).includes('5550142'));
});

test('archive: failed SMS send (provider throws) is recorded as failed', async () => {
  const m = mk(); m.sms.sendSms = async () => { throw new Error('twilio down'); };
  await m.tools.run('set_text_number', { use_caller_id: true }, voice);
  const out = await m.tools.run('send_link_sms', { url: 'https://rfsafe.org/a' }, voice);
  assert.strictEqual(out.ok, false);
  const [r] = m.sm.list('sms'); assert.strictEqual(r.status, 'failed'); assert.strictEqual(r.error, 'provider_error'); assert.ok(r.text.includes('https://rfsafe.org/a'));
});

test('archive: exact email text + html + subject, and failures', async () => {
  const m = mk();
  await m.tools.run('set_email_address', { email: 'jane@gmail.com', caller_said_yes: true }, voice);
  assert.ok((await m.tools.run('send_email', { urls: ['https://rfsafe.org/a'], topic: 'Li-Fi', summary: 'Li-Fi uses light <b>not</b> RF.' }, voice)).sent);
  const [r] = m.sm.list('email'); const sent = m.mail.sent[0];
  assert.strictEqual(r.to, 'jane@gmail.com'); assert.strictEqual(r.text, sent.text); assert.strictEqual(r.html, sent.html); assert.strictEqual(r.subject, sent.subject);
  assert.ok(r.links.includes('https://rfsafe.org/a')); assert.strictEqual(r.provider_id, 'mock_1');
  const bad = mk({}, { send: async () => ({ ok: false, reason: 'provider_500' }) });
  await bad.tools.run('set_email_address', { email: 'a@b.com', caller_said_yes: true }, voice);
  await bad.tools.run('send_email', { urls: ['https://rfsafe.org/a'] }, voice);
  assert.strictEqual(bad.sm.list('email')[0].status, 'failed'); assert.strictEqual(bad.sm.list('email')[0].error, 'provider_500');
});

test('retention 180 days, legacy email.jsonl shown without body, link extraction, ET time', () => {
  const file = tmp(); const legacy = path.join(path.dirname(file), 'email.jsonl');
  fs.writeFileSync(legacy, [
    { at: '2026-10-28T12:00:00.000Z', kind: 'sent', tenant: 'r', call: 'old', to_masked: 'j***@g***.com', links: ['https://rfsafe.org/x'], provider_id: 'p0' },
    { at: '2026-10-28T12:00:00.000Z', kind: 'consent_verbal_call', tenant: 'r' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  let now = Date.parse('2026-10-29T00:00:00Z'); const sm = new SentMessages({ file, legacyEmailFile: legacy, now: () => now });
  sm.add({ channel: 'email', tenant: 'r', to: 'x@y.com', text: 'hi https://rfsafe.org/z.', html: '<a href="https://rfsafe.org/z">z</a>', provider_id: 'p1' });
  const l = sm.list('email'); assert.strictEqual(l.length, 2); assert.ok(l[1].legacy); assert.strictEqual(l[1].text, null); assert.strictEqual(l[1].to, 'j***@g***.com');
  assert.deepStrictEqual(l[0].links, ['https://rfsafe.org/z']);
  now += 181 * 86400000; sm.prune(); assert.strictEqual(sm.read().length, 0); assert.strictEqual(sm.list('email').length, 0);
  assert.deepStrictEqual(extractLinks('a https://a.org/x?y=1&amp;z=2, b'), ['https://a.org/x?y=1&z=2']);
  assert.match(etTime('2026-10-30T15:00:00Z'), /11:00:00\sAM EDT/);
});

test('admin pages: session required, list/detail escaped, pagination, CSV, dashboard links', async () => {
  const a = await startApp();
  try {
    assert.strictEqual((await fetch(a.base + '/admin/messages?type=sms')).status, 401);
    assert.strictEqual((await fetch(a.base + '/admin/messages.csv?type=email')).status, 401);
    const r0 = await fetch(a.base + '/admin/messages?type=sms', { redirect: 'manual', headers: { accept: 'text/html' } }); assert.strictEqual(r0.status, 303);
    const sm = a.deps.sentMessages; assert.ok(sm);
    for (let i = 0; i < 55; i++) sm.add({ channel: 'sms', tenant: 'rfsafe-demo', call: 'c' + i, to: '+17275550000', text: 'msg ' + i + ' https://rfsafe.org/' + i, provider_id: 'SM' + i });
    const x = sm.add({ channel: 'email', tenant: 'rfsafe-demo', to: 'j@e.com', subject: '<script>alert(1)</script>', text: 'T <img src=x>', html: '<p onclick="x">H</p>' });
    // sign in (reuse login flow)
    const cookieOf = (r, n) => { const m = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(n + '=')); return m ? m.slice(n.length + 1) : null; };
    const csrfIn = (h) => (h.match(/name="csrf" value="([^"]*)"/) || [])[1];
    const post = (p, f, c) => fetch(a.base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: c }, body: new URLSearchParams(f).toString() });
    const g0 = await fetch(a.base + '/admin/login'); const c0 = cookieOf(g0, 'pa_csrf');
    await post('/admin/login', { csrf: csrfIn(await g0.text()) }, 'pa_csrf=' + c0);
    const sent = a.deps.emailFor(null).sent; const link = sent[sent.length - 1].text.match(/https?:\/\/\S+\/admin\/auth#t=\S+/)[0];
    const g = await fetch(link.replace(/^https?:\/\/[^/]+/, a.base)); const c = cookieOf(g, 'pa_csrf');
    const p = await post('/admin/auth', { csrf: csrfIn(await g.text()), t: new URL(link).hash.slice(3) }, 'pa_csrf=' + c);
    const H = { cookie: 'pa_admin=' + cookieOf(p, 'pa_admin') };
    const dash = await (await fetch(a.base + '/admin', { headers: H })).text();
    assert.match(dash, /href="\/admin\/messages\?type=sms">Review texts/); assert.match(dash, /href="\/admin\/messages\?type=email">Review emails/);
    let h = await (await fetch(a.base + '/admin/messages?type=sms', { headers: H })).text();
    assert.match(h, /55 texts/); assert.match(h, /Page 1 of 2/); assert.match(h, /msg 54 /); assert.doesNotMatch(h, /msg 0 /); assert.match(h, /E[DS]T/);
    h = await (await fetch(a.base + '/admin/messages?type=sms&page=2', { headers: H })).text(); assert.match(h, /msg 0 /);
    h = await (await fetch(a.base + '/admin/messages?type=email&id=' + encodeURIComponent(x.id), { headers: H })).text();
    assert.doesNotMatch(h, /<script>alert/); assert.doesNotMatch(h, /<img src=x>/); assert.doesNotMatch(h, /<p onclick/);
    assert.match(h, /&lt;script&gt;alert\(1\)/); assert.match(h, /&lt;p onclick=&quot;x&quot;&gt;H/);
    assert.strictEqual((await fetch(a.base + '/admin/messages?type=email&id=nope', { headers: H })).status, 404);
    const csv = await fetch(a.base + '/admin/messages.csv?type=sms', { headers: H });
    assert.match(csv.headers.get('content-disposition'), /sent-texts\.csv/); const body = await csv.text();
    assert.strictEqual(body.trim().split('\r\n').length, 56); assert.match(body, /https:\/\/rfsafe\.org\/54/);
  } finally { await a.close(); }
});
