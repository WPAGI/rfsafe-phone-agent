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
