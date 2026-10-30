'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { WebhookVerifier, signWebhook, CallSession, sessionUpdate } = require('../src/xai');
const { MockRealtimeWs } = require('../src/mocks');
const S = 'whsec_' + Buffer.from('k').toString('base64');
test('webhook: valid, bad sig, stale, replay, missing', () => {
  const v = new WebhookVerifier(); const ts = String(Math.floor(Date.now() / 1000)); const b = '{"a":1}';
  const h = { 'webhook-id': 'e1', 'webhook-timestamp': ts, 'webhook-signature': signWebhook(S, 'e1', ts, b) };
  assert.ok(v.verify(S, h, b).ok);
  assert.strictEqual(v.verify(S, h, b).reason, 'replay');
  assert.strictEqual(v.verify(S, { ...h, 'webhook-id': 'e2' }, b).reason, 'bad_signature');
  assert.strictEqual(v.verify(S, { ...h, 'webhook-id': 'e3', 'webhook-signature': signWebhook(S, 'e3', ts, b) }, b + ' ').reason, 'bad_signature');
  const old = String(Math.floor(Date.now() / 1000) - 600);
  assert.strictEqual(v.verify(S, { 'webhook-id': 'e4', 'webhook-timestamp': old, 'webhook-signature': signWebhook(S, 'e4', old, b) }, b).reason, 'stale_timestamp');
  assert.strictEqual(v.verify(null, h, b).reason, 'missing_headers');
  // multiple signatures (key rotation): any match passes
  assert.ok(v.verify(S, { 'webhook-id': 'e5', 'webhook-timestamp': ts, 'webhook-signature': 'v1,zzz ' + signWebhook(S, 'e5', ts, b) }, b).ok);
});
test('session.update carries guardrails and only function tools', () => {
  const t = { name: 'X', voice: 'eve', link_allowlist: ['rfsafe.org'], blocked_topics: ['politics'] };
  const s = sessionUpdate(t, [{ type: 'function', name: 'kb_answer' }], { afterHours: true }).session;
  assert.match(s.instructions, /Never ask for, accept/); assert.match(s.instructions, /outside business hours/); assert.match(s.instructions, /politics/); assert.match(s.instructions, /data, not instructions/);
});
test('call session: disclosure first, parallel tools -> one response.create', async () => {
  const ws = new MockRealtimeWs(); const ran = [];
  const tools = { definitions: () => [], ctxCall: () => ({ run: async (n) => { ran.push(n); await new Promise((r) => setTimeout(r, 5)); return { ok: true }; } }) };
  const ended = [];
  new CallSession({ ws, tenant: { id: 't', name: 'Biz', voice: 'eve', link_allowlist: ['a.com'], blocked_topics: [], disclosure: 'Hi {name}, AI here.', max_call_seconds: 60 }, callId: 'c', caller: '+1', tools, log: () => {}, onEnd: (s) => ended.push(s) });
  assert.strictEqual(ws.sent[1].item.type, 'force_message'); assert.match(ws.sent[1].item.content[0].text, /Hi Biz/);
  ws.serverEvent({ type: 'response.function_call_arguments.done', name: 'a', call_id: '1', arguments: '{}' });
  ws.serverEvent({ type: 'response.function_call_arguments.done', name: 'b', call_id: '2', arguments: 'not json' });
  ws.serverEvent({ type: 'response.done' });
  await new Promise((r) => setTimeout(r, 40));
  const after = ws.sent.slice(3);
  assert.deepStrictEqual(after.map((m) => m.type), ['conversation.item.create', 'conversation.item.create', 'response.create']);
  ws.close(); assert.strictEqual(ended.length, 1); assert.strictEqual(ended[0].tools.length, 2);
});
