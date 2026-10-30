'use strict';
const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs'); const http = require('http');
const { startApp, ENV } = require('./helpers');
const { signWebhook } = require('../src/xai'); const { twilioSignature } = require('../src/twilio');

const post = (base, p, body, headers) => fetch(base + p, { method: 'POST', body, headers });
function signedSms(base, path, params, token) {
  return post(base, path, new URLSearchParams(params), { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(token, base + path, params) });
}
function rawGet(base, path, headers) {
  const u = new URL(base + path);
  return new Promise((resolve) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path, method: 'GET', headers }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] || '' }));
    });
    req.end();
  });
}

test('landing page and health are public', async () => {
  const a = await startApp();
  try {
    const home = await rawGet(a.base, '/');
    assert.strictEqual(home.status, 200);
    assert.match(home.type, /text\/html/);
    assert.match(home.body, /<title>[^<]*AI Phone Agent[^<]*CallBots<\/title>/);
    assert.match(home.body, /rel="canonical" href="https:\/\/callbots\.org\/"/);
    assert.match(home.body, /application\/ld\+json/);
    const ldMatch = home.body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    const ld = JSON.parse(ldMatch[1]);
    const types = ld['@graph'].map((node) => node['@type']);
    assert.ok(types.includes('FAQPage'));
    assert.ok(types.includes('SoftwareApplication'));
    assert.ok(types.includes('Organization'));
    assert.ok(ld['@graph'].find((node) => node['@type'] === 'FAQPage').mainEntity.length >= 8);
    assert.match(home.body, /Quanta X Technology LLC/);
    assert.match(home.body, /Seminole/);
    assert.match(home.body, /never takes a payment/i);
    assert.match(home.body, /support@quantaxtechnology\.com/);
    assert.doesNotMatch(home.body, /RF Safe|EMF|\bSAR\b/);
    const robots = await fetch(a.base + '/robots.txt');
    assert.strictEqual(robots.status, 200);
    assert.match(await robots.text(), /Sitemap: https:\/\/callbots\.org\/sitemap\.xml/);
    const map = await fetch(a.base + '/sitemap.xml');
    assert.strictEqual(map.status, 200);
    assert.match(await map.text(), /<loc>https:\/\/callbots\.org\/<\/loc>/);
    const icon = await fetch(a.base + '/favicon.ico');
    assert.strictEqual(icon.status, 200);
    assert.match(icon.headers.get('content-type'), /image\/x-icon/);
    const svg = await fetch(a.base + '/favicon');
    assert.strictEqual(svg.status, 200);
    assert.match(await svg.text(), /<svg/);
    const health = await fetch(a.base + '/health');
    assert.strictEqual(health.status, 200);
    const body = await health.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.mode, 'demo');
    assert.ok(body.tenants >= 1);
  } finally { await a.close(); }
});

test('admin checklist requires the token and hides secret values', async () => {
  const a = await startApp();
  try {
    assert.strictEqual((await rawGet(a.base, '/admin')).status, 401);
    const blocked = await rawGet(a.base, '/admin', { authorization: 'Bearer ' + a.deps.adminToken, host: 'rfsafe-phone-agent.onrender.com' });
    assert.strictEqual(blocked.status, 401);
    const ok = await rawGet(a.base, '/admin', { authorization: 'Bearer ' + a.deps.adminToken, host: '127.0.0.1' });
    assert.strictEqual(ok.status, 200);
    const report = JSON.parse(ok.body);
    assert.strictEqual(report.ready_for_live, false);
    assert.ok(report.checks.some((c) => c.id === 'XAI_API_KEY' && c.ok === false));
    assert.ok(report.checks.some((c) => c.id === 'tenant:rfsafe-demo:a2p_sms'));
    assert.ok(!ok.body.includes(ENV.DEMO_XAI_WEBHOOK_SECRET));
    assert.ok(!ok.body.includes(a.deps.adminToken));
    assert.ok(!ok.body.includes('+17275550100'));
  } finally { await a.close(); }
});

test('Twilio voice fallback, recording, and SMS status callbacks verify signatures', async () => {
  const a = await startApp();
  const token = ENV.DEMO_TWILIO_AUTH_TOKEN;
  try {
    const bad = { From: '+17275550142', To: '+17275550100', CallSid: 'CA_voice' };
    assert.strictEqual((await signedSms(a.base, '/twilio/voice', bad, 'wrong')).status, 403);
    const voice = await signedSms(a.base, '/twilio/voice', bad, token);
    const xml = await voice.text();
    assert.strictEqual(voice.status, 200);
    assert.match(xml, /<Say>/);
    assert.match(xml, /<Record /);
    assert.match(xml, /never take payment/);
    assert.match(xml, /\/twilio\/voice\/recording/);
    const rec = { From: '+17275550142', To: '+17275550100', CallSid: 'CA_voice', RecordingSid: 'RE_example' };
    assert.strictEqual((await signedSms(a.base, '/twilio/voice/recording', rec, token)).status, 200);
    const status = { From: '+17275550100', To: '+17275550999', MessageSid: 'SM_status', MessageStatus: 'delivered' };
    const st = await signedSms(a.base, '/twilio/sms/status', status, token);
    assert.strictEqual(st.status, 204);
    const dumped = JSON.stringify(a.logs);
    assert.match(dumped, /sms\.status/);
    assert.match(dumped, /voicemail\.saved/);
    assert.ok(!dumped.includes('7275550142'));
    assert.ok(!dumped.includes('7275550999'));
    assert.ok(!dumped.includes(token));
  } finally { await a.close(); }
});

test('voice fallback says the team is away outside business hours', async () => {
  const a = await startApp({ now: () => new Date('2026-10-30T02:00:00Z') });
  try {
    const params = { From: '+17275550142', To: '+17275550100', CallSid: 'CA_late' };
    const xml = await (await signedSms(a.base, '/twilio/voicemail', params, ENV.DEMO_TWILIO_AUTH_TOKEN)).text();
    assert.match(xml, /away right now/);
  } finally { await a.close(); }
});

test('SMS HELP and START are handled and call-end is logged without the caller number', async () => {
  const a = await startApp();
  const token = ENV.DEMO_TWILIO_AUTH_TOKEN;
  const from = '+17275550188';
  try {
    const help = await signedSms(a.base, '/twilio/sms', { From: from, To: '+17275550100', Body: 'HELP' }, token);
    assert.match(await help.text(), /Reply STOP/);
    const start = await signedSms(a.base, '/twilio/sms', { From: from, To: '+17275550100', Body: 'START' }, token);
    assert.match(await start.text(), /resubscribed/);
    assert.ok(a.deps.consent.canText('rfsafe-demo', from));
    const id = 'evt_end_1'; const ts = String(Math.floor(Date.now() / 1000));
    const ended = JSON.stringify({ type: 'realtime.call.ended', data: { call_id: 'c_end', sip_headers: [{ name: 'To', value: '+17275550100' }, { name: 'From', value: from }] } });
    const r = await post(a.base, '/xai/webhook', ended, { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signWebhook(ENV.DEMO_XAI_WEBHOOK_SECRET, id, ts, ended) });
    assert.strictEqual(r.status, 200);
    assert.ok(a.logs.some((l) => l.e === 'call.ended_webhook'));
    const incomingId = 'evt_in_1';
    const incoming = JSON.stringify({ type: 'realtime.call.incoming', data: { call_id: 'c_in', sip_headers: [{ name: 'To', value: '+17275550100' }, { name: 'From', value: from }] } });
    await post(a.base, '/xai/webhook', incoming, { 'webhook-id': incomingId, 'webhook-timestamp': ts, 'webhook-signature': signWebhook(ENV.DEMO_XAI_WEBHOOK_SECRET, incomingId, ts, incoming) });
    await new Promise((done) => setTimeout(done, 20));
    a.ws().close();
    await new Promise((done) => setTimeout(done, 20));
    const lines = fs.readFileSync(a.deps.callLog, 'utf8');
    assert.match(lines, /c_in/);
    assert.ok(!lines.includes('7275550188'));
  } finally { await a.close(); }
});
