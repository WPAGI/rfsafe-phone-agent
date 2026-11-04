'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { twilioSignature } = require('../src/twilio');
const { quickSmsReply } = require('../src/sms');
const { startApp, ENV } = require('./helpers');

const sms = (a, body) => { const p = { From: '+15555550142', To: '+14155550123', Body: body, MessageSid: 'SMtest' }; const url = a.base + '/twilio/sms';
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(ENV.DEMO_ACME_TWILIO_AUTH_TOKEN, url, p) }, body: new URLSearchParams(p).toString() }); };

test('texting off: keywords answer, a normal question gets empty TwiML, no AI and no outbound text', async () => {
  const a = await startApp({});
  const t = a.deps.tenants.list().find((x) => x.numbers.includes('+14155550123')); assert.strictEqual(t.sms_enabled, false);
  a.deps.smsHoldMs = 1;
  let brainCalls = 0; const b = a.deps.brain; if (b) for (const k of Object.keys(b)) if (typeof b[k] === 'function') { const f = b[k].bind(b); b[k] = (...x) => { brainCalls++; return f(...x); }; }
  const sent = []; a.deps.smsFor = () => ({ sendSms: async (m) => { sent.push(m); return { sid: 'SMx' }; }, senderPool: async () => [] });
  try {
    for (const [kw, re] of [['HELP', /support/], ['STOP', /unsubscribed/], ['START', /resubscribed/]]) { const r = await sms(a, kw); assert.strictEqual(r.status, 200); assert.match(await r.text(), re); }
    const q = await sms(a, 'What are your hours tomorrow?'); assert.strictEqual(q.status, 200);
    assert.strictEqual(await q.text(), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    await new Promise((r) => setTimeout(r, 300));
    assert.deepStrictEqual(sent, [], 'no outbound text, not even a hold text'); assert.strictEqual(brainCalls, 0, 'AI not called');
    assert.ok(a.logs.some((l) => l.e === 'sms.ignored_texting_off'));
  } finally { await a.close(); }
});

test('bestdealon tenant: HELP reply names Best Deal On and support@bestdealon.app', () => {
  const t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deploy/bestdealon/tenants/bestdealon.json'), 'utf8'));
  assert.strictEqual(t.support_email, 'support@bestdealon.app');
  const consent = { record() {} }; const r = quickSmsReply({ tenant: t, from: '+15555550142', text: 'HELP', consent, log: () => {} });
  assert.match(r, /^Best Deal On support/); assert.match(r, /email support@bestdealon\.app/); assert.match(r, /Reply STOP/);
});

test('bestdealon live SMS transport: BDO API key from env, account from env, sends via the BDO Messaging Service', async () => {
  const { buildDeps } = require('../src/runtime'); const { sendCustomerSms } = require('../src/twilio');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-bdo-')); fs.copyFileSync(path.join(__dirname, '..', 'deploy/bestdealon/tenants/bestdealon.json'), path.join(dir, 'bestdealon.json'));
  const AC = 'AC' + 'a'.repeat(32), SK = 'SK' + 'b'.repeat(32);
  const env = { BDO_TWILIO_ACCOUNT_SID: AC, BDO_TWILIO_API_KEY_SID: SK, BDO_TWILIO_API_KEY_SECRET: 'k-secret', BDO_XAI_WEBHOOK_SECRET: 'x', BDO_TWILIO_WEBHOOK_KEY: 'w', RFSAFE_TWILIO_AUTH_TOKEN: 'must-not-be-used', PUBLIC_BASE_URL: 'https://example.test', PA_ADMIN_TOKEN: 'a'.repeat(32), PA_STATE_SECRET: 's'.repeat(32), PA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), XAI_API_KEY: 'x', DATA_DIR: os.tmpdir() };
  const calls = []; const fetchImpl = async (url, o) => { calls.push({ url, o }); return { ok: true, json: async () => ({ sid: 'SMfake' }) }; };
  const deps = buildDeps({ mode: 'live', env, tenantsDir: dir, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pa-bdo-d-')), log: () => {}, fetchImpl });
  const t = deps.tenants.list().find((x) => x.id === 'bestdealon'); assert.strictEqual(t.sms_enabled, true);
  const tr = deps.smsFor(t); tr.fetch = fetchImpl;
  const consent = { canText: () => true };
  const r = await sendCustomerSms({ tenant: t, transport: tr, consent, to: '+15555550142', body: 'hi', log: () => {} });
  assert.ok(r.ok); assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, `https://api.twilio.com/2010-04-01/Accounts/${AC}/Messages.json`);
  assert.strictEqual(calls[0].o.headers.authorization, 'Basic ' + Buffer.from(SK + ':k-secret').toString('base64'));
  const form = new URLSearchParams(String(calls[0].o.body)); assert.strictEqual(form.get('MessagingServiceSid'), 'MGbffe879b3cbc03744a86df88e1170bea'); assert.strictEqual(form.get('From'), null);
});
