'use strict';
const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs'); const path = require('path');
const { Tools, Approvals } = require('../src/tools');
const { Consent, MockTwilio } = require('../src/twilio');
const { MockCallControl } = require('../src/mocks');
const { KB } = require('../src/kb');
const BDO = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deploy/bestdealon/tenants/bestdealon.json'), 'utf8'));
const RF = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deploy/rfsafe.tenant.json'), 'utf8'));
const voice = { channel: 'voice', callId: 'c1', caller: '+15555550142' };
function mk(t) {
  const sms = new MockTwilio(); const logs = []; const mails = []; const approvals = new Approvals();
  const tools = new Tools(t, { kbFor: () => new KB({ allowlist: t.link_allowlist }), shopifyFor: () => { throw new Error('none'); }, smsFor: () => sms, consent: new Consent(null), callControl: new MockCallControl({}),
    notify: async () => {}, approvals, log: (e, d) => logs.push({ e, ...d }), emailFor: () => ({ send: async (m) => { mails.push(m); return { ok: true }; } }), now: () => new Date('2026-11-04T15:00:00Z') });
  return { tools, sms, logs, mails, approvals };
}
const url = () => ({ url: 'https://bestdealon.app/' });
test('bestdealon: instant texts on, approval_mode kept', () => { assert.strictEqual(BDO.instant_link_reply, true); assert.strictEqual(BDO.approval_mode, true); assert.strictEqual(RF.instant_link_reply, false); });
test('bestdealon: consented text goes out once, right away, via the BDO Messaging Service', async () => {
  const m = mk({ ...BDO }); await m.tools.run('set_text_number', { use_caller_id: true }, voice);
  const r = await m.tools.run('send_link_sms', url(), voice);
  assert.ok(r.ok && !r.queued_for_approval, JSON.stringify(r)); assert.strictEqual(m.sms.sent.length, 1);
  assert.strictEqual(m.sms.sent[0].to, '+15555550142'); assert.strictEqual(m.sms.sent[0].messagingServiceSid, 'MGbffe879b3cbc03744a86df88e1170bea');
  assert.strictEqual(m.approvals.list('bestdealon').length, 0); assert.strictEqual(m.mails.length, 0);
});
test('bestdealon: no consent still blocked; off-domain link still blocked', async () => {
  const m = mk({ ...BDO });
  assert.strictEqual((await m.tools.run('send_link_sms', url(), { channel: 'sms', callId: 's1', caller: '+15555550142' })).error, 'no_consent_or_opted_out');
  await m.tools.run('set_text_number', { use_caller_id: true }, voice);
  assert.ok(!(await m.tools.run('send_link_sms', { url: 'https://evil.example/' }, voice)).ok);
  assert.strictEqual(m.sms.sent.length, 0);
});
test('held-for-approval text is logged and emailed to the owner (email on); nothing sent', async () => {
  const m = mk({ ...BDO, instant_link_reply: false }); await m.tools.run('set_text_number', { use_caller_id: true }, voice);
  const r = await m.tools.run('send_link_sms', url(), voice); assert.ok(r.queued_for_approval); await new Promise((s) => setImmediate(s));
  assert.strictEqual(m.sms.sent.length, 0);
  const q = m.logs.find((l) => l.e === 'sms.queued_for_approval'); assert.ok(q); assert.ok(!JSON.stringify(q).includes('5555550142'));
  assert.strictEqual(m.mails.length, 1); assert.strictEqual(m.mails[0].to, 'support@bestdealon.app'); assert.match(m.mails[0].text, /ending in 0142/); assert.match(m.mails[0].text, /bestdealon\.app/);
  assert.ok(!m.mails[0].text.includes('5555550142'));
  assert.ok(m.logs.some((l) => l.e === 'sms.queued_owner_email' && l.ok === true));
});
test('tenant with email off: queued text is logged only, no email', async () => {
  const m = mk({ ...BDO, instant_link_reply: false, email_enabled: false }); await m.tools.run('set_text_number', { use_caller_id: true }, voice);
  await m.tools.run('send_link_sms', url(), voice); await new Promise((s) => setImmediate(s));
  assert.ok(m.logs.some((l) => l.e === 'sms.queued_for_approval')); assert.strictEqual(m.mails.length, 0);
});
