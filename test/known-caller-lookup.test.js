'use strict';
const test = require('node:test'); const assert = require('node:assert');
const path = require('path'); const fs = require('fs'); const os = require('os');
const { CallSession } = require('../src/xai');
const { Tools, Approvals } = require('../src/tools');
const { Consent, MockTwilio } = require('../src/twilio');
const { MockRealtimeWs, MockCallControl } = require('../src/mocks');
const { KB } = require('../src/kb');
const { MockEmail } = require('../src/email');
const { Newsletter } = require('../src/newsletter');

const KATIE = '+17276101188'; const JOHN = '+17272444752'; const SMSONLY = '+15550003333';
function mk() {
  const t = { id: 'r', name: 'RF Safe', numbers: ['+17276775572'], link_allowlist: ['rfsafe.org', 'quantacase.com'], blocked_topics: [], sms_enabled: true, instant_link_reply: true, email_enabled: true, transfer_target: 'tel:' + KATIE, max_call_seconds: 900, disclosure: 'Hi, you have reached {name}. This call may be recorded.', hours: { tz: 'America/New_York', open: '00:00', close: '23:59', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] }, known_callers: { [KATIE]: { name: 'Katie', role: 'owner' }, [JOHN]: { name: 'John', role: 'founder' } } };
  const nl = new Newsletter({ secret: 'x'.repeat(32), file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-')), 'nl.jsonl') });
  nl.record({ e: 'support@quantaxtechnology.com', n: 'Johnny', t: 'r' }, 'confirmed'); nl.linkPhone({ tenant: 'r', email: 'support@quantaxtechnology.com', phone: KATIE });
  nl.requestSms({ tenant: 'r', phone: SMSONLY, wording: { text: 'w' } }); nl.confirmSms('r', SMSONLY, 'YES');
  const mail = new MockEmail();
  const tools = new Tools(t, { kbFor: () => new KB({ allowlist: t.link_allowlist }), smsFor: () => new MockTwilio(), consent: new Consent(null), callControl: new MockCallControl(), notify: async () => {}, approvals: new Approvals(), log: () => {}, emailFor: () => mail, newsletter: nl });
  return { t, nl, mail, tools };
}
function start(m, caller) {
  const ws = new MockRealtimeWs(); let sum;
  const s = new CallSession({ ws, tenant: m.t, callId: 'c1', caller, tools: m.tools, afterHours: false, log: () => {}, newsletter: m.nl, onEnd: (x) => { sum = x; } }); clearTimeout(s.timer);
  return { instr: ws.sent.find((x) => x.type === 'session.update').session.instructions, greet: ws.sent.find((x) => x.item && x.item.type === 'force_message').item.content[0].text, end: () => { s.finish(); return sum; } };
}
const voice = (caller) => ({ channel: 'voice', callId: 'c1', caller });

test('known caller / owner number still gets the subscriber lookup; greeting uses the subscriber name', () => {
  const m = mk(); const k = start(m, KATIE);
  assert.strictEqual(k.greet, 'Hi Johnny, how can I help you?');
  assert.match(k.instr, /first name on file: Johnny/); assert.match(k.instr, /do NOT ask for their name/); assert.match(k.instr, /takes priority over the known-caller name/);
  assert.match(k.instr, /Should I send it to your Quanta X Technology email on file, or a different one\?/);
  assert.doesNotMatch(k.instr, /support@|support at/i);
  assert.strictEqual(k.end().returning_caller, true);
});
test('known caller with no subscriber entry keeps the known-caller greeting and no on-file line', () => {
  const m = mk(); const j = start(m, JOHN);
  assert.strictEqual(j.greet, 'Hi John, how can I help you?'); assert.doesNotMatch(j.instr, /email on file/);
});
test('email on file for a known caller: no name or email asked; server fills sender name and stored address', async () => {
  const m = mk();
  const a = await m.tools.run('set_email_address', { email_on_file: true, caller_said_yes: true }, voice(KATIE));
  assert.strictEqual(a.ok, true); assert.strictEqual(a.sender_name, 'Johnny'); assert.doesNotMatch(JSON.stringify(a), /support|quantax/i);
  const r = await m.tools.run('send_email', { urls: ['https://rfsafe.org/a'] }, voice(KATIE));
  assert.strictEqual(r.ok, true); const sent = m.mail.sent.pop();
  assert.strictEqual(sent.to, 'support@quantaxtechnology.com'); assert.match(sent.text, /Johnny/);
});
test('phone-only subscriber (no email): welcome back, no on-file offer, on-file request is refused cleanly', async () => {
  const m = mk(); const s = start(m, SMSONLY);
  assert.match(s.greet, /^Welcome back! /); assert.doesNotMatch(s.instr, /email on file/);
  assert.strictEqual((await m.tools.run('set_email_address', { email_on_file: true, caller_said_yes: true }, voice(SMSONLY))).error, 'no_email_on_file');
});
