'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { validateTenant } = require('../src/tenants'); const { verifyTenantTwilio } = require('../src/twilio');
const { checkTemplate } = require('../src/kbtemplate'); const { KB } = require('../src/kb');
const DEP = path.join(__dirname, '..', 'deploy'); const read = (f) => JSON.parse(fs.readFileSync(path.join(DEP, f), 'utf8'));
const t = read('bestdealon/tenants/bestdealon.json');

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
test('bestdealon KB is valid', () => {
  const d = path.join(__dirname, '..', 'kb', 'bestdealon');
  assert.deepStrictEqual(checkTemplate(d).errors, []);
});

const { Tools } = require('../src/tools'); const E = require('../src/email');
const mk = (tenant, sent) => new Tools(tenant, { kbFor: () => ({ answer: () => ({ found: false }) }), consent: {}, notify: async () => {}, log: () => {}, emailFor: () => ({ send: async (m) => { sent.push(m); return { ok: true }; } }) });
test('bestdealon: take-a-message enabled, no audio recording, no recording notice', () => {
  assert.deepStrictEqual(t.take_message, { enabled: true, record_audio: false, deliver: 'email' });
  assert.ok(mk(t, []).definitions().some((d) => d.name === 'take_message'));
  assert.ok(!/record/i.test(t.disclosure)); assert.strictEqual(t.returning_caller_greeting, true); assert.ok(!/record/i.test(t.welcome_back));
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
test('test-recipient guard accepts a comma-separated list (test inbox + owner) and still blocks others', async () => {
  let calls = 0; const f = async () => { calls++; return { ok: true, json: async () => ({ id: 'x' }) }; };
  const m = new E.ResendEmail({ apiKey: 'k', fetchImpl: f, allowOnly: E.TEST_INBOX + ', Support@BestDealOn.app' });
  assert.strictEqual((await m.send({ to: 'support@bestdealon.app', subject: 's', text: 't' })).ok, true);
  assert.strictEqual((await m.send({ to: E.TEST_INBOX, subject: 's', text: 't' })).ok, true);
  assert.strictEqual((await m.send({ to: 'someone@example.com', subject: 's', text: 't' })).reason, 'recipient_not_allowed');
  assert.strictEqual((await m.send({ to: ['support@bestdealon.app', 'x@example.com'], subject: 's', text: 't' })).reason, 'recipient_not_allowed');
  assert.strictEqual(calls, 2);
});
test('bestdealon: owner is support@bestdealon.app (also the sender); pricing = take a message', () => {
  assert.strictEqual(t.owner_email, 'support@bestdealon.app'); assert.match(t.brand.email_from, /<support@bestdealon\.app>$/);
  assert.match(t.extra_instructions, /do not quote/i); assert.match(t.extra_instructions, /take a message/i);
  assert.strictEqual(fs.readFileSync(path.join(__dirname, '..', 'kb', 'bestdealon', 'pricing.jsonl'), 'utf8').trim(), '');
});

const GREETING = "Best Deal On AI, featuring the Bizinator, Best Deal On Pages, email, text, inbound and outbound calls. Best Deal On does it all. I'm the AI assistant. Right now I can help by voice and email; texting is a feature that turns on after a one-time carrier approval. Are you a business owner, or calling about a business page?";
test('bestdealon greeting is the call-script greeting, exactly', () => { assert.strictEqual(t.disclosure, GREETING); });
test('bestdealon: voice and email today, texting after carrier approval; never offers texts or outbound calls', () => {
  const { buildInstructions } = require('../src/xai');
  const { TenantRegistry } = require('../src/tenants'); const ins = buildInstructions(new TenantRegistry(null).add({ ...t }), { afterHours: false });
  assert.match(t.extra_instructions, /only voice and email work today; texting is a feature that turns on after a one-time carrier approval/); assert.match(t.extra_instructions, /Do not offer to text yet/);
  assert.ok(!/coming soon/i.test(t.disclosure + t.extra_instructions + ins), 'no coming soon in greeting or prompt');
  assert.match(t.extra_instructions, /Never offer, promise or send a text/); assert.match(t.extra_instructions, /never promise that you or anyone will place an outbound call/);
  assert.match(ins, /texting is NOT switched on/); assert.match(ins, /only voice and email work today/);
  const names = mk(t, []).definitions().map((d) => d.name); assert.ok(!names.includes('set_text_number'));
  const kbText = fs.readdirSync(path.join(__dirname, '..', 'kb', 'bestdealon')).map((f) => fs.readFileSync(path.join(__dirname, '..', 'kb', 'bestdealon', f), 'utf8')).join('\n');
  assert.ok(!/opt in by checking|calls and texts|TODO|coming soon/i.test(kbText));
});
test('bestdealon KB loads from the tenant dir and answers; pricing stays take-a-message', () => {
  const dir = path.join(DEP, 'bestdealon', 'tenants'); const kb = new KB({ dirs: t.kb.dirs.map((p) => path.resolve(dir, p)) });
  assert.strictEqual(kb.answer('what is the Best Deal On Bot chrome extension').found, true);
  const kbText = fs.readdirSync(path.join(__dirname, '..', 'kb', 'bestdealon')).map((f) => fs.readFileSync(path.join(__dirname, '..', 'kb', 'bestdealon', f), 'utf8')).join('\n');
  assert.ok(!/\$\s?\d|account is free/i.test(kbText)); assert.match(kbText, /do not have pricing on this line/);
});
test('bestdealon: Twilio webhooks require the shared key; a correctly signed request passes', () => {
  const { sharedKeySignature } = require('../src/twilio');
  const id = Object.keys(t.twilio.webhook_keys)[0]; assert.strictEqual(t.twilio.require_shared_key, true);
  const sec = (_t, name) => (name === 'twilio_webhook_key' ? 'k'.repeat(32) : null);
  const url = 'https://callbots-bdo.onrender.com/twilio/voice'; const p = { CallSid: 'CA1' };
  const sig = sharedKeySignature('k'.repeat(32), 'HMAC_SHA1', url, p);
  assert.strictEqual(verifyTenantTwilio(t, sec, url, p, { 'x-twilio-signature': sig, 'x-twilio-webhooks-signature-settings': `key=${id},algorithm=HMAC_SHA1` }), true);
  assert.strictEqual(verifyTenantTwilio(t, sec, url, p, { 'x-twilio-signature': sig }), false);
});
test('readiness: shared-key tenant needs its webhook key secret, not the auth token', () => {
  const { collectChecks } = require('../src/readiness');
  const ids = (env) => Object.fromEntries(collectChecks({ env, tenants: [t], dataDir: '/x', dataWritable: true }).checks.filter((c) => c.id.startsWith('tenant:bestdealon:')).map((c) => [c.id, c.ok]));
  const r = ids({ BDO_XAI_WEBHOOK_SECRET: 'a'.repeat(38), BDO_TWILIO_WEBHOOK_KEY: 'b'.repeat(32) });
  assert.strictEqual(r['tenant:bestdealon:twilio_webhook_key'], true); assert.ok(!('tenant:bestdealon:twilio_auth_token' in r));
  assert.strictEqual(ids({ BDO_XAI_WEBHOOK_SECRET: 'a'.repeat(38) })['tenant:bestdealon:twilio_webhook_key'], false);
});

// Option B: with PA_EMAIL_ALLOW_ONLY set, the caller's own confirmed address passes; nothing else does.
{
  const { Tools, NOT_ALLOWED_SAY } = require('../src/tools'); const E2 = require('../src/email');
  const rig = () => {
    const hits = []; const f = async (u, o) => { hits.push(JSON.parse(o.body).to[0]); return { ok: true, json: async () => ({ id: 're_' + hits.length }) }; };
    const mail = new E2.ResendEmail({ apiKey: 'k', fetchImpl: f, allowOnly: E2.TEST_INBOX + ',support@bestdealon.app' });
    const tools = new Tools(t, { emailFor: () => mail, log: () => {}, notify: async () => {} });
    return { hits, mail, tools };
  };
  const confirm = (tools, email, callId) => tools.run('set_email_address', { email, caller_said_yes: true }, { channel: 'voice', callId, caller: '+15550001111' });
  const send = (tools, callId, summary = 'Best Deal On overview') => tools.run('send_email', { summary, topic: 'overview', urls: ['https://bestdealon.app/'] }, { channel: 'voice', callId, caller: '+15550001111' });
  test('allow-only guard: the address confirmed on this call is allowed', async () => {
    const { hits, tools } = rig(); assert.strictEqual((await confirm(tools, 'caller@example.com', 'c1')).ok, true);
    const r = await send(tools, 'c1'); assert.strictEqual(r.ok, true); assert.deepStrictEqual(hits, ['caller@example.com']);
  });
  test('allow-only guard: unconfirmed or different addresses stay blocked, with the scripted line', async () => {
    const { hits, mail, tools } = rig();
    assert.strictEqual((await send(tools, 'c2')).error, 'confirm_email_first');
    assert.strictEqual((await mail.send({ to: 'other@example.com', subject: 's', text: 't', confirmedRecipient: 'caller@example.com' })).reason, 'recipient_not_allowed');
    assert.strictEqual((await mail.send({ to: 'other@example.com', subject: 's', text: 't' })).reason, 'recipient_not_allowed');
    assert.deepStrictEqual(hits, []);
    const { tools: t2 } = rig(); const failing = { send: async () => ({ ok: false, reason: 'recipient_not_allowed' }) }; t2.d.emailFor = () => failing;
    await confirm(t2, 'x@example.com', 'c3'); const r = await send(t2, 'c3');
    assert.strictEqual(r.error, 'recipient_not_allowed'); assert.strictEqual(r.say, NOT_ALLOWED_SAY);
    assert.strictEqual(NOT_ALLOWED_SAY, "I can't email that right now; I'll take a message so the team follows up.");
  });
  test('allow-only guard: an address confirmed on another call does not carry over', async () => {
    const { hits, tools } = rig(); await confirm(tools, 'caller@example.com', 'callA');
    const r = await send(tools, 'callB'); assert.strictEqual(r.ok, false); assert.strictEqual(r.error, 'confirm_email_first'); assert.deepStrictEqual(hits, []);
  });
  test('allow-only guard: the static allowlist still works without a confirmed address', async () => {
    const { hits, mail } = rig();
    assert.strictEqual((await mail.send({ to: 'support@bestdealon.app', subject: 's', text: 't' })).ok, true);
    assert.strictEqual((await mail.send({ to: 'nope@example.com', subject: 's', text: 't' })).reason, 'recipient_not_allowed');
    assert.deepStrictEqual(hits, ['support@bestdealon.app']);
  });
}
