'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { callerIdFromSip, sessionUpdate } = require('../src/xai');
const { startApp, ENV } = require('./helpers');
const { signWebhook } = require('../src/xai');
const H = (...pairs) => ({ sip_headers: pairs.map(([name, value]) => ({ name, value })) });

test('caller ID parsed from xAI webhook sip_headers; blocked/anonymous -> null', () => {
  assert.strictEqual(callerIdFromSip(H(['From', '+17275550142'])), '+17275550142');
  assert.strictEqual(callerIdFromSip(H(['From', '"John" <sip:+17275550142@sip.example.com>;tag=abc'])), '+17275550142');
  assert.strictEqual(callerIdFromSip(H(['From', '<sip:7275550142@1.2.3.4>'])), '+17275550142');
  assert.strictEqual(callerIdFromSip(H(['From', '<tel:+447700900123>'])), '+447700900123');
  assert.strictEqual(callerIdFromSip(H(['From', '<sip:+10000000000@x>'])), null);
  assert.strictEqual(callerIdFromSip(H(['P-Asserted-Identity', '<sip:+17275550199@carrier>'], ['From', '<sip:+17275550142@x>'])), '+17275550199');
  for (const v of ['"Anonymous" <sip:anonymous@anonymous.invalid>;tag=1', '<sip:restricted@x>', 'Unavailable <sip:unavailable@x>', '<sip:12345@x>', '']) assert.strictEqual(callerIdFromSip(H(['From', v])), null, v);
  assert.strictEqual(callerIdFromSip(H(['From', '<sip:+17275550142@x>'], ['Privacy', 'id'])), null);
  assert.strictEqual(callerIdFromSip({}), null);
});
test('instructions carry only the last 4 digits and the confirm-before-text script; texting off says so', () => {
  const t = { name: 'R', link_allowlist: ['rfsafe.org'], blocked_topics: [], sms_enabled: true };
  const on = sessionUpdate(t, [], { callerLast4: '0142' }).session.instructions;
  assert.match(on, /ending in 0142, okay to text\?/); assert.match(on, /set_text_number/); assert.match(on, /Do not ask the caller for their number/);
  const anon = sessionUpdate(t, [], {}).session.instructions;
  assert.match(anon, /Caller ID is blocked, so you cannot text/); assert.doesNotMatch(anon, /ask for the mobile number/i);
  assert.match(on, /only go to the number the caller is calling from/);
  const off = sessionUpdate({ ...t, sms_enabled: false }, [], { callerLast4: '0142' }).session.instructions;
  assert.match(off, /not switched on yet: do not offer to text/); assert.doesNotMatch(off, /okay to text/);
});
test('incoming call: session.update has last 4 only; blocked caller ID still answered', async () => {
  const a = await startApp(); const ts = String(Math.floor(Date.now() / 1000));
  const fire = async (from) => {
    const id = 'evt_' + Math.random(); const body = JSON.stringify({ id, type: 'realtime.call.incoming', data: { call_id: 'c_' + id, sip_headers: [{ name: 'From', value: from }, { name: 'To', value: '+17275550100' }] } });
    const r = await fetch(a.base + '/xai/webhook', { method: 'POST', body, headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signWebhook(ENV.DEMO_XAI_WEBHOOK_SECRET, id, ts, body) } });
    await new Promise((res) => setTimeout(res, 20)); return { status: r.status, upd: a.ws().sent.find((m) => m.type === 'session.update') };
  };
  try {
    let r = await fire('"Jane" <sip:+17275550142@carrier.example>;tag=9'); assert.strictEqual(r.status, 200);
    assert.match(r.upd.session.instructions, /ends in 0142/); assert.ok(!r.upd.session.instructions.includes('7275550142'));
    r = await fire('"Anonymous" <sip:anonymous@anonymous.invalid>'); assert.strictEqual(r.status, 200);
    assert.match(r.upd.session.instructions, /Caller ID is blocked/);
    assert.ok(JSON.stringify(a.logs).includes('withheld')); assert.ok(!JSON.stringify(a.logs).includes('7275550142'));
  } finally { await a.close(); }
});
