'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { CallSession, knownCallerFor } = require('../src/xai');
const { validateTenant } = require('../src/tenants');
const { Tools, Approvals } = require('../src/tools');
const { MockRealtimeWs, MockCallControl } = require('../src/mocks');

const KATIE = { name: 'Katie', role: 'owner and phone-system administrator' };
const T = { id: 'r', name: 'RF Safe', numbers: ['+17276775572'], link_allowlist: ['rfsafe.org'], blocked_topics: [], sms_enabled: false, transfer_target: 'tel:+17276101188', hours: { tz: 'America/New_York', open: '00:00', close: '23:59', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] }, max_call_seconds: 900,
  disclosure: 'Hi, you have reached {name}. This call may be recorded and is answered by an AI assistant.', known_callers: { '+17276101188': KATIE, '+17273540485': KATIE } };
function start(caller, tenant = T) {
  const ws = new MockRealtimeWs(); const cc = new MockCallControl();
  const tools = new Tools(tenant, { kbFor: () => null, shopifyFor: () => null, approvals: new Approvals(), callControl: cc, log: () => {}, now: () => new Date('2026-10-29T14:00:00Z') });
  const s = new CallSession({ ws, tenant, callId: 'c1', caller, tools, afterHours: false, log: () => {} }); clearTimeout(s.timer);
  return { ws, tools, cc, upd: ws.sent.find((m) => m.type === 'session.update'), greet: ws.sent.find((m) => m.item && m.item.type === 'force_message').item.content[0].text };
}

test('known caller greeted by name from either number; others get the standard disclosure', () => {
  for (const n of ['+17276101188', '+17273540485']) assert.strictEqual(start(n).greet, 'Hi Katie, how can I help you?');
  assert.match(start('+17275550142').greet, /^Hi, you have reached RF Safe\. This call may be recorded/);
  assert.match(start(null).greet, /may be recorded/);
  const k = start('+17273540485').upd.session.instructions;
  assert.match(k, /known caller: Katie \(owner and phone-system administrator\)/); assert.match(k, /can be spoofed/); assert.match(k, /do not skip order verification/);
  assert.doesNotMatch(start('+17275550142').upd.session.instructions, /Katie/);
});
test('known caller who is the transfer target: no transfer tool, no self-transfer; other number still can transfer', async () => {
  const self = start('+17276101188');
  assert.ok(!self.upd.session.tools.some((d) => d.name === 'transfer_to_human'));
  assert.match(self.upd.session.instructions, /Do not offer to transfer Katie to themselves/);
  assert.doesNotMatch(self.upd.session.instructions, /use transfer_to_human/);
  const r = await self.tools.run('transfer_to_human', {}, { channel: 'voice', callId: 'c1', caller: '+17276101188' });
  assert.strictEqual(r.error, 'caller_is_transfer_target'); assert.strictEqual(self.cc.refers.length, 0);
  const other = start('+17273540485');
  assert.ok(other.upd.session.tools.some((d) => d.name === 'transfer_to_human'));
  assert.deepStrictEqual(knownCallerFor(T, '+17273540485').isTransferTarget, false);
});
test('known caller gets no extra powers: same tool list and same order verification', () => {
  const t = { ...T, shopify: { shop: 'quantacase.com', mode: 'public' }, order_lookup_enabled: true };
  const names = (c) => start(c, t).upd.session.tools.map((d) => d.name).filter((n) => n !== 'transfer_to_human').sort();
  assert.deepStrictEqual(names('+17273540485'), names('+17275550142'));
});
test('known_callers config is validated', () => {
  const base = { id: 'abc', name: 'A', numbers: ['+17276775572'], link_allowlist: ['a.com'] };
  assert.deepStrictEqual(validateTenant({ ...base, known_callers: { '+17276101188': KATIE } }), []);
  assert.ok(validateTenant({ ...base, known_callers: { '7276101188': KATIE } }).length);
  assert.ok(validateTenant({ ...base, known_callers: { '+17276101188': { name: '' } } }).length);
  assert.ok(validateTenant({ ...base, known_callers: { '+17276101188': { name: 'K', admin: true } } }).length);
  assert.ok(validateTenant({ ...base, known_callers: [] }).length);
  assert.ok(validateTenant({ ...base, support_email: 'nope' }).length);
});
test('admin: PATCH known_callers/support_email; GET config shows fields without secret refs', async () => {
  const { startApp } = require('./helpers'); const a = await startApp(); const id = a.deps.tenants.list()[0].id;
  const auth = { authorization: 'Bearer ' + a.deps.adminToken, 'content-type': 'application/json' };
  try {
    let r = await fetch(a.base + '/admin/tenants/' + id, { method: 'PATCH', headers: auth, body: JSON.stringify({ known_callers: { '+17276101188': KATIE }, support_email: 'support@quantaxtechnology.com' }) }); assert.strictEqual(r.status, 200);
    r = await fetch(a.base + '/admin/tenants/' + id, { method: 'PATCH', headers: auth, body: JSON.stringify({ known_callers: { '+17276101188': { name: 'K', can_skip_checks: true } } }) }); assert.strictEqual(r.status, 400);
    r = await fetch(a.base + '/admin/tenants/' + id + '/config', { headers: auth }); const j = await r.json();
    assert.strictEqual(j.config.known_callers['+17276101188'].name, 'Katie'); assert.ok(Array.isArray(j.config.secrets)); assert.ok(!JSON.stringify(j).includes('env:'));
    assert.strictEqual((await fetch(a.base + '/admin/tenants/' + id + '/config')).status, 401);
  } finally { await a.close(); }
});
