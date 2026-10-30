'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { Tools, Approvals } = require('../src/tools');
const { Consent, MockTwilio } = require('../src/twilio');
const { MockCallControl } = require('../src/mocks');
const { KB } = require('../src/kb');
const { MockEmail, ResendEmail, maskEmail, buildEmail, FROM } = require('../src/email');
const { buildInstructions } = require('../src/xai');
const { renderPrivacy: privacyPage } = require('../src/legal');
function mk(over = {}) {
  const t = { id: 'r', name: 'RF Safe', numbers: [], link_allowlist: ['rfsafe.org', 'quantacase.com'], support_email: 'support@rfsafe.com', sms_enabled: false, email_enabled: true, blocked_topics: [], ...over };
  const mail = new MockEmail(); const logs = [];
  const tools = new Tools(t, { kbFor: () => new KB({ allowlist: t.link_allowlist }), smsFor: () => new MockTwilio(), consent: new Consent(null), callControl: new MockCallControl(), notify: async () => {}, approvals: new Approvals(), log: (e, f) => logs.push({ e, ...f }), emailFor: () => mail });
  return { t, tools, mail, logs };
}
const voice = { channel: 'voice', callId: 'c1', caller: '+15555550142' };
test('email tools only when email_enabled', () => {
  assert.ok(mk().tools.definitions().some((d) => d.name === 'send_email'));
  assert.ok(!mk({ email_enabled: false }).tools.definitions().some((d) => d.name === 'send_email'));
});
test('send_email: needs spoken yes, one address, allowlisted links, 3 per call, masked logs', async () => {
  const m = mk(); const urls = ['https://quantacase.com/products/x', 'https://rfsafe.org/a'];
  assert.strictEqual((await m.tools.run('send_email', { urls }, voice)).error, 'confirm_email_first');
  assert.strictEqual((await m.tools.run('set_email_address', { email: 'jane@gmail.com', caller_said_yes: false }, voice)).error, 'need_confirmation');
  assert.strictEqual((await m.tools.run('set_email_address', { email: 'jane at gmail', caller_said_yes: true }, voice)).error, 'invalid_email');
  const ok = await m.tools.run('set_email_address', { email: 'Jane@Gmail.com', caller_said_yes: true }, voice);
  assert.strictEqual(ok.email_masked, 'j***@g***.com');
  assert.strictEqual((await m.tools.run('set_email_address', { email: 'other@x.com', caller_said_yes: true }, voice)).error, 'one_address_per_call');
  assert.strictEqual((await m.tools.run('send_email', { urls: ['https://evil.com/x'] }, voice)).error !== undefined, true);
  assert.strictEqual(m.mail.sent.length, 0);
  const s = await m.tools.run('send_email', { urls, note: 'case for iPhone https://evil.com' }, voice);
  assert.ok(s.sent); assert.match(s.say, /spam/);
  const e = m.mail.sent[0]; assert.strictEqual(e.to, 'jane@gmail.com'); assert.strictEqual(e.subject, 'Your RF Safe links'); assert.strictEqual(e.replyTo, 'support@rfsafe.com');
  assert.match(e.text, /Quanta X Technology LLC/); assert.match(e.text, /callbots\.org\/privacy/); assert.ok(!e.text.includes('evil.com'));
  await m.tools.run('send_email', { urls }, voice); await m.tools.run('send_email', { urls }, voice);
  assert.strictEqual((await m.tools.run('send_email', { urls }, voice)).error, 'email_limit_reached');
  assert.strictEqual(m.mail.sent.length, 3);
  assert.ok(!JSON.stringify(m.logs).includes('jane@gmail.com'));
  assert.strictEqual((await m.tools.run('send_email', { urls }, { channel: 'voice', callId: 'c2', caller: null })).error, 'confirm_email_first');
});
test('ResendEmail posts From/subject/reply_to and needs a key', async () => {
  let seen; const f = async (u, o) => { seen = { u, o }; return { ok: true, json: async () => ({ id: 'em_1' }) }; };
  assert.strictEqual((await new ResendEmail({ apiKey: '', fetchImpl: f }).send({ to: 'a@b.co' })).reason, 'email_not_configured');
  const r = await new ResendEmail({ apiKey: 're_test_x', fetchImpl: f }).send({ to: 'a@b.co', replyTo: 's@x.com', subject: 'S', text: 't', html: 'h' });
  assert.ok(r.ok); assert.strictEqual(seen.u, 'https://api.resend.com/emails');
  const b = JSON.parse(seen.o.body); assert.strictEqual(b.from, FROM); assert.strictEqual(b.reply_to, 's@x.com'); assert.deepStrictEqual(b.to, ['a@b.co']);
});
test('mask + html escaping', () => {
  assert.strictEqual(maskEmail('bob@sub.example.org'), 'b***@s***.org');
  assert.ok(!buildEmail({ links: [{ url: 'https://rfsafe.org/a' }], note: '<script>' }).html.includes('<script>'));
});
test('instructions offer email when texting is off; privacy mentions email', () => {
  const ins = buildInstructions({ name: 'RF Safe', link_allowlist: ['rfsafe.org'], blocked_topics: [], sms_enabled: false, email_enabled: true }, { callerLast4: '0142' });
  assert.match(ins, /offer to email/i); assert.match(ins, /spell it back/); assert.match(ins, /spam/);
  const off = buildInstructions({ name: 'RF Safe', link_allowlist: ['rfsafe.org'], blocked_topics: [], sms_enabled: false }, {});
  assert.ok(!/set_email_address/.test(off));
  assert.match(privacyPage(), /id="email"/); assert.match(privacyPage(), /rfsafe@callbots\.org/);
});
