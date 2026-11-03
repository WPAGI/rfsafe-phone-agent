'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { validateTenant } = require('../src/tenants'); const { verifyTenantTwilio } = require('../src/twilio');
const { checkTemplate } = require('../src/kbtemplate'); const { KB } = require('../src/kb');
const DEP = path.join(__dirname, '..', 'deploy'); const read = (f) => JSON.parse(fs.readFileSync(path.join(DEP, f), 'utf8'));
const t = read('bestdealon.tenant.json');

test('bestdealon tenant is valid, SMS off, number and brand set', () => {
  assert.deepStrictEqual(validateTenant(t), []);
  assert.strictEqual(t.sms_enabled, false); assert.deepStrictEqual(t.numbers, ['+17276320002']);
  assert.strictEqual(t.brand.team_name, 'Best Deal On');
});
test('bestdealon tenant holds no secret values, only env references', () => {
  for (const v of Object.values(t.secrets)) assert.match(v, /^env:BDO_[A-Z0-9_]+$/);
  const s = JSON.stringify(t); assert.ok(!/sk-|xai-|re_[A-Za-z0-9]{8}|SG\./.test(s));
  assert.ok(!/RFSAFE_|rfsafe/i.test(s), 'shares no RF Safe secret or link');
});
test('bestdealon does not touch the RF Safe number or tenant', () => {
  const rf = read('rfsafe.tenant.json'); assert.notStrictEqual(rf.id, t.id);
  assert.ok(!t.numbers.includes('+17276775572'));
});
test('without Twilio creds yet, bestdealon webhooks fail closed', () => {
  assert.strictEqual(verifyTenantTwilio(t, () => null, 'https://x/y', {}, { 'x-twilio-signature': 'abc' }), false);
});
test('twilio patch: valid once filled, rejected while placeholders remain', () => {
  const p = read('bestdealon.twilio.patch.json'); const merged = { ...t, ...p };
  assert.ok(validateTenant(merged).some((e) => /twilio/.test(e)));
  const filled = { ...merged, twilio: { account_sid: 'AC' + '0'.repeat(32), api_key_sid: 'SK' + '0'.repeat(32), webhook_keys: { ['webhooks_sharedkey_' + 'A'.repeat(26)]: 'twilio_webhook_key' }, require_shared_key: true } };
  delete filled._note; assert.deepStrictEqual(validateTenant(filled), []);
  assert.ok(!('twilio_auth_token' in filled.secrets), 'no main auth token used');
});
test('bestdealon KB starts empty and valid', () => {
  const d = path.join(__dirname, '..', 'kb', 'bestdealon');
  assert.deepStrictEqual(checkTemplate(d).errors, []);
  assert.strictEqual(new KB({ dirs: [d] }).answer('what are your hours').found, false);
});

const { Tools } = require('../src/tools'); const E = require('../src/email');
const mk = (tenant, sent) => new Tools(tenant, { kbFor: () => ({ answer: () => ({ found: false }) }), consent: {}, notify: async () => {}, log: () => {}, emailFor: () => ({ send: async (m) => { sent.push(m); return { ok: true }; } }) });
test('bestdealon: take-a-message enabled, no audio recording, no recording notice', () => {
  assert.deepStrictEqual(t.take_message, { enabled: true, record_audio: false, deliver: 'email' });
  assert.ok(mk(t, []).definitions().some((d) => d.name === 'take_message'));
  assert.ok(!/record/i.test(t.disclosure)); assert.strictEqual(t.returning_caller_greeting, false);
});
test('bestdealon: taken message is emailed to the owner from support@bestdealon.app', async () => {
  const sent = []; const tt = { ...t, owner_email: 'bestdealon@mail.grokbot.com' };
  const r = await mk(tt, sent).run('take_message', { name: 'Ann', callback: '+15550001111', message: 'Call me' }, { channel: 'voice', caller: '+15550001111' });
  assert.strictEqual(r.emailed, true); assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].from, 'Best Deal On <support@bestdealon.app>'); assert.match(sent[0].text, /Call me/);
});
test('bestdealon: email on, SMS off; caller email tools offered', () => {
  assert.strictEqual(t.email_enabled, true); assert.strictEqual(t.sms_enabled, false);
  const names = mk(t, []).definitions().map((d) => d.name);
  assert.ok(names.includes('set_email_address') && names.includes('send_email')); assert.ok(!names.includes('set_text_number'));
});
test('RF Safe keeps its sender and take_message unchanged', () => {
  assert.strictEqual(E.senderFor(read('rfsafe.tenant.json')), 'RF Safe <rfsafe@callbots.org>');
  assert.strictEqual(E.senderFor(t), 'Best Deal On <support@bestdealon.app>');
});
test('take_message can be turned off; validator rejects bad blocks', () => {
  assert.ok(!mk({ ...t, take_message: { enabled: false } }, []).definitions().some((d) => d.name === 'take_message'));
  assert.ok(validateTenant({ ...t, take_message: { deliver: 'sms' } }).length);
});
test('test-recipient guard: only the allowed inbox can receive real email', async () => {
  let calls = 0; const f = async () => { calls++; return { ok: true, json: async () => ({ id: 'x' }) }; };
  const m = new E.ResendEmail({ apiKey: 'k', fetchImpl: f, allowOnly: E.TEST_INBOX });
  assert.strictEqual((await m.send({ to: 'someone@example.com', subject: 's', text: 't' })).reason, 'recipient_not_allowed'); assert.strictEqual(calls, 0);
  assert.strictEqual((await m.send({ to: E.TEST_INBOX, subject: 's', text: 't' })).ok, true); assert.strictEqual(calls, 1);
});
test('bestdealon: owner is support@bestdealon.app (also the sender); pricing = take a message', () => {
  assert.strictEqual(t.owner_email, 'support@bestdealon.app'); assert.match(t.brand.email_from, /<support@bestdealon\.app>$/);
  assert.match(t.extra_instructions, /do not quote/i); assert.match(t.extra_instructions, /take a message/i);
  assert.strictEqual(fs.readFileSync(path.join(__dirname, '..', 'kb', 'bestdealon', 'pricing.jsonl'), 'utf8').trim(), '');
});
