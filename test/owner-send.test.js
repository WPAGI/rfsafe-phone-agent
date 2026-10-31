'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createOwner } = require('../src/owner');
const { PinStore } = require('../src/owner/pin');
const { Consent, MockTwilio } = require('../src/twilio');
const { MockEmail } = require('../src/email');

const KATIE = '+17276101188', OTHER = '+17275550142';
function setup({ email = 'katie@example.org', sms = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-send-'));
  const t = { id: 'rf', name: 'RF Safe', numbers: ['+17276775572'], sms_enabled: sms, link_allowlist: ['rfsafe.org'], known_callers: { [KATIE]: { name: 'Katie' } }, owner_briefing: { enabled: true, on_demand: true, owner_numbers: [KATIE] } };
  const sent = []; const smsT = new MockTwilio(); const mail = new MockEmail();
  const gaps = path.join(dir, 'gaps.jsonl');
  fs.writeFileSync(gaps, JSON.stringify({ at: new Date().toISOString(), tenant: 'rf', question: 'Call me at 727-555-0142 or bob@x.com about SAR', channel: 'sms', from_last4: '0142' }) + '\n');
  const d = { callLog: path.join(dir, 'calls.jsonl'), kbGapFile: gaps, ownerPins: new PinStore({ file: path.join(dir, 'pins.json') }), consent: new Consent(null), smsFor: () => smsT, emailFor: () => mail, sentMessages: { add: (r) => sent.push(r) },
    newsletter: { emailOnFile: (tid, phone) => (tid === 'rf' && phone === KATIE ? email : null) } };
  const owner = createOwner(d); owner.pins.set('rf', '4821');
  const base = { tenant: t, definitions: () => [{ type: 'function', name: 'end_call' }, { type: 'function', name: 'transfer_to_human' }], run: async () => ({ ok: true }) };
  base.ctxCall = (ctx) => ({ run: (n, a) => base.run(n, a, ctx) });
  const audit = () => fs.readFileSync(path.join(dir, 'owner-audit.jsonl'), 'utf8');
  return { t, d, owner, base, sent, smsT, mail, audit };
}
const names = (tools) => tools.definitions().map((x) => x.name);
const ALL = { include: ['briefing', 'unanswered'], asked_anything_else: true };

test('grok owner session: send tools hidden and refused before the PIN, unlocked after', async () => {
  const s = setup(); const g = s.owner.grokSession(s.t, { to: KATIE, kind: 'daily' }, s.base);
  assert.deepStrictEqual(names(g.tools), ['owner_briefing', 'end_call']);
  assert.strictEqual((await g.tools.run('owner_send_email', ALL, {})).error, 'unknown_tool');
  assert.strictEqual((await g.tools.run('owner_send_text', ALL, {})).error, 'unknown_tool');
  assert.strictEqual((await g.tools.run('owner_briefing', { pin: '0000' }, {})).ok, false);
  assert.ok(!names(g.tools).includes('owner_send_email'));
  const ok = await g.tools.run('owner_briefing', { pin: '4821' }, {});
  assert.deepStrictEqual(ok.tools_now_available, ['owner_send_email', 'owner_send_text']);
  assert.deepStrictEqual(names(g.tools), ['owner_briefing', 'end_call', 'owner_send_email', 'owner_send_text']);
  assert.ok(!(await g.tools.run('owner_briefing', {}, {})).tools_now_available);
  assert.match(g.instructions, /owner_send_email/); assert.match(g.instructions, /Anything else you'd like me to include/);
  assert.strictEqual(s.mail.sent.length + s.smsT.sent.length, 0);
});

test('email goes only to the email on file for the call number; caller-supplied address ignored; domain only', async () => {
  const s = setup(); const g = s.owner.grokSession(s.t, { to: KATIE, kind: 'daily' }, s.base);
  await g.tools.run('owner_briefing', { pin: '4821' }, {});
  const r = await g.tools.run('owner_send_email', { ...ALL, to: 'evil@attacker.com', email: 'evil@attacker.com', include: ['briefing', 'unanswered', 'note'], note: 'Follow up on the PIN 4821 and call 7275550142' }, {});
  assert.strictEqual(r.ok, true); assert.strictEqual(r.domain, 'example.org'); assert.doesNotMatch(JSON.stringify(r), /katie@/);
  assert.strictEqual(s.mail.sent.length, 1); assert.strictEqual(s.mail.sent[0].to, 'katie@example.org');
  const body = s.mail.sent[0].text;
  assert.match(body, /Here is today's summary/); assert.match(body, /Unanswered questions:/); assert.match(body, /Follow up/);
  assert.doesNotMatch(body, /4821|bob@x\.com|727-555-0142|7275550142/); assert.match(body, /number ending 0142/);
  assert.match(s.audit(), /"action":"owner_send_email"/); assert.doesNotMatch(s.audit(), /katie@example/);
  assert.strictEqual(s.sent[0].kind, 'owner_send');
});

test('missing email on file: says so, nothing sent', async () => {
  const s = setup({ email: null }); const g = s.owner.grokSession(s.t, { to: KATIE, kind: 'daily' }, s.base);
  await g.tools.run('owner_briefing', { pin: '4821' }, {});
  const r = await g.tools.run('owner_send_email', ALL, {});
  assert.strictEqual(r.error, 'no_email_on_file'); assert.match(r.say, /no email on file/i); assert.strictEqual(s.mail.sent.length, 0);
  assert.match(s.audit(), /owner_send_email_skipped/);
});

test('text goes only to the owner number on the call, bundled into one message', async () => {
  const s = setup(); const g = s.owner.grokSession(s.t, { to: KATIE, kind: 'daily' }, s.base);
  await g.tools.run('owner_briefing', { pin: '4821' }, {});
  const r = await g.tools.run('owner_send_text', { ...ALL, to: OTHER }, {});
  assert.strictEqual(r.ok, true); assert.strictEqual(r.to_last4, '1188');
  assert.strictEqual(s.smsT.sent.length, 1); assert.strictEqual(s.smsT.sent[0].to, KATIE);
  assert.match(s.smsT.sent[0].body, /today's summary[\s\S]*Unanswered questions:/);
});

test('bundling: must ask "anything else?" first; exact duplicates refused', async () => {
  const s = setup(); const g = s.owner.grokSession(s.t, { to: KATIE, kind: 'daily' }, s.base);
  await g.tools.run('owner_briefing', { pin: '4821' }, {});
  assert.strictEqual((await g.tools.run('owner_send_email', { include: ['briefing'] }, {})).error, 'ask_first');
  assert.strictEqual((await g.tools.run('owner_send_email', { include: [], asked_anything_else: true }, {})).error, 'nothing_to_send');
  assert.strictEqual((await g.tools.run('owner_send_email', ALL, {})).ok, true);
  assert.strictEqual((await g.tools.run('owner_send_email', ALL, {})).error, 'duplicate');
  assert.strictEqual(s.mail.sent.length, 1);
});

test('rate limit: 3 emails and 3 texts per session, logged', async () => {
  const s = setup(); const g = s.owner.grokSession(s.t, { to: KATIE, kind: 'daily' }, s.base);
  await g.tools.run('owner_briefing', { pin: '4821' }, {});
  for (const k of ['owner_send_email', 'owner_send_text']) {
    for (let i = 0; i < 3; i++) assert.strictEqual((await g.tools.run(k, { include: ['note'], note: 'item ' + 'abc'[i], asked_anything_else: true }, {})).ok, true);
    assert.match((await g.tools.run(k, { include: ['note'], note: 'one more', asked_anything_else: true }, {})).error, /_limit_reached$/);
  }
  assert.strictEqual(s.mail.sent.length, 3); assert.strictEqual(s.smsT.sent.length, 3);
  assert.match(s.audit(), /owner_send_limited/);
  // a new session gets a fresh allowance
  const g2 = s.owner.grokSession(s.t, { to: KATIE, kind: 'daily' }, s.base); await g2.tools.run('owner_briefing', { pin: '4821' }, {});
  assert.strictEqual((await g2.tools.run('owner_send_text', { include: ['note'], note: 'new', asked_anything_else: true }, {})).ok, true);
});

test('opted-out owner number: no text', async () => {
  const s = setup(); s.d.consent.record('rf', KATIE, 'stop'); const g = s.owner.grokSession(s.t, { to: KATIE, kind: 'daily' }, s.base);
  await g.tools.run('owner_briefing', { pin: '4821' }, {});
  assert.strictEqual((await g.tools.run('owner_send_text', ALL, {})).error, 'opted_out'); assert.strictEqual(s.smsT.sent.length, 0);
});

test('inbound owner call: tools only after PIN, recipients fixed; non-owner callers never get them', async () => {
  const s = setup(); const w = s.owner.wrapTools(s.t, KATIE, s.base); const ctx = { channel: 'voice', caller: KATIE, callId: 'c1' };
  assert.ok(!names(w).includes('owner_send_email'));
  assert.strictEqual((await w.run('owner_send_email', ALL, ctx)).error, 'unknown_tool');
  const ok = await w.run('owner_briefing', { pin: '4821' }, ctx); assert.ok(ok.tools_now_available);
  assert.ok(names(w).includes('owner_send_email') && names(w).includes('owner_send_text'));
  assert.strictEqual((await w.run('owner_send_email', ALL, ctx)).ok, true); assert.strictEqual(s.mail.sent[0].to, 'katie@example.org');
  assert.strictEqual((await w.run('owner_send_text', ALL, { ...ctx, caller: OTHER })).error, 'unknown_tool');
  const x = s.owner.wrapTools(s.t, OTHER, s.base);
  assert.ok(!names(x).includes('owner_send_email'));
  assert.strictEqual((await x.run('owner_send_text', ALL, { channel: 'voice', caller: OTHER })).error, 'unknown_tool');
});
