'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { startApp, ENV } = require('./helpers');
const { twilioSignature } = require('../src/twilio');
const { signWebhook } = require('../src/xai');
const { OwnerTokens, tokenFromSip, HEADER } = require('../src/owner/token');
const C = require('../src/owner/config');

const KATIE = '+17276101188', STRANGER = '+17275550142';
const SECRET = ENV.DEMO_XAI_WEBHOOK_SECRET;
async function ownerApp(ob = { enabled: true }) {
  const a = await startApp(); const t = a.deps.tenants.get('rfsafe-demo');
  t.known_callers = { [KATIE]: { name: 'Katie', role: 'administrator' } }; t.owner_briefing = ob;
  a.app.owner.pins.set(t.id, '4821');
  const post = (p, params) => { const url = a.base + p; return fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature('tw-test', url, params) }, body: new URLSearchParams(params) }); };
  const incoming = (headers, id = 'evt_' + Math.random()) => {
    const body = JSON.stringify({ id, type: 'realtime.call.incoming', data: { call_id: 'c_' + id, sip_headers: [{ name: 'From', value: t.numbers[0] }, { name: 'To', value: t.numbers[0] }, ...headers] } });
    const ts = String(Math.floor(Date.now() / 1000));
    return fetch(a.base + '/xai/webhook', { method: 'POST', body, headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signWebhook(SECRET, id, ts, body) } });
  };
  return { a, t, post, incoming };
}
const tick = () => new Promise((r) => setTimeout(r, 30));
const tokenIn = (twiml) => { const m = /rfs_owner_token=([A-Za-z0-9._-]+)/.exec(twiml); return m && m[1]; };
const isOwnerSession = (ws) => { const u = ws.sent.find((m) => m.type === 'session.update'); return !!u && /calling an owner/.test(u.session.instructions) && u.session.tools.map((x) => x.name).join() === 'owner_briefing,end_call'; };

test('token: signed, short-lived, single-use; forged and expired fail', () => {
  let clock = 1_000_000; const T = new OwnerTokens({ now: () => clock, ttlMs: 120000 });
  const tok = T.mint('s1', { tenant: 'r', to: KATIE, kind: 'daily' });
  assert.match(tok, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.strictEqual(T.claim('other-secret', tok).reason, 'bad_signature');
  const [v, p, sig] = tok.split('.'); const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), to: STRANGER })).toString('base64url');
  assert.strictEqual(T.claim('s1', `${v}.${forged}.${sig}`).reason, 'bad_signature');
  assert.strictEqual(T.claim('s1', 'garbage').reason, 'invalid');
  const ok = T.claim('s1', tok); assert.strictEqual(ok.ok, true); assert.strictEqual(ok.to, KATIE);
  assert.strictEqual(T.claim('s1', tok).reason, 'replayed');
  const old = T.mint('s1', { tenant: 'r', to: KATIE }); clock += 121000; assert.strictEqual(T.claim('s1', old).reason, 'expired');
  assert.strictEqual(T.mint(null, { tenant: 'r', to: KATIE }), null);
});
test('token: read from custom X- header or from a URI parameter', () => {
  assert.strictEqual(tokenFromSip({ sip_headers: [{ name: HEADER.toLowerCase(), value: ' v1.a.b ' }] }), 'v1.a.b');
  assert.strictEqual(tokenFromSip({ sip_headers: [{ name: 'To', value: '<sip:+17276775572@sip.voice.x.ai;transport=tls;rfs_owner_token=v1.x.y>' }] }), 'v1.x.y');
  assert.strictEqual(tokenFromSip({ sip_headers: [{ name: 'To', value: '+17276775572' }] }), null);
});
test('config: voice defaults to grok; twilio and legacy voice names select Twilio TTS', () => {
  assert.strictEqual(C.voiceMode({ owner_briefing: { enabled: true } }), 'grok');
  assert.strictEqual(C.voiceMode({ owner_briefing: { voice: 'twilio' } }), 'twilio');
  assert.strictEqual(C.voiceMode({ owner_briefing: { voice: 'Polly.Matthew' } }), 'twilio'); assert.strictEqual(C.twilioVoice({ owner_briefing: { voice: 'Polly.Matthew' } }), 'Polly.Matthew');
  assert.strictEqual(C.twilioVoice({ owner_briefing: { voice: 'twilio' } }), 'Polly.Joanna');
  assert.deepStrictEqual(C.validate({ voice: 'grok', twilio_voice: 'Polly.Joanna', grok_sip_domain: 'sip.voice.x.ai' }), []);
  assert.ok(C.validate({ voice: '<bad>' }).length);
});

test('grok mode: human answer dials Grok over SIP with a token; voicemail gets the generic line and no Grok leg', async () => {
  const { a, post } = await ownerApp();
  try {
    const q = '/twilio/owner/answer?t=rfsafe-demo&k=daily';
    const vm = await (await post(q, { To: KATIE, From: '+17275550100', CallSid: 'CA1', AnsweredBy: 'machine_end_beep' })).text();
    assert.match(vm, /call the main line back/); assert.doesNotMatch(vm, /<Dial|<Sip|token/i);
    const human = await (await post(q, { To: KATIE, From: '+17275550100', CallSid: 'CA2', AnsweredBy: 'human' })).text();
    assert.match(human, /<Dial answerOnBridge="true"[^>]*action="[^"]*\/twilio\/owner\/grok-result/);
    assert.match(human, /<Sip>sip:\+17275550100@sip\.voice\.x\.ai;transport=tls;rfs_owner_token=v1\.[^?]+\?X-RFSafe-Owner-Token=v1\./);
    assert.doesNotMatch(human, /summary|Gather/);
    assert.ok(!a.logs.some((l) => JSON.stringify(l).includes(tokenIn(human))), 'token never logged');
    const failed = await (await post('/twilio/owner/grok-result?t=rfsafe-demo&k=daily', { To: KATIE, From: '+17275550100', CallSid: 'CA2', DialCallStatus: 'failed' })).text();
    assert.match(failed, /<Gather input="dtmf speech"/); // Twilio TTS fallback on the same call
    const done = await (await post('/twilio/owner/grok-result?t=rfsafe-demo&k=daily', { To: KATIE, From: '+17275550100', CallSid: 'CA2', DialCallStatus: 'completed' })).text();
    assert.match(done, /<Hangup\/>/); assert.doesNotMatch(done, /Gather/);
  } finally { await a.close(); }
});

test('grok session: valid token opens an owner session; PIN gates the briefing; follow-ups work; token is single-use', async () => {
  const { a, post, incoming } = await ownerApp();
  try {
    const human = await (await post('/twilio/owner/answer?t=rfsafe-demo&k=daily', { To: KATIE, From: '+17275550100', CallSid: 'CA2', AnsweredBy: 'human' })).text();
    const tok = tokenIn(human);
    assert.strictEqual((await incoming([{ name: HEADER, value: tok }])).status, 200); await tick();
    const ws = a.ws(); assert.ok(isOwnerSession(ws));
    const greet = ws.sent.find((m) => m.type === 'conversation.item.create'); assert.match(greet.item.content[0].text, /Hi Katie.*daily update.*PIN/);
    const out = () => JSON.parse(ws.sent.filter((m) => m.item && m.item.type === 'function_call_output').pop().item.output);
    const fn = async (args, id) => { ws.serverEvent({ type: 'response.function_call_arguments.done', name: 'owner_briefing', call_id: id, arguments: JSON.stringify(args) }); ws.serverEvent({ type: 'response.done' }); await tick(); return out(); };
    let r = await fn({}, 'f0'); assert.strictEqual(r.ok, false); assert.ok(!('briefing' in r)); // no PIN, no data
    r = await fn({ pin: 'four eight two one' }, 'f1'); assert.strictEqual(r.ok, true); assert.match(r.briefing, /summary for Katie/); assert.strictEqual(typeof r.details.calls, 'number');
    r = await fn({}, 'f2'); assert.strictEqual(r.ok, true); // follow-up without PIN after verification
    assert.ok(!a.logs.some((l) => JSON.stringify(l).includes('4821')));
    // replay of the same token -> normal inbound
    assert.strictEqual((await incoming([{ name: HEADER, value: tok }])).status, 200); await tick();
    assert.ok(!isOwnerSession(a.ws()));
    assert.ok(a.logs.some((l) => l.e === 'owner.grok_token_rejected' && l.reason === 'replayed'));
  } finally { await a.close(); }
});

test('grok session: two wrong PINs share nothing', async () => {
  const { a, post, incoming } = await ownerApp();
  try {
    const tok = tokenIn(await (await post('/twilio/owner/answer?t=rfsafe-demo&k=alert&a=legal', { To: KATIE, From: '+17275550100', CallSid: 'CA9', AnsweredBy: 'human' })).text());
    await incoming([{ name: 'To', value: `<sip:+17275550100@sip.voice.x.ai;transport=tls;rfs_owner_token=${tok}>` }]); await tick();
    const ws = a.ws(); assert.ok(isOwnerSession(ws));
    for (const [i, pin] of [['a', '0000'], ['b', '1111'], ['c', '4821']].map((x) => x)) { ws.serverEvent({ type: 'response.function_call_arguments.done', name: 'owner_briefing', call_id: i, arguments: JSON.stringify({ pin }) }); ws.serverEvent({ type: 'response.done' }); await tick(); }
    const outs = ws.sent.filter((m) => m.item && m.item.type === 'function_call_output').map((m) => JSON.parse(m.item.output));
    assert.ok(outs.every((o) => o.ok === false && !o.briefing)); assert.strictEqual(outs[2].error, 'too_many_attempts');
  } finally { await a.close(); }
});

test('forged, expired, wrong-secret or disabled tokens are handled as a normal inbound call', async () => {
  const { a, t, incoming } = await ownerApp();
  try {
    let clock = +a.deps.now(); const T = new OwnerTokens({ now: () => clock });
    const forged = T.mint('not-the-secret', { tenant: t.id, to: KATIE });
    await incoming([{ name: HEADER, value: forged }]); await tick(); assert.ok(!isOwnerSession(a.ws()));
    clock -= 10 * 60000; const expired = T.mint(SECRET, { tenant: t.id, to: KATIE }); // minted 10 min ago, 2 min TTL
    await incoming([{ name: HEADER, value: expired }]); await tick(); assert.ok(!isOwnerSession(a.ws()));
    await incoming([{ name: HEADER, value: 'v1.e30.' + 'A'.repeat(43) }]); await tick(); assert.ok(!isOwnerSession(a.ws()));
    const strangerTok = a.app.owner.tokens.mint(SECRET, { tenant: t.id, to: STRANGER });
    await incoming([{ name: HEADER, value: strangerTok }]); await tick(); assert.ok(!isOwnerSession(a.ws()));
    t.owner_briefing = { enabled: true, voice: 'twilio' }; const off = a.app.owner.tokens.mint(SECRET, { tenant: t.id, to: KATIE });
    await incoming([{ name: HEADER, value: off }]); await tick(); assert.ok(!isOwnerSession(a.ws()));
    const reasons = a.logs.filter((l) => l.e === 'owner.grok_token_rejected').map((l) => l.reason);
    assert.deepStrictEqual(reasons, ['bad_signature', 'expired', 'bad_signature', 'not_owner_number', 'grok_off']);
    // each one still got the normal inbound session (customer tools, disclosure greeting)
    const u = a.ws().sent.find((m) => m.type === 'session.update'); assert.ok(u.session.tools.some((x) => x.name === 'kb_answer'));
  } finally { await a.close(); }
});

test('twilio mode: answer keeps the Twilio TTS PIN flow (no SIP leg)', async () => {
  const { a, post } = await ownerApp({ enabled: true, voice: 'twilio' });
  try {
    const human = await (await post('/twilio/owner/answer?t=rfsafe-demo&k=daily', { To: KATIE, From: '+17275550100', CallSid: 'CA2', AnsweredBy: 'human' })).text();
    assert.match(human, /<Gather input="dtmf speech"/); assert.doesNotMatch(human, /<Sip>/);
  } finally { await a.close(); }
});
