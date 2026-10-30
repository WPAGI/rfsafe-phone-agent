#!/usr/bin/env node
'use strict';
// Local demo: EXAMPLE DATA + mock xAI/Twilio/Shopify. Simulates one phone call and three SMS threads
// end-to-end through the real HTTP handlers. No network calls, no credentials.
const http = require('http'); const path = require('path'); const fs = require('fs'); const os = require('os');
const { buildDeps } = require('../src/runtime'); const { createApp } = require('../src/app');
const { signWebhook } = require('../src/xai'); const { twilioSignature } = require('../src/twilio');

(async () => {
  const env = { DEMO_XAI_WEBHOOK_SECRET: 'whsec_' + Buffer.from('demo-webhook-secret-EXAMPLE').toString('base64'), DEMO_TWILIO_AUTH_TOKEN: 'demo-twilio-token-EXAMPLE', PUBLIC_BASE_URL: 'http://localhost:0' };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-demo-'));
  const logs = []; const log = (e, f) => { logs.push({ e, ...f }); console.log('  log', e, JSON.stringify(f)); };
  const deps = buildDeps({ mode: 'demo', env, tenantsDir: path.join(__dirname, 'tenants'), dataDir, log });
  // Pin "now" to a weekday 10:00 ET so transfer is in hours.
  deps.now = () => new Date('2026-10-29T14:00:00Z');
  let ws; const orig = deps.openRealtime; deps.openRealtime = async (...a) => (ws = await orig(...a));
  const app = createApp(deps); const srv = http.createServer(app.handler);
  await new Promise((r) => srv.listen(0, r)); const base = 'http://127.0.0.1:' + srv.address().port; deps.publicBaseUrl = base;
  console.log('=== EXAMPLE DATA DEMO (mock xAI, mock Twilio, mock Shopify) ===\n');

  console.log('1) Incoming call to the RF Safe demo number');
  const body = JSON.stringify({ object: 'event', id: 'evt_demo1', type: 'realtime.call.incoming', created_at: 0, data: { call_id: 'call_demo_1', sip_headers: [{ name: 'From', value: '+17275550142' }, { name: 'To', value: '+17275550100' }] } });
  const ts = String(Math.floor(Date.now() / 1000));
  deps.now = () => new Date('2026-10-29T14:00:00Z');
  const r = await fetch(base + '/xai/webhook', { method: 'POST', body, headers: { 'webhook-id': 'evt_demo1', 'webhook-timestamp': ts, 'webhook-signature': signWebhook(env.DEMO_XAI_WEBHOOK_SECRET, 'evt_demo1', ts, body) } });
  console.log('  webhook ->', r.status, await r.text());
  await new Promise((r) => setTimeout(r, 50));
  console.log('  sent to xAI:', ws.sent.map((m) => m.type + (m.item ? ':' + m.item.type : '')).join(', '));
  console.log('  tools offered:', ws.sent[0].session.tools.map((t) => t.name).join(', '));
  const step = async (name, args) => { ws.serverEvent({ type: 'response.function_call_arguments.done', name, call_id: 'fc_' + name, arguments: JSON.stringify(args) }); ws.serverEvent({ type: 'response.done' }); await new Promise((r) => setTimeout(r, 30)); const out = ws.sent.filter((m) => m.item && m.item.type === 'function_call_output').pop(); console.log(`  tool ${name}(${JSON.stringify(args)}) ->`, out.item.output.slice(0, 220)); };
  await step('kb_answer', { question: 'What is SAR?' });
  await step('product_search', { query: 'iphone 17' });
  await step('send_link', { url: 'https://quantacase.com/products/example-quantacase-iphone-17', note: 'Here is the case we talked about' });
  await step('send_link', { url: 'https://evil.example/pay', note: 'pay here' });
  await step('send_link', { url: 'https://quantacase.com/x', note: 'card 4242 4242 4242 4242' });
  await step('transfer_to_human', { reason: 'caller asked' });
  ws.close();

  console.log('\n2) SMS threads');
  const sms = async (from, text, to = '+17275550100') => { const p = { From: from, To: to, Body: text, MessageSid: 'SM_demo' }; const res = await fetch(base + '/twilio/sms', { method: 'POST', body: new URLSearchParams(p), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(env.DEMO_TWILIO_AUTH_TOKEN, base + '/twilio/sms', p) } }); console.log(`  "${text}" ->`, res.status, (await res.text()).replace(/<[^>]+>/g, ' ').trim()); };
  await sms('+17275550177', 'How much is the case for iphone 17?');
  await sms('+17275550177', 'what is SAR');
  await sms('+17275550177', 'HELP');
  await sms('+17275550177', 'STOP');
  console.log('\n  mock Twilio outbound (would-be texts):', JSON.stringify(deps.smsFor(deps.tenants.get('rfsafe-demo')).sent));
  console.log('  mock xAI transfers:', JSON.stringify(deps._mocks.callControl.refers));
  console.log('\n3) Forged webhook (bad signature) ->', (await fetch(base + '/xai/webhook', { method: 'POST', body, headers: { 'webhook-id': 'evt_x', 'webhook-timestamp': ts, 'webhook-signature': 'v1,AAAA' } })).status);
  console.log('\nOwner outbox (call summaries/messages) at', path.join(dataDir, 'owner-outbox.jsonl'));
  srv.close(); console.log('\n=== demo complete ===');
})().catch((e) => { console.error(e); process.exit(1); });
