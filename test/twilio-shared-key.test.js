'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { startApp, ENV } = require('./helpers');
const { twilioSignature, sharedKeySignature, verifyTenantTwilio, parseSignatureSettings, TwilioRest } = require('../src/twilio');
const { validateTenant } = require('../src/tenants');

const KEY_ID = 'webhooks_sharedkey_' + 'A'.repeat(26);
const KEY = 'bdo-shared-key-test-secret';
const bdo = (over = {}) => ({ id: 'bdo-test', name: 'Best Deal On', numbers: ['+17275559100'], link_allowlist: ['bestdealon.app'],
  secrets: { twilio_webhook_key: 'env:BDO_TEST_TWILIO_WEBHOOK_KEY', twilio_api_key_secret: 'env:BDO_TEST_TWILIO_API_KEY_SECRET' },
  twilio: { account_sid: 'AC' + '1'.repeat(32), api_key_sid: 'SK' + '2'.repeat(32), webhook_keys: { [KEY_ID]: 'twilio_webhook_key' }, require_shared_key: true }, ...over });
const sec = (env) => (t, name) => { const r = (t.secrets || {})[name]; return r && r.startsWith('env:') ? env[r.slice(4)] || null : null; };

test('parse X-Twilio-Webhooks-Signature-Settings', () => {
  assert.deepStrictEqual(parseSignatureSettings(`key=${KEY_ID}, algorithm=HMAC_SHA256`), { key: KEY_ID, algorithm: 'HMAC_SHA256' });
});

test('shared key: SHA256 and SHA1 accepted; wrong key, unknown key id, bad algorithm, no signature rejected', () => {
  const t = bdo(); const s = sec({ BDO_TEST_TWILIO_WEBHOOK_KEY: KEY }); const url = 'https://bot.test/twilio/sms/status'; const p = { MessageSid: 'SM1', To: '+17275559100' };
  for (const alg of ['HMAC_SHA256', 'HMAC_SHA1']) assert.ok(verifyTenantTwilio(t, s, url, p, { 'x-twilio-signature': sharedKeySignature(KEY, alg, url, p), 'x-twilio-webhooks-signature-settings': `key=${KEY_ID},algorithm=${alg}` }), alg);
  const h = (sig, ss) => ({ 'x-twilio-signature': sig, 'x-twilio-webhooks-signature-settings': ss });
  assert.ok(!verifyTenantTwilio(t, s, url, p, h(sharedKeySignature('wrong', 'HMAC_SHA256', url, p), `key=${KEY_ID},algorithm=HMAC_SHA256`)));
  assert.ok(!verifyTenantTwilio(t, s, url, p, h(sharedKeySignature(KEY, 'HMAC_SHA256', url, p), `key=webhooks_sharedkey_${'B'.repeat(26)},algorithm=HMAC_SHA256`)));
  assert.ok(!verifyTenantTwilio(t, s, url, p, h(sharedKeySignature(KEY, 'HMAC_SHA256', url, p), `key=${KEY_ID},algorithm=MD5`)));
  assert.ok(!verifyTenantTwilio(t, s, url, p, h(sharedKeySignature(KEY, 'HMAC_SHA256', url, { ...p, To: '+1999' }), `key=${KEY_ID},algorithm=HMAC_SHA256`)), 'tampered params');
  assert.ok(!verifyTenantTwilio(t, s, url, p, {}));
  assert.ok(!verifyTenantTwilio(t, sec({}), url, p, h(sharedKeySignature(KEY, 'HMAC_SHA256', url, p), `key=${KEY_ID},algorithm=HMAC_SHA256`)), 'secret not set');
});

test('require_shared_key refuses the auth-token path; without it the auth token still works', () => {
  const url = 'https://bot.test/x'; const p = { A: '1' }; const env = { BDO_TEST_TWILIO_WEBHOOK_KEY: KEY, TOK: 'tok' };
  const withTok = bdo({ secrets: { ...bdo().secrets, twilio_auth_token: 'env:TOK' } });
  assert.ok(!verifyTenantTwilio(withTok, sec(env), url, p, { 'x-twilio-signature': twilioSignature('tok', url, p) }));
  const relaxed = bdo({ secrets: withTok.secrets, twilio: { ...bdo().twilio, require_shared_key: false } });
  assert.ok(verifyTenantTwilio(relaxed, sec(env), url, p, { 'x-twilio-signature': twilioSignature('tok', url, p) }));
});

test('RF Safe path unchanged: auth token accepted; a spoofed shared-key header is rejected', () => {
  const rf = { id: 'rfsafe', secrets: { twilio_auth_token: 'env:TOK' } }; const url = 'https://bot.test/x'; const p = { A: '1' };
  assert.ok(verifyTenantTwilio(rf, sec({ TOK: 'tok' }), url, p, { 'x-twilio-signature': twilioSignature('tok', url, p) }));
  assert.ok(!verifyTenantTwilio(rf, sec({ TOK: 'tok' }), url, p, { 'x-twilio-signature': sharedKeySignature('anything', 'HMAC_SHA256', url, p), 'x-twilio-webhooks-signature-settings': `key=${KEY_ID},algorithm=HMAC_SHA256` }));
});

test('tenant validation for twilio block', () => {
  assert.deepStrictEqual(validateTenant(bdo()), []);
  assert.ok(validateTenant(bdo({ twilio: { api_key_sid: 'SK123' } })).length);
  assert.ok(validateTenant(bdo({ twilio: { webhook_keys: { [KEY_ID]: 'missing_secret' } } })).length);
  assert.ok(validateTenant(bdo({ twilio: { require_shared_key: true } })).length);
});

test('REST uses the API key (SK:secret) when set; account sid stays in the URL', async () => {
  const seen = []; const f = async (u, o) => { seen.push({ u, a: Buffer.from(o.headers.authorization.slice(6), 'base64').toString() }); return { ok: true, json: async () => ({ sid: 'SM1' }) }; };
  await new TwilioRest({ accountSid: 'AC1', apiKeySid: 'SK2', apiKeySecret: 'sec', fetchImpl: f }).sendSms({ from: '+1', to: '+2', body: 'b' });
  await new TwilioRest({ accountSid: 'AC1', authToken: 'tok', fetchImpl: f }).sendSms({ from: '+1', to: '+2', body: 'b' });
  assert.match(seen[0].u, /Accounts\/AC1\//); assert.strictEqual(seen[0].a, 'SK2:sec'); assert.strictEqual(seen[1].a, 'AC1:tok');
});

test('HTTP: shared-key-signed Twilio webhook accepted (2xx), unsigned / token-signed rejected (403)', async () => {
  ENV.BDO_TEST_TWILIO_WEBHOOK_KEY = KEY;
  const a = await startApp();
  try {
    a.deps.tenants.add(bdo());
    const url = a.base + '/twilio/sms/status'; const p = { MessageSid: 'SM1', MessageStatus: 'delivered', To: '+17275559100', From: '+17275550142' };
    const post = (headers) => fetch(url, { method: 'POST', body: new URLSearchParams(p), headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
    let r = await post({ 'x-twilio-signature': sharedKeySignature(KEY, 'HMAC_SHA256', url, p), 'x-twilio-webhooks-signature-settings': `key=${KEY_ID},algorithm=HMAC_SHA256` });
    assert.ok(r.status >= 200 && r.status < 300, String(r.status));
    r = await post({}); assert.strictEqual(r.status, 403);
    r = await post({ 'x-twilio-signature': twilioSignature(ENV.DEMO_TWILIO_AUTH_TOKEN, url, p) }); assert.strictEqual(r.status, 403);
  } finally { await a.close(); delete ENV.BDO_TEST_TWILIO_WEBHOOK_KEY; }
});
