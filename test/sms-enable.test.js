'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers');
const { sendCustomerSms, MockTwilio, Consent } = require('../src/twilio');
const { buildInstructions } = require('../src/xai');

const MS = 'MG' + 'a'.repeat(32);
test('POST /admin/tenants/:id/sms: admin only, needs number in sender pool, keeps email; PATCH still rejects sms_enabled', async () => {
  const a = await startApp();
  try {
    const t = a.deps.tenants.get('rfsafe-demo'); t.sms_enabled = false; t.email_enabled = true;
    const url = a.base + '/admin/tenants/rfsafe-demo/sms';
    const auth = { authorization: 'Bearer ' + a.deps.adminToken, 'content-type': 'application/json' };
    const post = (b, h = auth) => fetch(url, { method: 'POST', headers: h, body: JSON.stringify(b) });
    assert.strictEqual((await post({ enabled: true, messaging_service_sid: MS }, {})).status, 401);
    const p = await fetch(a.base + '/admin/tenants/rfsafe-demo', { method: 'PATCH', headers: auth, body: JSON.stringify({ sms_enabled: true }) });
    assert.strictEqual(p.status, 400);
    assert.strictEqual((await post({ enabled: true, messaging_service_sid: 'bad' })).status, 400);
    const tr = a.deps.smsFor(t); tr.pool = ['+15550000000'];
    let r = await post({ enabled: true, messaging_service_sid: MS }); assert.strictEqual(r.status, 409); assert.strictEqual(t.sms_enabled, false);
    tr.pool = [t.numbers[0]];
    r = await post({ enabled: true, messaging_service_sid: MS }); assert.strictEqual(r.status, 200);
    const j = await r.json(); assert.strictEqual(j.sms_enabled, true); assert.strictEqual(j.email_enabled, true);
    assert.strictEqual(t.twilio.messaging_service_sid, MS);
    r = await post({ enabled: false }); assert.strictEqual((await r.json()).sms_enabled, false); assert.strictEqual(t.email_enabled, true);
  } finally { await a.close(); }
});
test('sendCustomerSms uses the Messaging Service when set, still consent-gated', async () => {
  const tr = new MockTwilio(); const c = new Consent(null);
  const tenant = { id: 'x', numbers: ['+17276775572'], twilio: { messaging_service_sid: MS } };
  assert.strictEqual((await sendCustomerSms({ tenant, transport: tr, consent: c, to: '+17275550100', body: 'hi' })).ok, false);
  c.record('x', '+17275550100', 'verbal_call');
  assert.ok((await sendCustomerSms({ tenant, transport: tr, consent: c, to: '+17275550100', body: 'hi' })).ok);
  assert.strictEqual(tr.sent[0].messagingServiceSid, MS);
});
test('prompt offers text or email and asks which the caller prefers when both are on', () => {
  const base = { blocked_topics: [], ...JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../demo/tenants/rfsafe.json'), 'utf8')), email_enabled: true };
  assert.match(buildInstructions({ ...base, sms_enabled: true }, { afterHours: false, callerLast4: '0100' }), /Which would you prefer/);
  assert.doesNotMatch(buildInstructions({ ...base, sms_enabled: false }, { afterHours: false, callerLast4: '0100' }), /Which would you prefer/);
});
