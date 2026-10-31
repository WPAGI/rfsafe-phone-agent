'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path'); const os = require('os');
const { startApp } = require('./helpers');
const { twilioSignature } = require('../src/twilio');
const { CallSession } = require('../src/xai');
const { Tools, Approvals } = require('../src/tools');
const { MockRealtimeWs, MockCallControl } = require('../src/mocks');
const { createOwner } = require('../src/owner');
const C = require('../src/owner/config'); const { PinStore } = require('../src/owner/pin'); const A = require('../src/owner/alerts');

const KATIE = '+17276101188', OTHER_ADMIN = '+17273540485', STRANGER = '+17275550142';
const ADMIN = { authorization: 'Bearer demo-admin-token-EXAMPLE', 'content-type': 'application/json' };
const req = (base, p, method = 'GET', body, headers = ADMIN) => fetch(base + p, { method, headers, body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
function tenantBase(over = {}) {
  return { id: 'r', name: 'RF Safe', numbers: ['+17276775572'], link_allowlist: ['rfsafe.org'], blocked_topics: [], sms_enabled: true, email_enabled: false, transfer_target: 'tel:' + KATIE, owner_email: 'owner@example.com',
    hours: { tz: 'America/New_York', open: '00:00', close: '23:59', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] }, max_call_seconds: 900,
    disclosure: 'Hi, you have reached {name}. This call may be recorded and is answered by an AI assistant.',
    known_callers: { [KATIE]: { name: 'Katie', role: 'administrator' }, [OTHER_ADMIN]: { name: 'Katie', role: 'administrator' }, '+17275550000': { name: 'Friend', role: 'friend' } }, ...over };
}
function rig(tenant, { now = () => new Date('2026-10-29T14:00:00Z'), referStatus = 200, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-')) } = {}) {
  const sms = { sent: [], async sendSms(m) { this.sent.push(m); return { sid: 'SM' + this.sent.length }; } };
  const emails = []; const outbox = []; const voice = { calls: [], async createCall(c) { this.calls.push(c); return { sid: 'CA' + this.calls.length }; } };
  const d = { tenants: { list: () => [tenant], get: (id) => (id === tenant.id ? tenant : null) }, callLog: path.join(dir, 'calls.jsonl'), callRecords: new (require('../src/admin').CallRecords)({ file: path.join(dir, 'call-records.jsonl') }),
    smsFor: () => sms, emailFor: () => ({ async send(m) { emails.push(m); return { ok: true }; } }), notify: async (t, i) => { outbox.push(i); }, ownerVoiceFor: () => voice, now, publicBaseUrl: 'https://cb.test', kbGapFile: path.join(dir, 'kb-gaps.jsonl') };
  const logs = []; const owner = createOwner(d, { log: (e, f) => logs.push({ e, ...f }) });
  const cc = new MockCallControl({ referStatus });
  const tools = new Tools(tenant, { kbFor: () => ({ answer: () => ({ found: false }) }), shopifyFor: () => null, approvals: new Approvals(), callControl: cc, log: () => {}, notify: owner.wrapNotify(d.notify), now });
  return { d, owner, sms, emails, voice, outbox, logs, cc, tools, dir };
}
const session = (tenant, tools, caller) => { const ws = new MockRealtimeWs(); const s = new CallSession({ ws, tenant, callId: 'c1', caller, tools, afterHours: false, log: () => {} }); clearTimeout(s.timer); return { ws, s, upd: ws.sent.find((m) => m.type === 'session.update') }; };

// ---------- flag off: identical behaviour ----------
test('flag off: wrapTools returns the same object; session.update and greeting are byte-identical', () => {
  for (const over of [{}, { owner_briefing: { enabled: false, daily_time: '07:00' } }]) {
    const t = tenantBase(over); const r = rig(t);
    for (const caller of [KATIE, OTHER_ADMIN, STRANGER, null]) {
      assert.strictEqual(r.owner.wrapTools(t, caller, r.tools), r.tools);
      assert.deepStrictEqual(session(t, r.owner.wrapTools(t, caller, r.tools), caller).ws.sent, session(t, r.tools, caller).ws.sent);
    }
    const tr = [{ role: 'caller', text: 'I am going to sue, my PIN is 1234' }];
    assert.strictEqual(r.owner.onCallEnd(t, STRANGER, { tools: [{ tool: 'owner_briefing' }] }, tr), tr);
  }
});
test('flag off: no scheduler calls, no alerts, no event files, notify unchanged', async () => {
  const t = tenantBase(); const r = rig(t, { now: () => new Date('2026-10-29T22:05:00Z') });
  await r.owner.tick(); assert.strictEqual(r.voice.calls.length, 0);
  const res = await r.owner.alert(t, 'legal'); assert.strictEqual(res.reason, 'disabled');
  const log = r.owner.wrapLog((e) => r.logs.push({ e })); for (let i = 0; i < 20; i++) log('tool.error', { tenant: 'r' });
  await r.tools.run('take_message', { message: 'URGENT my phone case caught fire' }, { channel: 'voice', caller: STRANGER });
  assert.strictEqual(r.voice.calls.length, 0); assert.strictEqual(r.outbox.length, 1);
  assert.ok(!fs.existsSync(path.join(r.dir, 'owner-events.jsonl'))); assert.ok(!fs.existsSync(path.join(r.dir, 'owner-state.json')));
});
test('flag off over HTTP: inbound call tools and /twilio/owner routes unchanged (404)', async () => {
  const a = await startApp();
  try {
    const t = a.deps.tenants.get('rfsafe-demo'); assert.ok(!C.enabled(t));
    const p = { To: '+17275550100', From: '+17275550100', CallSid: 'CA1' }; const url = a.base + '/twilio/owner/answer?t=rfsafe-demo&k=daily';
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature('tw-test', url, p) }, body: new URLSearchParams(p) });
    assert.strictEqual(r.status, 404);
  } finally { await a.close(); }
});

// ---------- config ----------
test('owner numbers come from administrator known_callers; explicit list wins; validation', () => {
  const t = tenantBase({ owner_briefing: { enabled: true } });
  assert.deepStrictEqual(C.ownerNumbers(t).sort(), [OTHER_ADMIN, KATIE].sort());
  assert.ok(!C.isOwner(t, '+17275550000')); assert.ok(!C.isOwner(t, STRANGER));
  assert.deepStrictEqual(C.ownerNumbers(tenantBase({ owner_briefing: { owner_numbers: [KATIE] } })), [KATIE]);
  assert.deepStrictEqual(C.dailyNumbers(tenantBase({ owner_briefing: { daily_numbers: [KATIE, STRANGER] } })), [KATIE]); // never a non-owner
  assert.strictEqual(C.settings(t).daily_time, '18:00'); assert.strictEqual(C.settings(t).timezone, 'America/New_York');
  assert.deepStrictEqual(C.validate({ enabled: true, daily_time: '18:30', owner_numbers: [KATIE] }), []);
  assert.ok(C.validate({ daily_time: '6pm' }).length); assert.ok(C.validate({ pin: '1234' }).length); assert.ok(C.validate({ pin_hash: 'x' }).length);
  assert.ok(C.validate({ owner_numbers: ['7276101188'] }).length); assert.ok(C.validate({ enabled: 'yes' }).length); assert.ok(C.validate({ timezone: 'Mars/Base' }).length);
});

// ---------- PIN ----------
test('PIN is stored hashed, accepts spoken digits, locks after 5 failures', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pin-')), 'owner-pins.json'); const p = new PinStore({ file: f });
  assert.ok(!p.set('r', '12ab')); assert.ok(p.set('r', '4821'));
  assert.ok(!fs.readFileSync(f, 'utf8').includes('4821')); assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  assert.ok(p.verify('r', 'four eight two one', 'd1').ok); assert.ok(p.verify('r', '4821#', 'd1').ok);
  for (let i = 0; i < 4; i++) assert.strictEqual(p.verify('r', '0000', 'd1').reason, 'wrong_pin');
  assert.strictEqual(p.verify('r', '0000', 'd1').reason, 'locked'); assert.strictEqual(p.verify('r', '4821', 'd1').reason, 'locked');
  assert.ok(p.verify('r', '4821', 'd2').ok); assert.strictEqual(new PinStore({ file: f + 'x' }).verify('r', '4821', 'd').reason, 'no_pin_set');
});

// ---------- on-demand ----------
test('on-demand: only owner callers get owner_briefing; PIN gates every byte of the briefing', async () => {
  const t = tenantBase({ owner_briefing: { enabled: true } }); const r = rig(t); r.owner.pins.set('r', '4821');
  const names = (c) => session(t, r.owner.wrapTools(t, c, r.tools), c).upd.session.tools.map((x) => x.name);
  assert.ok(names(OTHER_ADMIN).includes('owner_briefing')); assert.ok(!names(STRANGER).includes('owner_briefing')); assert.ok(!names(null).includes('owner_briefing')); assert.ok(!names('+17275550000').includes('owner_briefing'));
  const stranger = r.owner.wrapTools(t, STRANGER, r.tools);
  assert.deepStrictEqual(await stranger.run('owner_briefing', { pin: '4821' }, { channel: 'voice', caller: STRANGER }), { ok: false, error: 'unknown_tool' });
  const w = r.owner.wrapTools(t, OTHER_ADMIN, r.tools); const ctx = { channel: 'voice', caller: OTHER_ADMIN, callId: 'c1' };
  const bad = await w.run('owner_briefing', { pin: '1111' }, ctx); assert.strictEqual(bad.ok, false); assert.ok(!('briefing' in bad)); assert.doesNotMatch(JSON.stringify(bad), /calls?,|summary/);
  const good = await w.run('owner_briefing', { pin: 'four eight two one' }, ctx); assert.strictEqual(good.ok, true); assert.match(good.briefing, /today's summary for Katie/); assert.match(good.briefing, /0 calls/);
  const w2 = r.owner.wrapTools(t, OTHER_ADMIN, r.tools); await w2.run('owner_briefing', { pin: '1' }, ctx); await w2.run('owner_briefing', { pin: '2' }, ctx);
  assert.strictEqual((await w2.run('owner_briefing', { pin: '4821' }, ctx)).error, 'too_many_attempts'); // 2 tries per call
  assert.ok(!JSON.stringify(r.logs).includes('4821'));
  const red = r.owner.onCallEnd(t, OTHER_ADMIN, { tools: [{ tool: 'owner_briefing' }] }, [{ role: 'caller', text: 'my pin is four eight two one' }, { role: 'caller', text: 'it is 4821' }]);
  assert.ok(red.every((x) => !/4821|four eight two one/.test(x.text)));
});
test('on-demand over a live inbound call session: owner tool runs through CallSession', async () => {
  const t = tenantBase({ owner_briefing: { enabled: true } }); const r = rig(t); r.owner.pins.set('r', '4821');
  const { ws } = session(t, r.owner.wrapTools(t, KATIE, r.tools), KATIE);
  ws.serverEvent({ type: 'response.function_call_arguments.done', name: 'owner_briefing', call_id: 'f1', arguments: JSON.stringify({ pin: '4821' }) });
  ws.serverEvent({ type: 'response.done' }); await new Promise((x) => setTimeout(x, 20));
  const out = JSON.parse(ws.sent.find((m) => m.item && m.item.type === 'function_call_output').item.output); assert.ok(out.ok); assert.match(out.briefing, /summary/);
});

// ---------- summary ----------
test('briefing counts the day from archives and leaks no caller details', () => {
  const t = tenantBase({ owner_briefing: { enabled: true } }); const r = rig(t, { now: () => new Date('2026-10-29T22:05:00Z') });
  r.d.callRecords.add({ at: '2026-10-29T15:00:00Z', tenant: 'r', caller: STRANGER, tools: ['kb_answer', 'order_status'], kb_queries: ['lowest SAR phone'], emails: [] });
  r.d.callRecords.add({ at: '2026-10-28T15:00:00Z', tenant: 'r', caller: STRANGER, tools: [], kb_queries: ['yesterday'], emails: [] });
  fs.writeFileSync(path.join(r.dir, 'owner-outbox.jsonl'), JSON.stringify({ tenant: 'r', kind: 'message', at: '2026-10-29T16:00:00Z', message: 'call me at 555', from: STRANGER }) + '\n');
  const s = require('../src/owner/summary'); const text = s.render(s.collect({ tenant: t, files: { callRecords: r.d.callRecords.file, outbox: path.join(r.dir, 'owner-outbox.jsonl') }, now: new Date('2026-10-29T22:05:00Z'), tz: 'America/New_York' }));
  assert.match(text, /1 call,/); assert.match(text, /lowest sar phone/); assert.match(text, /1 order lookup/); assert.match(text, /1 message taken/); assert.match(text, /need follow-up/);
  assert.doesNotMatch(text, /yesterday|555|0142/);
});

// ---------- daily scheduler ----------
test('daily call: fires once at 6 PM ET to owner numbers, survives restart, not before the time', async () => {
  let clock = new Date('2026-10-29T21:59:00Z'); const now = () => clock;
  const t = tenantBase({ owner_briefing: { enabled: true, copy_sms: true, copy_email: true } }); const r = rig(t, { now });
  await r.owner.tick(); assert.strictEqual(r.voice.calls.length, 0);
  clock = new Date('2026-10-29T22:05:00Z'); await r.owner.tick(); await r.owner.tick();
  assert.deepStrictEqual(r.voice.calls.map((c) => c.to).sort(), [OTHER_ADMIN, KATIE].sort());
  const c = r.voice.calls[0]; assert.strictEqual(c.from, '+17276775572'); assert.match(c.url, /^https:\/\/cb\.test\/twilio\/owner\/answer\?t=r&k=daily/); assert.match(c.statusCallback, /owner\/status/);
  assert.strictEqual(r.sms.sent.length, 2); assert.strictEqual(r.emails.length, 1); assert.strictEqual(r.emails[0].to, 'owner@example.com');
  const r2 = rig(t, { now, dir: r.dir }); await r2.owner.tick(); assert.strictEqual(r2.voice.calls.length, 0); // restart: same day already claimed
  clock = new Date('2026-10-30T22:01:00Z'); await r2.owner.tick(); assert.strictEqual(r2.voice.calls.length, 2); // next day
  const audit = fs.readFileSync(path.join(r.dir, 'owner-audit.jsonl'), 'utf8'); assert.match(audit, /call_placed/); assert.ok(!audit.includes(KATIE));
  const recs = r.d.callRecords.read().filter((x) => x.direction === 'outbound_owner'); assert.strictEqual(recs.length, 4);
  assert.ok(fs.readFileSync(path.join(r.dir, 'owner-calls.jsonl'), 'utf8').includes('"kind":"daily"'));
});
test('daily call: copies off by default; configured time and numbers respected; never dials a non-owner', async () => {
  const t = tenantBase({ owner_briefing: { enabled: true, daily_time: '07:30', daily_numbers: [KATIE] } }); const r = rig(t, { now: () => new Date('2026-10-29T11:31:00Z') });
  await r.owner.tick(); assert.deepStrictEqual(r.voice.calls.map((c) => c.to), [KATIE]); assert.strictEqual(r.sms.sent.length + r.emails.length, 0);
  const stranger = tenantBase({ owner_briefing: { enabled: true, daily_numbers: [STRANGER] } }); const r2 = rig(stranger, { now: () => new Date('2026-10-29T22:01:00Z') });
  await r2.owner.tick(); assert.strictEqual(r2.voice.calls.length, 0);
});

// ---------- Twilio owner-call webhooks ----------
async function ownerApp() {
  const a = await startApp(); const t = a.deps.tenants.get('rfsafe-demo');
  t.known_callers = { [KATIE]: { name: 'Katie', role: 'administrator' } }; t.owner_briefing = { enabled: true };
  a.app.owner.pins.set(t.id, '4821');
  const post = (p, params) => { const url = a.base + p; return fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature('tw-test', url, params) }, body: new URLSearchParams(params) }); };
  return { a, t, post };
}
test('owner call: signature required; voicemail is vague; PIN gates the briefing', async () => {
  const { a, post } = await ownerApp();
  try {
    const q = '/twilio/owner/answer?t=rfsafe-demo&k=daily';
    const unsigned = await fetch(a.base + q, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'To=%2B17276101188' }); assert.strictEqual(unsigned.status, 403);
    const vm = await (await post(q, { To: KATIE, From: '+17275550100', CallSid: 'CA1', AnsweredBy: 'machine_end_beep' })).text();
    assert.match(vm, /call the main line back/); assert.doesNotMatch(vm, /\d+ calls?|summary|Gather/);
    const human = await (await post(q, { To: KATIE, From: '+17275550100', CallSid: 'CA1', AnsweredBy: 'human' })).text();
    assert.match(human, /<Gather input="dtmf speech"/); assert.doesNotMatch(human, /summary/);
    const wrong = await (await post('/twilio/owner/pin?t=rfsafe-demo&k=daily&n=1', { To: KATIE, From: '+17275550100', CallSid: 'CA1', Digits: '0000' })).text();
    assert.match(wrong, /did not match/); assert.doesNotMatch(wrong, /summary/);
    const wrong2 = await (await post('/twilio/owner/pin?t=rfsafe-demo&k=daily&n=2', { To: KATIE, From: '+17275550100', CallSid: 'CA1', Digits: '0001' })).text();
    assert.match(wrong2, /could not verify/); assert.match(wrong2, /<Hangup\/>/); assert.doesNotMatch(wrong2, /summary/);
    const ok = await (await post('/twilio/owner/pin?t=rfsafe-demo&k=daily&n=1', { To: KATIE, From: '+17275550100', CallSid: 'CA2', SpeechResult: 'four eight two one' })).text();
    assert.match(ok, /today&apos;s summary for Katie/);
    const notOwner = await (await post('/twilio/owner/pin?t=rfsafe-demo&k=daily&n=1', { To: STRANGER, From: '+17275550100', CallSid: 'CA3', Digits: '4821' })).text();
    assert.doesNotMatch(notOwner, /summary/);
    assert.strictEqual((await post('/twilio/owner/status?t=rfsafe-demo&k=daily', { To: KATIE, From: '+17275550100', CallSid: 'CA2', CallStatus: 'completed', CallDuration: '41' })).status, 204);
  } finally { await a.close(); }
});

// ---------- admin API ----------
test('admin: owner_briefing PATCH is validated; PIN endpoint stores a hash only; call_now needs flag and PIN', async () => {
  const a = await startApp();
  try {
    const t = a.deps.tenants.get('rfsafe-demo'); t.known_callers = { [KATIE]: { name: 'Katie', role: 'administrator' } };
    assert.strictEqual((await req(a.base, '/admin/tenants/rfsafe-demo', 'PATCH', { owner_briefing: { enabled: 'yes' } })).status, 400);
    assert.strictEqual((await req(a.base, '/admin/tenants/rfsafe-demo', 'PATCH', { owner_briefing: { enabled: false, daily_time: '18:00' } })).status, 200);
    assert.strictEqual((await req(a.base, '/admin/tenants/rfsafe-demo/owner-briefing', 'POST', { action: 'call_now' })).status, 409); // disabled
    assert.strictEqual((await req(a.base, '/admin/tenants/rfsafe-demo/owner-pin', 'POST', { pin: '12' })).status, 400);
    assert.strictEqual((await req(a.base, '/admin/tenants/rfsafe-demo/owner-pin', 'POST', { pin: '4821' })).status, 200);
    assert.strictEqual((await req(a.base, '/admin/tenants/rfsafe-demo/owner-pin', 'POST', { pin: '4821' }, { 'content-type': 'application/json' })).status, 401);
    const cfg = await (await req(a.base, '/admin/tenants/rfsafe-demo/config')).text(); assert.ok(!cfg.includes('4821')); assert.ok(!/salt|hash/.test(cfg));
    assert.strictEqual((await req(a.base, '/admin/tenants/rfsafe-demo', 'PATCH', { owner_briefing: { enabled: true } })).status, 200);
    const st = await (await req(a.base, '/admin/tenants/rfsafe-demo/owner-briefing')).json(); assert.strictEqual(st.pin_set, true); assert.deepStrictEqual(st.owner_numbers, ['***1188']); assert.match(st.preview, /summary/);
    assert.ok(!JSON.stringify(st).includes(KATIE));
    const cn = await (await req(a.base, '/admin/tenants/rfsafe-demo/owner-briefing', 'POST', { action: 'call_now', to: STRANGER })).json(); assert.strictEqual(cn.calls[0].error, 'not_owner_number');
    const cn2 = await (await req(a.base, '/admin/tenants/rfsafe-demo/owner-briefing', 'POST', { action: 'call_now' })).json(); assert.strictEqual(cn2.calls[0].ok, true);
    assert.strictEqual(a.app.owner.mockVoice.calls[0].to, KATIE);
    assert.ok(!a.logs.some((l) => JSON.stringify(l).includes('4821')));
  } finally { await a.close(); }
});

// ---------- emergency alerts ----------
test('alerts: classifier rules', () => {
  assert.strictEqual(A.classifyCall([{ role: 'caller', text: 'I will call my lawyer' }]), 'legal');
  assert.strictEqual(A.classifyCall([{ role: 'caller', text: 'the phone got hot and burned my hand' }]), 'safety');
  assert.strictEqual(A.classifyCall([{ role: 'caller', text: 'this is ridiculous' }]), null); // one word is not escalation
  assert.strictEqual(A.classifyCall([{ role: 'caller', text: 'this is a scam, I am filing a chargeback' }]), 'angry');
  assert.strictEqual(A.classifyCall([{ role: 'agent', text: 'you could sue' }]), null); // agent words never count
  assert.strictEqual(A.classifyMessage({ message: 'please call back ASAP' }), 'urgent_callback');
  assert.strictEqual(A.classifyMessage({ message: 'what is SAR' }), null);
});
test('alerts: call owners now, rate limits, quiet hours, urgent messages, repeated errors', async () => {
  let clock = new Date('2026-10-29T15:00:00Z'); // 11:00 ET
  const t = tenantBase({ owner_briefing: { enabled: true, alert_max_per_day: 2, alert_min_gap_minutes: 30 } }); const r = rig(t, { now: () => clock });
  r.owner.onCallEnd(t, STRANGER, { call: 'x1', tools: [] }, [{ role: 'caller', text: 'my attorney will be in touch' }]); await new Promise((x) => setTimeout(x, 20));
  assert.strictEqual(r.voice.calls.length, 2); assert.match(r.voice.calls[0].url, /k=alert&a=legal/);
  r.owner.onCallEnd(t, STRANGER, { call: 'x1', tools: [] }, [{ role: 'caller', text: 'lawsuit' }]); await new Promise((x) => setTimeout(x, 20));
  assert.strictEqual(r.voice.calls.length, 2); // same call never alerts twice
  clock = new Date('2026-10-29T15:10:00Z'); assert.strictEqual((await r.owner.alert(t, 'safety')).reason, 'min_gap');
  clock = new Date('2026-10-29T16:00:00Z'); await r.tools.run('take_message', { message: 'Urgent, please call me back' }, { channel: 'voice', caller: STRANGER }); await new Promise((x) => setTimeout(x, 20));
  assert.strictEqual(r.voice.calls.length, 4); assert.match(r.voice.calls[2].url, /a=urgent_callback/);
  clock = new Date('2026-10-29T17:00:00Z'); assert.strictEqual((await r.owner.alert(t, 'legal')).reason, 'daily_limit');
  // owners' own calls never page themselves
  r.owner.onCallEnd(t, KATIE, { call: 'x9', tools: [] }, [{ role: 'caller', text: 'test: lawyer fire' }]);
  // quiet hours: 23:00 ET; safety allowed by default, legal deferred
  const t2 = tenantBase({ owner_briefing: { enabled: true } }); const q = rig(t2, { now: () => new Date('2026-10-30T03:00:00Z') });
  assert.deepStrictEqual(await q.owner.alert(t2, 'legal'), { ok: true, called: false, reason: 'quiet_hours' }); assert.strictEqual(q.voice.calls.length, 0);
  assert.strictEqual((await q.owner.alert(t2, 'safety')).called, true);
  // repeated errors
  const t3 = tenantBase({ owner_briefing: { enabled: true, error_threshold: 3 } }); const e = rig(t3); const log = e.owner.wrapLog(() => {});
  log('tool.error', { tenant: 'r' }); log('tool.error', { tenant: 'r' }); assert.strictEqual(e.voice.calls.length, 0);
  log('http.error', {}); await new Promise((x) => setTimeout(x, 20)); assert.match(e.voice.calls[0].url, /a=system_errors/);
  const ev = fs.readFileSync(path.join(e.dir, 'owner-events.jsonl'), 'utf8'); assert.match(ev, /"kind":"error"/);
});

// ---------- transfer ----------
test('transfer: explicit-request wording; failed transfer returns to the bot to take a message and tells owners', async () => {
  const t = tenantBase({ owner_briefing: { enabled: true } }); const r = rig(t, { referStatus: 486 });
  const w = r.owner.wrapTools(t, STRANGER, r.tools);
  assert.match(w.definitions().find((x) => x.name === 'transfer_to_human').description, /ONLY when the caller explicitly asks/);
  const out = await w.run('transfer_to_human', { reason: 'wants a person' }, { channel: 'voice', callId: 'c1', caller: STRANGER });
  assert.strictEqual(out.ok, false); assert.match(out.say, /take a message/);
  assert.strictEqual(r.sms.sent.length, 2); assert.match(r.sms.sent[0].body, /ending 0142/); assert.ok(!r.sms.sent[0].body.includes(STRANGER));
  assert.strictEqual(r.emails.length, 1);
  const ok = rig(t); const res = await ok.owner.wrapTools(t, STRANGER, ok.tools).run('transfer_to_human', {}, { channel: 'voice', callId: 'c1', caller: STRANGER });
  assert.deepStrictEqual(res, { ok: true, transferred: true }); assert.strictEqual(ok.sms.sent.length, 0);
  const off = rig(tenantBase({ transfer_target: 'tel:' + KATIE }), { referStatus: 486 });
  assert.match(off.tools.definitions().find((x) => x.name === 'transfer_to_human').description, /^Transfer the call to a person\. Use it whenever the caller explicitly asks for a person, at any hour\./);
});
test('transfer bridge: no answer records a message and alerts owners; answered call just ends', async () => {
  const { a, t, post } = await ownerApp();
  try {
    t.owner_briefing = { enabled: true, transfer_bridge_uri: 'sip:bridge@example.sip.twilio.com' };
    const dial = await (await post('/twilio/owner/transfer?t=rfsafe-demo', { To: '+17275550111', From: STRANGER, CallSid: 'CA9' })).text();
    assert.match(dial, /<Dial timeout="20"/); assert.match(dial, /\+17275550199/);
    const done = await (await post('/twilio/owner/transfer-result?t=rfsafe-demo', { To: '+17275550111', From: STRANGER, CallSid: 'CA9', DialCallStatus: 'completed' })).text(); assert.match(done, /<Hangup\/>/);
    const miss = await (await post('/twilio/owner/transfer-result?t=rfsafe-demo', { To: '+17275550111', From: STRANGER, CallSid: 'CA9', DialCallStatus: 'no-answer' })).text(); assert.match(miss, /<Record /);
    const msg = await (await post('/twilio/owner/transfer-message?t=rfsafe-demo', { To: '+17275550111', From: STRANGER, CallSid: 'CA9', RecordingSid: 'RE1' })).text(); assert.match(msg, /get back to you/);
    const out = fs.readFileSync(path.join(path.dirname(a.deps.callLog), 'owner-outbox.jsonl'), 'utf8'); assert.match(out, /missed_transfer/);
  } finally { await a.close(); }
});
