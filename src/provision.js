'use strict';
// Build the xAI + Twilio setup calls. Dry-run by default. Nothing in this module runs itself.
function authToken(env) { return env.TWILIO_AUTH_TOKEN || env.RFSAFE_TWILIO_AUTH_TOKEN || ''; }
function phoneNumber(env) { return env.TWILIO_PHONE_NUMBER || env.RFSAFE_PHONE_NUMBER || ''; }
function accountSid(env) { return env.TWILIO_ACCOUNT_SID || env.RFSAFE_TWILIO_ACCOUNT_SID || ''; }

function buildProvisionPlan({ env }) {
  const missing = [];
  if (!env.XAI_API_KEY) missing.push('XAI_API_KEY');
  if (!accountSid(env)) missing.push('TWILIO_ACCOUNT_SID');
  if (!authToken(env)) missing.push('RFSAFE_TWILIO_AUTH_TOKEN');
  if (!phoneNumber(env)) missing.push('RFSAFE_PHONE_NUMBER');
  if (!env.PUBLIC_BASE_URL) missing.push('PUBLIC_BASE_URL');
  const number = phoneNumber(env);
  const base = String(env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const sid = accountSid(env);
  return {
    dry_run: true,
    missing,
    number,
    steps: [
      { name: 'twilio.create_trunk', method: 'POST', url: 'https://trunking.twilio.com/v1/Trunks', form: { FriendlyName: 'callbots-rfsafe', DisasterRecoveryUrl: base + '/twilio/voice', DisasterRecoveryMethod: 'POST', TransferMode: 'enable-all' } },
      { name: 'twilio.origination', method: 'POST', url: 'https://trunking.twilio.com/v1/Trunks/{TrunkSid}/OriginationUrls', form: { SipUrl: 'sip:' + number + '@sip.voice.x.ai;transport=tls', Priority: '10', Weight: '10', Enabled: 'true', FriendlyName: 'xai-grok-voice' } },
      { name: 'twilio.find_number', method: 'GET', url: 'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/IncomingPhoneNumbers.json?PhoneNumber=' + encodeURIComponent(number) },
      { name: 'twilio.attach_number', method: 'POST', url: 'https://trunking.twilio.com/v1/Trunks/{TrunkSid}/PhoneNumbers', form: { PhoneNumberSid: '{PhoneNumberSid}' } },
      { name: 'twilio.sms_webhooks', method: 'POST', url: 'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/IncomingPhoneNumbers/{PhoneNumberSid}.json', form: { SmsUrl: base + '/twilio/sms', SmsMethod: 'POST', StatusCallback: base + '/twilio/sms/status', StatusCallbackMethod: 'POST' } },
      { name: 'xai.register_number', method: 'POST', url: 'https://api.x.ai/v2/phone-numbers', body: { phone_number: number, origin: 'byo_trunk', webhook_url: base + '/xai/webhook' } },
    ],
  };
}

async function applyProvisionPlan({ env, fetchImpl, log = () => {} }) {
  const plan = buildProvisionPlan({ env });
  if (plan.missing.length) throw new Error('provision missing env: ' + plan.missing.join(', '));
  const sid = accountSid(env);
  const token = authToken(env);
  const basic = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');
  const twilio = (url, form) => fetchImpl(url, { method: 'POST', headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  const trunkRes = await twilio(plan.steps[0].url, plan.steps[0].form);
  const trunk = await trunkRes.json();
  if (!trunkRes.ok || !trunk.sid) throw new Error('twilio trunk create failed: ' + trunkRes.status);
  const orig = plan.steps[1];
  const origRes = await twilio(orig.url.replace('{TrunkSid}', trunk.sid), orig.form);
  if (!origRes.ok) throw new Error('twilio origination failed: ' + origRes.status);
  const find = plan.steps[2];
  const foundRes = await fetchImpl(find.url, { headers: { authorization: basic } });
  const found = await foundRes.json();
  const pn = (found.incoming_phone_numbers || [])[0];
  if (!foundRes.ok || !pn) throw new Error('twilio number lookup failed: ' + foundRes.status);
  const attach = plan.steps[3];
  const attachRes = await twilio(attach.url.replace('{TrunkSid}', trunk.sid), { PhoneNumberSid: pn.sid });
  if (!attachRes.ok) throw new Error('twilio attach number failed: ' + attachRes.status);
  const sms = plan.steps[4];
  const smsRes = await twilio(sms.url.replace('{PhoneNumberSid}', pn.sid), sms.form);
  if (!smsRes.ok) throw new Error('twilio sms webhook failed: ' + smsRes.status);
  const xai = plan.steps[5];
  const xaiRes = await fetchImpl(xai.url, { method: 'POST', headers: { authorization: 'Bearer ' + env.XAI_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify(xai.body) });
  const xaiBody = await xaiRes.json();
  if (!xaiRes.ok) throw new Error('xai register failed: ' + xaiRes.status);
  log('provision.applied', { trunk: trunk.sid, number_sid: pn.sid, webhook_secret: 'returned_once_not_logged' });
  return { ok: true, trunk_sid: trunk.sid, phone_number_sid: pn.sid, webhook_secret: xaiBody.webhook_secret || xaiBody.secret || null };
}

module.exports = { buildProvisionPlan, applyProvisionPlan, authToken, phoneNumber, accountSid };
