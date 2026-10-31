'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { handleInboundSms, fixLeakedInstructions, XaiTextBrain, buildSmsInstructions } = require('../src/sms');
const { Tools, Approvals } = require('../src/tools');
const { Consent, MockTwilio } = require('../src/twilio');
const { MockCallControl } = require('../src/mocks');
const { SarCatalog } = require('../src/sar');
const { KB } = require('../src/kb');

const rows = [
  { id: '1', brand: 'Apple', model: 'iPhone 17', post_name: 'Apple iPhone 17', ushead: '1.10', usbody: '1.20' },
  { id: '2', brand: 'Samsung', model: 'Galaxy A14', post_name: 'Samsung Galaxy A14', ushead: '0.48', usbody: '0.52', releasedate: '2023-02-27 04:46:44' },
  { id: '3', brand: 'Samsung', model: 'Galaxy X', post_name: 'Samsung Galaxy X', ushead: '0.30', usbody: '1.40' },
  { id: '4', brand: 'Moto', model: 'Z', post_name: 'Moto Z', ushead: '', usbody: '0.2' },
];
const sar = new SarCatalog({ fetchImpl: async () => ({ ok: true, json: async () => rows }) });
const T = { id: 'r', name: 'RF Safe', numbers: ['+17276775572'], link_allowlist: ['rfsafe.org', 'www.rfsafe.org', 'quantacase.com'], blocked_topics: [], sms_enabled: true, sar_lookup: true, extra_instructions: 'If the knowledge base has nothing, say you do not have that detail and offer to take a message.' };
const mkTools = () => new Tools(T, { kbFor: () => new KB({ allowlist: T.link_allowlist }), sarFor: () => sar, smsFor: () => new MockTwilio(), consent: new Consent(null), callControl: new MockCallControl(), notify: async () => {}, approvals: new Approvals(), log: () => {} });

test('sar catalog: lowest() ranks by combined head+body, skips missing values, brand filter', async () => {
  const r = await sar.lowest({});
  assert.deepStrictEqual(r.phones.map((p) => p.phone), ['Samsung Galaxy A14', 'Samsung Galaxy X', 'Apple iPhone 17']);
  assert.strictEqual(r.ranking, 'https://rfsafe.org/mel/RANK.php');
  assert.strictEqual((await sar.lowest({ metric: 'head' })).phones[0].phone, 'Samsung Galaxy X');
  assert.strictEqual((await sar.lowest({ brand: 'apple' })).phones[0].phone, 'Apple iPhone 17');
});

test('sar_ranking tool is offered to texts and returns real catalog data', async () => {
  const tools = mkTools();
  assert.ok(tools.definitions().some((d) => d.name === 'sar_ranking'));
  const out = await tools.ctxCall({ channel: 'sms', caller: '+17275550142', callId: 'x' }).run('sar_ranking', { limit: 2 });
  assert.ok(out.ok); assert.strictEqual(out.phones.length, 2); assert.strictEqual(out.phones[0].head_cellular, 0.48);
});

test('SMS prompt: tool say/guidance are private notes never to be copied; lowest SAR -> sar_ranking', () => {
  const s = buildSmsInstructions(T);
  assert.match(s, /NEVER copy them into the reply/); assert.match(s, /call sar_ranking/);
});

test('leaked tool instructions are rewritten, normal replies untouched', () => {
  const leak = 'I do not have that detail yet. Offer to take a message or text a link to rfsafe.org.';
  const fixed = fixLeakedInstructions(leak);
  assert.doesNotMatch(fixed, /Offer to/i); assert.match(fixed, /pass your question to the RF Safe team/);
  const ok = 'The Samsung Galaxy A14 has 0.48 W/kg head SAR. I can also send the ranking: https://rfsafe.org/mel/RANK.php';
  assert.strictEqual(fixLeakedInstructions(ok), ok);
  assert.doesNotMatch(fixLeakedInstructions('Sure. Ask for the exact model name, or offer to text the SAR lookup page.'), /Ask for|offer to/i);
});

test('end to end: "what is the lowest radiation phone?" uses sar_ranking over SMS and a leaked reply is cleaned', async () => {
  let step = 0; const seen = [];
  const fetchImpl = async (u, o) => { const b = JSON.parse(o.body); seen.push(b); step++;
    if (step === 1) return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'sar_ranking', arguments: '{"limit":3}' } }] } }] }) };
    return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'Lowest SAR: Samsung Galaxy A14 (head 0.48, body 0.52 W/kg). Offer to text the ranking page.' } }] }) }; };
  const brain = new XaiTextBrain({ apiKey: 'k', fetchImpl });
  assert.strictEqual(brain.model, 'grok-4.7');
  const tools = mkTools();
  const reply = await handleInboundSms({ tenant: T, from: '+17275550142', body: 'what is the lowest radiation phone?', consent: new Consent(null), toolsFor: () => tools, brain, instructions: buildSmsInstructions(T), log: () => {} });
  assert.ok(seen[0].tools.some((t) => t.function.name === 'sar_ranking'));
  const toolMsg = seen[1].messages.find((m) => m.role === 'tool'); assert.match(toolMsg.content, /Samsung Galaxy A14/);
  assert.match(reply, /Galaxy A14/); assert.doesNotMatch(reply, /Offer to/);
});
