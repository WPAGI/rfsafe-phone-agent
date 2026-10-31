'use strict';
// Regression for call b42355c3 (2026-10-31 02:25Z): texting was on, but the owner's free-text guide still said
// "Texting is not turned on yet", so the bot refused texts; and the call log row had no topics or text request.
const test = require('node:test'); const assert = require('node:assert');
const { buildInstructions, toolDetail } = require('../src/xai');
const { Tools: ToolRunner } = require('../src/tools');
const adm = require('../src/admin');
// Shape of the live rfsafe tenant (values trimmed; no secrets).
const live = {
  id: 'rfsafe', name: 'RF Safe', link_allowlist: ['rfsafe.org', 'quantacase.com'], blocked_topics: [],
  sms_enabled: true, email_enabled: true, order_lookup_enabled: true, sar_lookup: true, shopify: { mode: 'live' },
  twilio: { messaging_service_sid: 'MG' + '0'.repeat(32) }, numbers: ['+17276775572'],
  extra_instructions: 'Never read a URL or PMID aloud. Say the site name only, like "rfsafe.org" or "quantacase.com", and offer to text the exact link. Texting is not turned on yet: say so, and offer to take a message instead.',
};
test('sms on: live settings line comes after the owner guide and overrides stale "texting not on" wording', () => {
  const ins = buildInstructions(live, { afterHours: false, callerLast4: '0485' });
  const g = ins.indexOf('Texting is not turned on yet'); const o = ins.indexOf('texting IS switched on');
  assert.ok(g > 0 && o > g, 'override must follow the guide');
  assert.match(ins, /override anything in the business guide/);
  assert.match(ins, /set_text_number/);
});
test('sms on: text tools are exposed to the session', () => {
  const names = new ToolRunner(live, { sarFor: () => ({}), emailFor: () => ({}) }).definitions().map((d) => d.name);
  for (const n of ['set_text_number', 'send_link', 'send_link_sms', 'set_email_address', 'send_email']) assert.ok(names.includes(n), n);
});
test('sms off: settings line says do not offer texts', () => {
  const ins = buildInstructions({ ...live, sms_enabled: false }, { afterHours: false, callerLast4: '0485' });
  assert.match(ins, /texting is NOT switched on/); assert.doesNotMatch(ins, /texting IS switched on/);
});
test('call record: b42355c3-shaped call captures caller, topics and the unmet text request', () => {
  const tools = [toolDetail('sar_lookup', { phone: 'iPhone 17 Pro' }, { ok: true }), toolDetail('product_search', { query: 'phone case' }, { ok: true }), toolDetail('end_call', {}, { ok: true })];
  const r = adm.callRecord({ call: 'b42355c3', tenant: 'rfsafe', started_at: '2026-10-31T02:25:30Z', seconds: 80, tools }, '+15550100485', '2026-10-31T02:26:50Z',
    [{ role: 'caller', text: 'Can you text me that link?' }, { role: 'agent', text: 'Sure' }]);
  assert.strictEqual(r.caller, '+15550100485');
  assert.match(r.summary, /SAR: iPhone 17 Pro/); assert.match(r.summary, /Product: phone case/);
  assert.match(r.texts, /requested, none sent/); assert.match(r.summary, /Text requested/);
  const row = adm.callCsvRows([r])[0]; assert.ok(adm.CALL_COLS.includes('texts')); assert.match(row.texts, /requested/);
});
test('call record: failed or refused tools are recorded with their error', () => {
  const tools = [toolDetail('set_text_number', { use_caller_id: true }, { ok: true }), toolDetail('send_link_sms', { url: 'https://rfsafe.org' }, { ok: false, error: 'texting_not_yet_enabled' }), toolDetail('send_email', { topic: 'Li-Fi' }, { ok: false, error: 'send_failed' })];
  const r = adm.callRecord({ tenant: 'rfsafe', tools }, null, '2026-10-31T00:00:00Z', []);
  assert.match(r.texts, /failed: texting_not_yet_enabled/); assert.match(r.summary, /send_email failed \(send_failed\)/); assert.match(r.summary, /Li-Fi/);
  const ok = adm.callRecord({ tenant: 'rfsafe', tools: [toolDetail('send_link_sms', { url: 'x' }, { ok: true })] }, null, 'x', []);
  assert.strictEqual(ok.texts, 'sent 1');
});
