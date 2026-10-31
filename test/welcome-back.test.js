'use strict';
const test = require('node:test'); const assert = require('node:assert');
const path = require('path'); const fs = require('fs'); const os = require('os');
const { CallSession, welcomeBack } = require('../src/xai');
const { Tools, Approvals } = require('../src/tools');
const { MockRealtimeWs, MockCallControl } = require('../src/mocks');
const { Newsletter } = require('../src/newsletter');
const { renderPrivacy } = require('../src/legal');
const { startApp } = require('./helpers');

const T = { id: 'r', name: 'RF Safe', numbers: ['+17276775572'], link_allowlist: ['rfsafe.org'], blocked_topics: [], sms_enabled: true, hours: { tz: 'America/New_York', open: '00:00', close: '23:59', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] }, max_call_seconds: 900,
  disclosure: 'Hi, you have reached {name}. This call may be recorded and is answered by an AI assistant.', known_callers: { '+17276101188': { name: 'Katie' } } };
const NAMED = '+15550001111', NONAME = '+15550002222', SMSONLY = '+15550003333', STRANGER = '+15550009999';
function nl() {
  const n = new Newsletter({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-')), 'nl.jsonl'), secret: 'x' });
  n.record({ e: 'jane@example.com', n: 'Jane Q Public', t: 'r' }, 'confirmed'); n.linkPhone({ tenant: 'r', email: 'jane@example.com', phone: NAMED });
  n.record({ e: 'anon@example.com', n: '', t: 'r' }, 'confirmed'); n.linkPhone({ tenant: 'r', email: 'anon@example.com', phone: NONAME });
  n.requestSms({ tenant: 'r', phone: SMSONLY, wording: { text: 'x' } }); n.confirmSms('r', SMSONLY, 'YES');
  n.record({ e: 'gone@example.com', n: 'Gone', t: 'r' }, 'confirmed'); n.record({ e: 'gone@example.com', t: 'r' }, 'unsubscribed'); n.linkPhone({ tenant: 'r', email: 'gone@example.com', phone: STRANGER });
  return n;
}
function start(caller, { tenant = T, newsletter = nl() } = {}) {
  const ws = new MockRealtimeWs(); let summary;
  const tools = new Tools(tenant, { kbFor: () => null, shopifyFor: () => null, approvals: new Approvals(), callControl: new MockCallControl(), log: () => {}, now: () => new Date('2026-10-31T04:00:00Z') });
  const s = new CallSession({ ws, tenant, callId: 'c1', caller, tools, afterHours: false, log: () => {}, newsletter, onEnd: (x) => { summary = x; } }); clearTimeout(s.timer);
  return { s, end: () => { s.finish(); return summary; }, instr: ws.sent.find((m) => m.type === 'session.update').session.instructions, greet: ws.sent.find((m) => m.item && m.item.type === 'force_message').item.content[0].text };
}

test('returning subscriber greeted with first name only; no name -> plain welcome back', () => {
  assert.strictEqual(start(NAMED).greet, 'Welcome back, Jane! How can I help?');
  assert.strictEqual(start(NONAME).greet, 'Welcome back! How can I help?');
  assert.strictEqual(start(SMSONLY).greet, 'Welcome back! How can I help?');
  assert.strictEqual(welcomeBack(null), 'Welcome back! How can I help?');
});
test('no match, unsubscribed, blocked, anonymous or invalid caller ID keeps the standard greeting', () => {
  for (const c of [STRANGER, null, '', 'anonymous', '5550001111', '+0123', 'sip:x@y']) assert.match(start(c).greet, /^Hi, you have reached RF Safe\. This call may be recorded/, String(c));
});
test('guardrails in instructions: no read-back from caller ID, not-them handling, no email or number leaked', () => {
  const i = start(NAMED).instr;
  assert.match(i, /never read back or confirm any email, phone number/); assert.match(i, /only confirm a detail if the caller states it first/);
  assert.match(i, /says it is not them, apologize lightly/); assert.match(i, /do not change any record/);
  assert.doesNotMatch(i, /jane@example\.com|5550001111|Public/);
  assert.doesNotMatch(start(STRANGER).instr, /returning RF Safe subscriber/);
});
test('toggle off keeps the normal greeting; known callers keep their own greeting', () => {
  assert.match(start(NAMED, { tenant: { ...T, returning_caller_greeting: false } }).greet, /may be recorded/);
  assert.strictEqual(start('+17276101188').greet, 'Hi Katie, how can I help you?');
  assert.match(start(NAMED, { newsletter: null }).greet, /may be recorded/);
});
test('call log marks returning_caller only for matches; lookup does not change the record', () => {
  const n = nl(); const before = fs.readFileSync(n.file, 'utf8');
  assert.strictEqual(start(NAMED, { newsletter: n }).end().returning_caller, true);
  assert.strictEqual(start(STRANGER, { newsletter: n }).end().returning_caller, undefined);
  assert.strictEqual(fs.readFileSync(n.file, 'utf8'), before);
});
test('privacy page mentions first-name greeting for recognized callers', () => {
  assert.match(renderPrivacy(), /callers we recognize by phone number \(caller ID\) may be greeted by first name/);
});
test('PATCH accepts boolean returning_caller_greeting only', async () => {
  const a = await startApp();
  try {
    const tok = a.deps.adminToken || process.env.ADMIN_TOKEN; if (!tok) return;
    const patch = (body) => fetch(a.base + '/admin/tenants/rfsafe-demo', { method: 'PATCH', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.strictEqual((await patch({ returning_caller_greeting: 'no' })).status, 400);
    assert.strictEqual((await patch({ returning_caller_greeting: false })).status, 200);
    assert.strictEqual(a.deps.tenants.get('rfsafe-demo').returning_caller_greeting, false);
  } finally { await a.close(); }
});
