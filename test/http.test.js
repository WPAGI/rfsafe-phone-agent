'use strict';
const test = require('node:test'); const assert = require('node:assert'); const crypto = require('crypto');
const { startApp, ENV } = require('./helpers');
const { signWebhook } = require('../src/xai'); const { twilioSignature } = require('../src/twilio');
const ob = require('../src/onboarding');
const call = (to, id = 'evt_' + Math.random()) => { const body = JSON.stringify({ id, type: 'realtime.call.incoming', data: { call_id: 'c_' + id, sip_headers: [{ name: 'From', value: '+17275550142' }, { name: 'To', value: to }] } }); return { id, body }; };
const post = (base, p, body, headers) => fetch(base + p, { method: 'POST', body, headers });
test('xAI webhook: signed call accepted; other tenant secret rejected; unknown number rejected', async () => {
  const a = await startApp(); const ts = String(Math.floor(Date.now() / 1000));
  try {
    let c = call('+17275550100'); let r = await post(a.base, '/xai/webhook', c.body, { 'webhook-id': c.id, 'webhook-timestamp': ts, 'webhook-signature': signWebhook(ENV.DEMO_XAI_WEBHOOK_SECRET, c.id, ts, c.body) });
    assert.strictEqual(r.status, 200); await new Promise((r) => setTimeout(r, 20)); assert.strictEqual(a.ws().sent[0].type, 'session.update');
    c = call('+17275550100'); r = await post(a.base, '/xai/webhook', c.body, { 'webhook-id': c.id, 'webhook-timestamp': ts, 'webhook-signature': signWebhook(ENV.DEMO_ACME_XAI_WEBHOOK_SECRET, c.id, ts, c.body) });
    assert.strictEqual(r.status, 401);
    c = call('+19995550100'); r = await post(a.base, '/xai/webhook', c.body, { 'webhook-id': c.id, 'webhook-timestamp': ts, 'webhook-signature': signWebhook(ENV.DEMO_XAI_WEBHOOK_SECRET, c.id, ts, c.body) });
    assert.strictEqual(r.status, 401);
  } finally { await a.close(); }
});
test('Twilio SMS: signature required, per-tenant token, guarded reply, STOP', async () => {
  const a = await startApp();
  const sms = (to, text, token) => { const p = { From: '+17275550177', To: to, Body: text }; return post(a.base, '/twilio/sms', new URLSearchParams(p), { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(token, a.base + '/twilio/sms', p) }); };
  try {
    assert.strictEqual((await sms('+17275550100', 'hi', 'wrong')).status, 403);
    assert.strictEqual((await sms('+14155550123', 'hi', ENV.DEMO_TWILIO_AUTH_TOKEN)).status, 403); // rfsafe token on acme number
    const r = await sms('+17275550100', 'price of the iphone 17 case', ENV.DEMO_TWILIO_AUTH_TOKEN); const x = await r.text();
    assert.strictEqual(r.status, 200); assert.match(x, /https:\/\/quantacase\.com\/products\//);
    assert.match(await (await sms('+17275550100', 'STOP', ENV.DEMO_TWILIO_AUTH_TOKEN)).text(), /unsubscribed/);
    assert.ok(!a.deps.consent.canText('rfsafe-demo', '+17275550177'));
    assert.match(await (await sms('+17275550100', '4111 1111 1111 1111 exp 12/29', ENV.DEMO_TWILIO_AUTH_TOKEN)).text(), /never take payment/);
  } finally { await a.close(); }
});
test('admin + onboarding: auth required, new tenant starts with texting off, Shopify OAuth state+HMAC', async () => {
  const a = await startApp();
  try {
    assert.strictEqual((await post(a.base, '/admin/tenants', '{}', {})).status, 401);
    const auth = { authorization: 'Bearer ' + a.deps.adminToken, 'content-type': 'application/json' };
    let r = await post(a.base, '/admin/tenants', JSON.stringify({ id: 'newbiz', name: 'New Biz', owner_email: 'o@example.org', link_allowlist: ['example.org'] }), auth);
    assert.strictEqual(r.status, 201); const st = (await r.json()).status; assert.strictEqual(st.find((s) => s.step === 'texting_registration_a2p').done, false);
    assert.strictEqual((await post(a.base, '/admin/tenants', JSON.stringify({ id: 'bad', name: 'B', link_allowlist: ['x.com'], secrets: { t: 'raw-token' } }), auth)).status, 400);
    r = await fetch(a.base + '/connect/shopify/start?tenant=newbiz&shop=newbiz.myshopify.com', { headers: auth, redirect: 'manual' });
    assert.strictEqual(r.status, 302); const loc = new URL(r.headers.get('location')); assert.strictEqual(loc.host, 'newbiz.myshopify.com'); assert.match(loc.searchParams.get('scope'), /unauthenticated_read_product_listings/);
    const state = loc.searchParams.get('state');
    const q = { code: 'abc', shop: 'newbiz.myshopify.com', state, timestamp: '1' };
    const hmac = crypto.createHmac('sha256', a.deps.shopifyApp.secret).update(Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join('&')).digest('hex');
    assert.strictEqual((await fetch(a.base + '/connect/shopify/callback?' + new URLSearchParams({ ...q, hmac: '00' }))).status, 400);
    r = await fetch(a.base + '/connect/shopify/callback?' + new URLSearchParams({ ...q, hmac })); assert.strictEqual(r.status, 200);
    const t = a.deps.tenants.get('newbiz'); assert.strictEqual(t.secrets.shopify_storefront_token, 'store:shopify_storefront_token');
    assert.ok(!JSON.stringify(t).includes('demo-storefront-token')); // token only in encrypted store
    assert.strictEqual(ob.readState(a.deps.stateSecret, state, 'twilio'), null); // state bound to provider
  } finally { await a.close(); }
});
test('logs never contain raw phone numbers or secrets', async () => {
  const a = await startApp(); const ts = String(Math.floor(Date.now() / 1000));
  try {
    const c = call('+17275550100'); await post(a.base, '/xai/webhook', c.body, { 'webhook-id': c.id, 'webhook-timestamp': ts, 'webhook-signature': signWebhook(ENV.DEMO_XAI_WEBHOOK_SECRET, c.id, ts, c.body) });
    await new Promise((r) => setTimeout(r, 20)); const s = JSON.stringify(a.logs);
    assert.ok(!s.includes('7275550142')); assert.ok(!s.includes('test-secret')); assert.ok(s.includes('call.started'));
  } finally { await a.close(); }
});
test('live mode refuses to start without required env', () => {
  const { buildDeps } = require('../src/runtime');
  assert.throws(() => buildDeps({ mode: 'live', env: {}, tenantsDir: __dirname + '/../demo/tenants', dataDir: require('os').tmpdir() }), /missing env/);
});
