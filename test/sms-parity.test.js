'use strict';
const test = require('node:test'); const assert = require('node:assert');
const path = require('path'); const fs = require('fs'); const os = require('os');
const { handleInboundSms, guardReply, XaiTextBrain, SmsMemory, buildSmsInstructions, SMS_MAX_CHARS } = require('../src/sms');
const { Tools, Approvals } = require('../src/tools');
const { Consent, MockTwilio } = require('../src/twilio');
const { MockCallControl } = require('../src/mocks');
const { KB } = require('../src/kb');
const { MockEmail } = require('../src/email');
const { Newsletter } = require('../src/newsletter');
const { SentMessages } = require('../src/messages');

const PH = '+17275550142';
function mk() {
  const t = { id: 'r', name: 'RF Safe', numbers: ['+17276775572'], link_allowlist: ['rfsafe.org', 'quantacase.com'], blocked_topics: [], sms_enabled: true, email_enabled: true, shopify: { shop: 'quantacase.com', mode: 'public' }, order_lookup_enabled: true, max_call_seconds: 900, extra_instructions: 'OWNER GUIDE: mention SAR charts.', hours: { tz: 'America/New_York', open: '00:00', close: '23:59', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smsp-'));
  const nl = new Newsletter({ secret: 'x'.repeat(32), file: path.join(dir, 'nl.jsonl') });
  const mail = new MockEmail(); const sent = new SentMessages({ file: path.join(dir, 'msgs.jsonl') });
  const tools = new Tools(t, { kbFor: () => new KB({ allowlist: t.link_allowlist }), shopifyFor: () => ({ orderStatus: async () => ({ ok: false, reason: 'not_found_or_not_verified' }), search: async () => [] }), smsFor: () => new MockTwilio(), consent: new Consent(null), callControl: new MockCallControl(), notify: async () => {}, approvals: new Approvals(), log: () => {}, emailFor: () => mail, newsletter: nl, sentMessages: sent });
  return { t, nl, mail, tools, sent, consent: new Consent(null) };
}

test('text brain: no 2-sentence cap, keeps history, max_tokens set, same KB/order/email tools, no voice-only tools', async () => {
  const m = mk(); const bodies = [];
  const fetchImpl = async (u, o) => { bodies.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'Full answer.' } }] }) }; };
  const brain = new XaiTextBrain({ apiKey: 'k', model: 'grok-4.3', fetchImpl });
  const mem = new SmsMemory();
  const run = (body) => handleInboundSms({ tenant: m.t, from: PH, body, consent: m.consent, toolsFor: () => m.tools, brain, instructions: buildSmsInstructions(m.t), log: () => {}, memory: mem });
  await run('What is SAR?'); await run('And for iPhone 17?');
  const b = bodies[1];
  assert.strictEqual(b.model, 'grok-4.3'); assert.ok(b.max_tokens >= 500);
  assert.doesNotMatch(b.messages[0].content, /at most 2 short sentences/);
  assert.deepStrictEqual(b.messages.slice(1).map((x) => x.content), ['What is SAR?', 'Full answer.', 'And for iPhone 17?']);
  const names = b.tools.map((x) => x.function.name);
  for (const n of ['kb_answer', 'product_search', 'website_lookup', 'order_status', 'set_email_address', 'send_email', 'take_message']) assert.ok(names.includes(n), n);
  for (const n of ['transfer_to_human', 'end_call', 'set_text_number']) assert.ok(!names.includes(n), n);
});
test('STOP clears memory and is answered without the model; HELP too', async () => {
  const m = mk(); const mem = new SmsMemory(); mem.push('r', PH, 'hi', 'hello'); let called = 0;
  const brain = { reply: async () => { called++; return 'x'; } };
  const r = await handleInboundSms({ tenant: m.t, from: PH, body: 'STOP', consent: m.consent, toolsFor: () => m.tools, brain, instructions: '', log: () => {}, memory: mem });
  assert.match(r, /unsubscribed/); assert.deepStrictEqual(mem.get('r', PH), []);
  assert.match(await handleInboundSms({ tenant: m.t, from: PH, body: 'HELP', consent: m.consent, toolsFor: () => m.tools, brain, instructions: '', log: () => {} }), /Reply STOP/);
  assert.strictEqual(called, 0);
});
test('memory expires and is per sender', () => {
  let t = 0; const mem = new SmsMemory({ now: () => t }); mem.push('r', PH, 'q', 'a');
  assert.strictEqual(mem.get('r', '+17275550000').length, 0); assert.strictEqual(mem.get('r', PH).length, 2);
  t = 7 * 3600 * 1000; assert.strictEqual(mem.get('r', PH).length, 0);
});
test('reply limit raised to multi-part length; off-allowlist links still removed', () => {
  const long = 'a'.repeat(1500); assert.strictEqual(guardReply(long, ['rfsafe.org']).length, SMS_MAX_CHARS);
  assert.ok(SMS_MAX_CHARS > 640 && SMS_MAX_CHARS <= 1600);
  assert.match(guardReply('see https://evil.example/x and https://rfsafe.org/a', ['rfsafe.org']), /\[link removed\].*https:\/\/rfsafe\.org\/a/);
});
test('SMS prompt carries the business guide, KB-only rule, and the subscriber lookup (name + email domain on file)', () => {
  const m = mk(); const s = buildSmsInstructions(m.t, { returning: { firstName: 'Ann', emailDomainSpoken: 'Gmail' } });
  assert.match(s, /OWNER GUIDE: mention SAR charts/); assert.match(s, /ONLY from kb_answer/); assert.match(s, /first name on file: Ann/); assert.match(s, /email on file at Gmail/);
  assert.doesNotMatch(s, /spoken-friendly/);
});
test('email works across two texts in one conversation; reply is archived with the inbound text', async () => {
  const m = mk(); let step = 0;
  const brain = { reply: async ({ tools }) => {
    if (step++ === 0) { const r = await tools.run('set_email_address', { email: 'ann@example.com', caller_said_yes: true }); return r.ok ? 'Got it.' : 'fail ' + r.error; }
    const r = await tools.run('send_email', { urls: ['https://rfsafe.org/a'], recipient_name: 'Ann' }); return r.ok ? 'Sent.' : 'fail ' + r.error;
  } };
  const archive = (r) => m.sent.add(r);
  const go = (body) => handleInboundSms({ tenant: m.t, from: PH, body, consent: m.consent, toolsFor: () => m.tools, brain, instructions: '', log: () => {}, memory: new SmsMemory(), archive });
  assert.strictEqual(await go('email me ann@example.com'), 'Got it.');
  assert.strictEqual(await go('send it'), 'Sent.');
  assert.strictEqual(m.mail.sent.pop().to, 'ann@example.com');
  const recs = m.sent.read().filter((x) => x.status === 'replied'); assert.strictEqual(recs.length, 2); assert.strictEqual(recs[1].inbound, 'send it'); assert.strictEqual(recs[1].to, PH);
});
test('voice-only tools are refused on SMS even if the model asks', async () => {
  const m = mk(); let out;
  await handleInboundSms({ tenant: m.t, from: PH, body: 'transfer me', consent: m.consent, toolsFor: () => m.tools, log: () => {}, instructions: '', brain: { reply: async ({ tools }) => { out = await tools.run('transfer_to_human', {}); return 'ok'; } } });
  assert.strictEqual(out.error, 'voice_only');
});
