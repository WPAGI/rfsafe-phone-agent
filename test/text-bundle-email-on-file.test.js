'use strict';
const test = require('node:test'); const assert = require('node:assert');
const path = require('path'); const fs = require('fs'); const os = require('os');
const { Tools, Approvals } = require('../src/tools');
const { Consent, MockTwilio } = require('../src/twilio');
const { MockCallControl, MockRealtimeWs } = require('../src/mocks');
const { KB } = require('../src/kb');
const { MockEmail } = require('../src/email');
const { Newsletter, spokenDomain } = require('../src/newsletter');
const { CallSession } = require('../src/xai');

const PH = '+17275550142'; const OTHER = '+17275550199';
function mk(tx = {}) {
  const t = { id: 'r', name: 'RF Safe', numbers: [], link_allowlist: ['rfsafe.org', 'quantacase.com'], sms_enabled: true, instant_link_reply: true, email_enabled: true, blocked_topics: [], max_call_seconds: 900, disclosure: 'Hi, {name}.', hours: { tz: 'America/New_York', open: '00:00', close: '23:59', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] }, ...tx };
  const nl = new Newsletter({ secret: 'x'.repeat(32), file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-')), 'nl.jsonl') });
  nl.record({ e: 'john@quantaxtechnology.com', n: 'John', t: 'r' }, 'confirmed'); nl.linkPhone({ tenant: 'r', email: 'john@quantaxtechnology.com', phone: PH });
  const sms = new MockTwilio(); const consent = new Consent(null); const mail = new MockEmail();
  const tools = new Tools(t, { kbFor: () => new KB({ allowlist: t.link_allowlist }), smsFor: () => sms, consent, callControl: new MockCallControl(), notify: async () => {}, approvals: new Approvals(), log: () => {}, emailFor: () => mail, newsletter: nl });
  return { t, nl, sms, mail, tools };
}
const voice = (caller = PH, id = 'c1') => ({ channel: 'voice', callId: id, caller });
const session = (m, caller) => { const ws = new MockRealtimeWs(); const s = new CallSession({ ws, tenant: m.t, callId: 'c1', caller, tools: m.tools, afterHours: false, log: () => {}, newsletter: m.nl }); clearTimeout(s.timer); return ws.sent.find((x) => x.type === 'session.update').session; };

test('text bundling: one SMS carries every requested link; asks "anything else" first', async () => {
  const m = mk(); await m.tools.run('set_text_number', { use_caller_id: true }, voice());
  const r = await m.tools.run('send_link_sms', { urls: ['https://rfsafe.org/a', 'https://quantacase.com/b', 'https://rfsafe.org/a'], note: 'Here you go' }, voice());
  assert.strictEqual(r.ok, true); const s = JSON.stringify(m.sms);
  assert.match(s, /rfsafe\.org\/a/); assert.match(s, /quantacase\.com\/b/); assert.strictEqual((s.match(/rfsafe\.org\/a/g) || []).length, 1);
  assert.strictEqual((await m.tools.run('send_link_sms', { urls: ['https://rfsafe.org/a', 'https://evil.com/x'] }, voice())).ok, false);
  assert.strictEqual((await m.tools.run('send_link_sms', { urls: ['1', '2', '3', '4', '5', '6'].map((n) => 'https://rfsafe.org/' + n) }, voice())).error, 'too_many_links');
  assert.strictEqual((await m.tools.run('send_link_sms', { url: 'https://rfsafe.org/c' }, voice())).ok, true); // single url still works
  const sess = session(m, PH); assert.match(sess.instructions, /Anything else you'd like me to include in that text\?/);
  assert.match(sess.tools.find((d) => d.name === 'send_link_sms').description, /Anything else you\\?'d like me to include in that text\?/);
});
test('spoken domain: domain part only, natural names', () => {
  assert.strictEqual(spokenDomain('quantaxtechnology.com'), 'Quanta X Technology');
  assert.strictEqual(spokenDomain('gmail.com'), 'Gmail');
  assert.strictEqual(spokenDomain('example.org'), 'example dot org');
});
test('email on file: model sees only the domain, never the address', () => {
  const m = mk(); const i = session(m, PH).instructions;
  assert.match(i, /Should I send it to your Quanta X Technology email on file, or a different one\?/);
  assert.doesNotMatch(i, /john@|john at|quantaxtechnology\.com/i);
  assert.doesNotMatch(session(m, OTHER).instructions, /email on file/);
  assert.doesNotMatch(session(mk({ email_enabled: false }), PH).instructions, /email on file/);
});
test('email_on_file resolves server-side and sends to the stored address; results never reveal it', async () => {
  const m = mk();
  const a = await m.tools.run('set_email_address', { email_on_file: true, caller_said_yes: true }, voice());
  assert.strictEqual(a.ok, true); assert.strictEqual(a.email_on_file, true); assert.doesNotMatch(JSON.stringify(a), /john|quantax/i);
  const r = await m.tools.run('send_email', { urls: ['https://rfsafe.org/a'] }, voice());
  assert.strictEqual(r.ok, true); assert.doesNotMatch(JSON.stringify(r), /john|quantax/i);
  assert.strictEqual(m.mail.sent[m.mail.sent.length - 1].to, 'john@quantaxtechnology.com');
});
test('email_on_file refused for unknown, blocked or toggled-off callers; different address uses the normal flow', async () => {
  const m = mk();
  assert.strictEqual((await m.tools.run('set_email_address', { email_on_file: true, caller_said_yes: true }, voice(OTHER))).error, 'no_email_on_file');
  assert.strictEqual((await m.tools.run('set_email_address', { email_on_file: true, caller_said_yes: true }, voice(null, 'c2'))).error, 'no_email_on_file');
  const off = mk({ returning_caller_greeting: false });
  assert.strictEqual((await off.tools.run('set_email_address', { email_on_file: true, caller_said_yes: true }, voice())).error, 'no_email_on_file');
  assert.strictEqual((await m.tools.run('set_email_address', { email_on_file: true, caller_said_yes: false }, voice())).ok, false);
  const d = await m.tools.run('set_email_address', { email: 'other@example.com', caller_said_yes: true }, voice(PH, 'c3'));
  assert.strictEqual(d.ok, true); assert.strictEqual(d.already_subscriber, false);
  await m.tools.run('send_email', { urls: ['https://rfsafe.org/a'] }, voice(PH, 'c3'));
  assert.strictEqual(m.mail.sent[m.mail.sent.length - 1].to, 'other@example.com');
});
