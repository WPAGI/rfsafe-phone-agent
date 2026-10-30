'use strict';
const test = require('node:test'); const assert = require('node:assert'); const { spawnSync } = require('child_process'); const path = require('path');
const { buildProvisionPlan, applyProvisionPlan } = require('../src/provision');

const env = {
  XAI_API_KEY: 'test-xai-key',
  TWILIO_ACCOUNT_SID: 'ACexample',
  RFSAFE_TWILIO_AUTH_TOKEN: 'twilio-auth-example',
  RFSAFE_PHONE_NUMBER: '+15555550100',
  PUBLIC_BASE_URL: 'https://rfsafe-phone-agent.onrender.com/',
};

test('provision plan targets xAI SIP and Twilio webhooks and omits credentials', () => {
  const plan = buildProvisionPlan({ env });
  assert.deepStrictEqual(plan.missing, []);
  const byName = Object.fromEntries(plan.steps.map((s) => [s.name, s]));
  assert.strictEqual(byName['xai.register_number'].body.origin, 'byo_trunk');
  assert.strictEqual(byName['xai.register_number'].body.webhook_url, 'https://rfsafe-phone-agent.onrender.com/xai/webhook');
  assert.strictEqual(byName['twilio.origination'].form.SipUrl, 'sip:+15555550100@sip.voice.x.ai;transport=tls');
  assert.strictEqual(byName['twilio.create_trunk'].form.DisasterRecoveryUrl, 'https://rfsafe-phone-agent.onrender.com/twilio/voice');
  assert.strictEqual(byName['twilio.create_trunk'].form.TransferMode, 'enable-all');
  assert.strictEqual(byName['twilio.sms_webhooks'].form.SmsUrl, 'https://rfsafe-phone-agent.onrender.com/twilio/sms');
  assert.strictEqual(byName['twilio.sms_webhooks'].form.StatusCallback, 'https://rfsafe-phone-agent.onrender.com/twilio/sms/status');
  const dumped = JSON.stringify(plan);
  assert.ok(!dumped.includes('test-xai-key'));
  assert.ok(!dumped.includes('twilio-auth-example'));
});

test('apply uses the injected client and does not log the webhook secret', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const json = async () => {
      if (url.endsWith('/Trunks')) return { sid: 'TRexample' };
      if (url.includes('IncomingPhoneNumbers.json?')) return { incoming_phone_numbers: [{ sid: 'PNexample' }] };
      if (url.includes('api.x.ai')) return { webhook_secret: 'whsec_example' };
      return { sid: 'ok' };
    };
    return { ok: true, status: 200, json };
  };
  const logs = [];
  const result = await applyProvisionPlan({ env, fetchImpl, log: (e, f) => logs.push({ e, ...f }) });
  assert.strictEqual(calls.length, 6);
  assert.ok(calls.some((u) => u.includes('api.x.ai/v2/phone-numbers')));
  assert.strictEqual(result.webhook_secret, 'whsec_example');
  assert.strictEqual(logs[0].webhook_secret, 'returned_once_not_logged');
  assert.ok(!JSON.stringify(logs).includes('whsec_example'));
});

test('the provision command is a dry-run unless asked', () => {
  const ran = spawnSync(process.execPath, ['scripts/provision-number.js'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.strictEqual(ran.status, 0);
  assert.match(ran.stdout, /dry-run: no API calls were made/);
  assert.match(ran.stdout, /RFSAFE_PHONE_NUMBER/);
  assert.doesNotMatch(ran.stdout, /whsec_/);
});
