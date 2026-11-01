'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { answerSms, handleInboundSms, buildSmsInstructions, SmsMemory, EMAIL_OFFER, CANNED, XaiTextBrain } = require('../src/sms');
const { Consent, twilioSignature } = require('../src/twilio');
const { startApp, ENV } = require('./helpers');

const T = { id: 'r', name: 'RF Safe', numbers: ['+17276775572'], link_allowlist: ['rfsafe.org', 'quantacase.com'], blocked_topics: [], sms_enabled: true, email_enabled: true };
const P = { text: 'RF Safe holds that the FCC limits are outdated. They were set in 1996 for heating only. Independent studies show non-thermal effects. A fourth sentence here.', source: 'https://rfsafe.org/fcc-limits' };
// Stub tool set: kb_answer finds P unless empty; records calls.
const stubTools = ({ found = true } = {}) => { const calls = []; const view = { calls, ctxCall: () => ({ run: async (n, a) => { calls.push([n, a]); if (n === 'kb_answer') return found ? { ok: true, found: true, passages: [P] } : { ok: true, found: false, passages: [] }; if (n === 'product_search') return { ok: true, products: [{ title: 'QuantaCase iPhone 17', price: '39.99', available: true, url: 'https://quantacase.com/products/iphone-17' }] }; return { ok: false }; } }), definitions: () => ['kb_answer', 'product_search', 'set_email_address', 'send_email'].map((name) => ({ name, description: '', parameters: {} })) }; return view; };
const base = (o = {}) => ({ tenant: T, from: '+17275550142', toolsFor: () => o.tools || stubTools(), instructions: 'SYS', log: (e, f) => (o.logs || []).push({ e, ...f }), ...o });

test('slow (~12 s scaled) brain still answers: no 8 s abort on the SMS path', async () => {
  const brain = { reply: () => new Promise((r) => setTimeout(() => r('FCC limits are heating-only. More: https://rfsafe.org/fcc-limits'), 120)) }; // 12 s at 1/100 scale
  const reply = await answerSms({ ...base(), text: 'are FCC limits safe?', brain, brainTimeoutMs: 600 }); // 60 s cap at the same scale
  assert.match(reply, /heating-only/);
});

test('brain timeout falls back to the top KB passage + link, logs type and duration, not the canned line', async () => {
  const logs = []; const brain = { reply: () => new Promise(() => {}) };
  const reply = await answerSms({ ...base({ logs }), text: 'are FCC limits safe?', brain, brainTimeoutMs: 30 });
  assert.notStrictEqual(reply, CANNED); assert.match(reply, /FCC limits are outdated/); assert.match(reply, /rfsafe\.org\/fcc-limits/);
  const err = logs.find((l) => l.e === 'sms.brain_error'); assert.strictEqual(err.err_type, 'TimeoutError'); assert.ok(err.ms >= 25); assert.strictEqual(err.fallback, 'kb');
  const none = await answerSms({ ...base({ tools: stubTools({ found: false }) }), text: 'zzz', brain: { reply: async () => { throw new Error('xai 500'); } } });
  assert.strictEqual(none, CANNED);
});

test('KB (and product search for phone/case texts) runs before the model and lands in the system message', async () => {
  const tools = stubTools(); let sys = '';
  await answerSms({ ...base({ tools }), text: 'do you have a case for iphone 17?', brain: { reply: async (a) => { sys = a.instructions; return 'Yes.'; } } });
  assert.deepStrictEqual(tools.calls.map((c) => c[0]), ['kb_answer', 'product_search']);
  assert.match(sys, /^SYS/); assert.match(sys, /FCC limits are outdated/); assert.match(sys, /QuantaCase iPhone 17/);
});

test('a long answer becomes a short summary plus the email offer; prompt allows set_email_address/send_email', async () => {
  const long = 'RF Safe\'s position is that the limits are outdated. ' + 'More detail follows here. '.repeat(60) + 'https://rfsafe.org/fcc-limits';
  const reply = await answerSms({ ...base(), text: 'explain FCC limits', brain: { reply: async () => long } });
  assert.ok(reply.length < 700); assert.ok(reply.endsWith(EMAIL_OFFER)); assert.match(reply, /rfsafe\.org\/fcc-limits/);
  const s = buildSmsInstructions(T); assert.match(s, /set_email_address/); assert.match(s, /ONLY from kb_answer \/ website_lookup/);
  assert.doesNotMatch(buildSmsInstructions({ ...T, email_enabled: false }), /fuller write-up/);
});

test('the user turn is kept in memory even when the brain fails', async () => {
  const memory = new SmsMemory();
  await handleInboundSms({ ...base(), body: 'are FCC limits safe?', consent: new Consent(null), memory, brain: { reply: async () => { throw new Error('This operation was aborted'); } } });
  const h = memory.get('r', '+17275550142'); assert.strictEqual(h[0].content, 'are FCC limits safe?'); assert.strictEqual(h[0].role, 'user');
});

test('XaiTextBrain: chat POST is marked idempotent (one retry on 429/5xx) and the tool loop is capped', async () => {
  const seen = []; const b = new XaiTextBrain({ apiKey: 'k', loopMs: -1, fetchImpl: async (u, o) => { seen.push(o); return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }; } });
  await assert.rejects(b.reply({ tools: { definitions: () => [] }, text: 'hi', instructions: '' }), /tool loop/);
  const b2 = new XaiTextBrain({ apiKey: 'k', fetchImpl: async (u, o) => { seen.push(o); return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }; } });
  await b2.reply({ tools: { definitions: () => [] }, text: 'hi', instructions: '' }); assert.strictEqual(seen.at(-1).idempotent, true);
});

test('webhook answers with empty TwiML in under 1 s while a slow brain is still thinking; reply then goes out by REST', async () => {
  const a = await startApp(); a.deps.smsHoldMs = 0;
  let release; a.deps.brain = { reply: () => new Promise((r) => { release = () => r('FCC limits are heating-only.'); }) };
  try {
    const p = { From: '+17275550188', To: '+17275550100', Body: 'are FCC limits safe?' };
    const t0 = Date.now();
    const r = await fetch(a.base + '/twilio/sms', { method: 'POST', body: new URLSearchParams(p), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(ENV.DEMO_TWILIO_AUTH_TOKEN, a.base + '/twilio/sms', p) } });
    const x = await r.text(); assert.ok(Date.now() - t0 < 1000); assert.strictEqual(r.status, 200); assert.doesNotMatch(x, /<Message>/);
    while (!release) await new Promise((s) => setTimeout(s, 5));
    release(); await a.app.smsIdle();
    const tw = a.deps.smsFor(a.deps.tenants.get('rfsafe-demo')); assert.strictEqual(tw.sent.at(-1).body, 'FCC limits are heating-only.'); assert.strictEqual(tw.sent.at(-1).to, '+17275550188');
    assert.ok(a.logs.some((l) => l.e === 'sms.replied' && l.async));
  } finally { await a.close(); }
});

test('webhook sends "Looking that up…" when nothing is ready after the hold time', async () => {
  const a = await startApp(); a.deps.smsHoldMs = 20;
  a.deps.brain = { reply: () => new Promise((r) => setTimeout(() => r('Done.'), 80)) };
  try {
    const p = { From: '+17275550189', To: '+17275550100', Body: 'tell me about SAR' };
    await (await fetch(a.base + '/twilio/sms', { method: 'POST', body: new URLSearchParams(p), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(ENV.DEMO_TWILIO_AUTH_TOKEN, a.base + '/twilio/sms', p) } })).text();
    await a.app.smsIdle();
    const bodies = a.deps.smsFor(a.deps.tenants.get('rfsafe-demo')).sent.filter((m) => m.to === '+17275550189').map((m) => m.body);
    assert.deepStrictEqual(bodies, ['Looking that up\u2026', 'Done.']);
  } finally { await a.close(); }
});
