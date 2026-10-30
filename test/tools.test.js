'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { Tools, Approvals, inHours } = require('../src/tools');
const { Consent, MockTwilio } = require('../src/twilio');
const { MockCallControl } = require('../src/mocks');
const { KB } = require('../src/kb');
function mk(over = {}, depOver = {}) {
  const t = { id: 'r', name: 'R', numbers: ['+15555550100'], link_allowlist: ['rfsafe.org'], transfer_target: 'tel:+15555550199', hours: { tz: 'America/New_York', open: '09:00', close: '17:00' }, sms_enabled: true, approval_mode: false, blocked_topics: [], ...over };
  const consent = new Consent(null); const sms = new MockTwilio(); const cc = new MockCallControl(depOver.referStatus ? { referStatus: depOver.referStatus } : {}); const notes = [];
  const tools = new Tools(t, { kbFor: () => new KB({ allowlist: t.link_allowlist }), shopifyFor: () => { throw new Error('none'); }, smsFor: () => sms, consent, callControl: cc, notify: async (_, m) => notes.push(m), approvals: new Approvals(), log: () => {}, now: depOver.now || (() => new Date('2026-10-29T14:00:00Z')) });
  return { t, tools, consent, sms, cc, notes };
}
const voice = { channel: 'voice', callId: 'c1', caller: '+15555550142' };
test('business hours in tenant timezone', () => {
  const h = { tz: 'America/New_York', open: '09:00', close: '17:00' };
  assert.ok(inHours(h, new Date('2026-10-29T14:00:00Z'))); assert.ok(!inHours(h, new Date('2026-10-29T23:00:00Z'))); assert.ok(!inHours(h, new Date('2026-10-31T14:00:00Z')));
});
test('send_link: needs consent; STOP blocks; texting-off says so; approval mode queues', async () => {
  let m = mk(); const url = { url: 'https://rfsafe.org/a' };
  assert.strictEqual((await m.tools.run('send_link', url, voice)).error, 'no_consent_or_opted_out');
  m.consent.record('r', voice.caller, 'inbound'); assert.ok((await m.tools.run('send_link', url, voice)).sent);
  m.consent.record('r', voice.caller, 'stop'); assert.strictEqual((await m.tools.run('send_link', url, voice)).error, 'no_consent_or_opted_out');
  assert.strictEqual(m.sms.sent.length, 1);
  m = mk({ sms_enabled: false }); assert.strictEqual((await m.tools.run('send_link', url, voice)).error, 'texting_not_yet_enabled');
  m = mk({ approval_mode: true }); const r = await m.tools.run('send_link', url, voice); assert.ok(r.queued_for_approval); assert.strictEqual(m.sms.sent.length, 0);
});
test('transfer: in hours refers; after hours refuses; failure reported', async () => {
  let m = mk(); assert.ok((await m.tools.run('transfer_to_human', {}, voice)).transferred); assert.strictEqual(m.cc.refers[0].uri, 'tel:+15555550199');
  m = mk({}, { now: () => new Date('2026-10-30T02:00:00Z') }); assert.strictEqual((await m.tools.run('transfer_to_human', {}, voice)).error, 'after_hours'); assert.strictEqual(m.cc.refers.length, 0);
  m = mk({}, { referStatus: 502 }); assert.strictEqual((await m.tools.run('transfer_to_human', {}, voice)).error, 'transfer_failed');
  assert.strictEqual((await m.tools.run('transfer_to_human', {}, { channel: 'sms', caller: '+1' })).error, 'voice_only');
});
test('unknown / disabled tools and card numbers are refused; messages notify owner', async () => {
  const m = mk();
  assert.strictEqual((await m.tools.run('product_search', { query: 'x' }, voice)).error, 'unknown_tool'); // no shopify configured
  assert.strictEqual((await m.tools.run('charge_card', {}, voice)).error, 'unknown_tool');
  assert.strictEqual((await m.tools.run('take_message', { message: 'my card is 4111 1111 1111 1111' }, voice)).error, 'payment_details_refused');
  assert.ok((await m.tools.run('take_message', { message: 'call me back' }, voice)).saved); assert.strictEqual(m.notes.length, 1);
  assert.ok(!m.tools.definitions().some((d) => /pay|charge|checkout/.test(d.name)));
});
