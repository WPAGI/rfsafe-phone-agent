'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { ShopifyClient, ShopifyAdmin, assertReadOnlyQuery } = require('../src/shopify');
const { Tools, Approvals } = require('../src/tools');

const SECRET = 'shpss_EXAMPLE_client_secret_value';
const ORDER = { name: '#1146', createdAt: '2026-10-30T12:00:00Z', cancelledAt: null, displayFulfillmentStatus: 'FULFILLED', email: 'Jane.Doe@example.com', phone: null,
  customer: { defaultEmailAddress: { emailAddress: 'jane.doe@example.com' }, defaultPhoneNumber: { phoneNumber: '+1 (555) 555-0142' } },
  shippingAddress: { address1: '1 Secret St', city: 'Tampa', provinceCode: 'FL', countryCodeV2: 'US', phone: null },
  lineItems: { nodes: [{ title: 'QuantaCase iPhone 17', quantity: 1 }] },
  fulfillments: [{ displayStatus: 'IN_TRANSIT', estimatedDeliveryAt: '2026-11-02T00:00:00Z', deliveredAt: null, trackingInfo: [{ company: 'USPS', number: '9400111899223344556677' }] }] };

function fakeShop({ expiresIn = 86399, failFirstGql401 = false } = {}) {
  const calls = []; let n = 0; let first = true;
  const f = async (url, opts = {}) => {
    calls.push({ url, method: opts.method, body: opts.body, headers: opts.headers });
    if (url.endsWith('/admin/oauth/access_token')) {
      const p = new URLSearchParams(opts.body);
      if (p.get('grant_type') !== 'client_credentials' || p.get('client_secret') !== SECRET) return { ok: false, status: 401, json: async () => ({}) };
      n++; return { ok: true, status: 200, json: async () => ({ access_token: 'shpat_tok' + n, scope: 'read_orders', expires_in: expiresIn }) };
    }
    if (url.includes('/admin/api/2026-10/graphql.json')) {
      if (failFirstGql401 && first) { first = false; return { ok: false, status: 401, json: async () => ({}) }; }
      const { variables } = JSON.parse(opts.body);
      const num = variables.q.replace('name:', '');
      return { ok: true, status: 200, json: async () => ({ data: { orders: { nodes: num === '1146' ? [ORDER] : [] } } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  f.calls = calls; return f;
}
const mkAdmin = (f, now) => new ShopifyAdmin({ shop: 'example-store.myshopify.com', clientId: 'cid', clientSecret: SECRET, fetchImpl: f, now });

test('admin token: client_credentials, cached, refreshed before expiry, single-flight', async () => {
  const f = fakeShop(); let t = 0; const a = mkAdmin(f, () => t);
  const [x, y] = await Promise.all([a.token(), a.token()]); assert.strictEqual(x, 'shpat_tok1'); assert.strictEqual(y, x);
  t = 23 * 3600e3; assert.strictEqual(await a.token(), 'shpat_tok1');
  t = 23.9 * 3600e3; assert.strictEqual(await a.token(), 'shpat_tok2'); // inside the 10-minute early window
  assert.strictEqual(f.calls.filter((c) => c.url.endsWith('access_token')).length, 2);
});
test('admin: 401 drops the token and retries once; secret never serialized', async () => {
  const f = fakeShop({ failFirstGql401: true }); const a = mkAdmin(f);
  const j = await a.query('query($q:String!){ orders(first:1, query:$q){ nodes{ name } } }', { q: 'name:1146' });
  assert.strictEqual(j.data.orders.nodes[0].name, '#1146');
  assert.strictEqual(f.calls.filter((c) => c.url.endsWith('access_token')).length, 2);
  assert.ok(!JSON.stringify(a).includes(SECRET)); assert.ok(!JSON.stringify(a).includes('shpat_'));
  await assert.rejects(a.query('mutation { orderCancel(orderId:"x"){ job{ id } } }'), /read-only/);
  assert.throws(() => assertReadOnlyQuery('subscription { x }'));
  assert.throws(() => new ShopifyAdmin({ shop: 'evil.com', clientId: 'a', clientSecret: 'b' }));
});
function client(f) { return new ShopifyClient({ shop: 'quantacase.com', mode: 'public', admin: mkAdmin(f || fakeShop()), fetchImpl: async () => ({ ok: false }) }); }
test('order: needs order number plus matching email or phone; same answer for miss and mismatch', async () => {
  const c = client();
  assert.strictEqual((await c.orderStatus({ orderName: '1146' })).reason, 'need_email_or_phone');
  assert.strictEqual((await c.orderStatus({ orderName: 'abc', email: 'jane.doe@example.com' })).reason, 'bad_order_number');
  assert.strictEqual((await c.orderStatus({ orderName: '1146', email: 'other@example.com', callerPhone: '+15555550199' })).reason, 'not_found_or_not_verified');
  assert.strictEqual((await c.orderStatus({ orderName: '9999', email: 'jane.doe@example.com' })).reason, 'not_found_or_not_verified');
  assert.ok((await c.orderStatus({ orderName: '#1146', email: ' JANE.DOE@example.com ' })).ok);
  assert.ok((await c.orderStatus({ orderName: '1146', email: 'jane dot doe at example dot com' })).ok);
  assert.ok((await c.orderStatus({ orderName: '1146', callerPhone: '+15555550142' })).ok); // caller ID
  assert.ok((await c.orderStatus({ orderName: '1146', phone: '555-555-0142', callerPhone: '+19999999999' })).ok);
  assert.strictEqual((await new ShopifyClient({ shop: 'quantacase.com' }).orderStatus({ orderName: '1146', email: 'x@y.co' })).reason, 'order_lookup_not_connected');
});
test('order: returns status only, never street address, payment, prices, or full tracking number', async () => {
  const r = await client().orderStatus({ orderName: '1146', email: 'jane.doe@example.com' });
  assert.deepStrictEqual(Object.keys(r).sort(), ['cancelled', 'fulfillment_status', 'items', 'ok', 'order', 'placed', 'shipments', 'ships_to'].sort());
  assert.strictEqual(r.ships_to, 'Tampa, FL'); assert.strictEqual(r.shipments[0].tracking[0].number_last4, '6677');
  const s = JSON.stringify(r);
  for (const bad of ['Secret St', 'jane', '555-0142', '9400111899223344556677', 'price', 'amount', 'card', 'gateway']) assert.ok(!s.toLowerCase().includes(bad.toLowerCase()), bad);
});
test('tool: only when enabled; 3 failed checks lock the call; card numbers refused', async () => {
  const shop = client(); const logs = [];
  const mk = (over) => new Tools({ id: 'r', name: 'R', numbers: [], link_allowlist: ['quantacase.com'], shopify: { shop: 'quantacase.com', mode: 'public' }, order_lookup_enabled: true, ...over }, { kbFor: () => null, shopifyFor: () => shop, approvals: new Approvals(), log: (e, d) => logs.push([e, d]) });
  const ctx = { channel: 'voice', callId: 'c1', caller: '+15555550100' };
  assert.strictEqual((await mk({ order_lookup_enabled: false }).run('order_status', { order_number: '1146' }, ctx)).error, 'unknown_tool');
  const tools = mk();
  assert.ok(tools.definitions().some((d) => d.name === 'order_status' && d.parameters.properties.email));
  assert.ok(!tools.definitions().some((d) => /pay|charge|refund|cancel/.test(d.name)));
  assert.ok((await tools.run('order_status', { order_number: '1146', email: 'jane.doe@example.com' }, ctx)).ok);
  for (let i = 0; i < 3; i++) assert.strictEqual((await tools.run('order_status', { order_number: '1146', email: 'x' + i + '@example.com' }, ctx)).error, 'not_found_or_not_verified');
  assert.strictEqual((await tools.run('order_status', { order_number: '1146', email: 'jane.doe@example.com' }, ctx)).error, 'too_many_attempts');
  assert.ok((await tools.run('order_status', { order_number: '1146', email: 'jane.doe@example.com' }, { ...ctx, callId: 'c2' })).ok);
  assert.strictEqual((await tools.run('order_status', { order_number: '1146', email: '4111 1111 1111 1111' }, { ...ctx, callId: 'c3' })).error, 'payment_details_refused');
  assert.ok(!JSON.stringify(logs).includes('jane'));
});
test('admin PATCH: shopify/order_lookup_enabled accepted; credentials and bad domains rejected', async () => {
  const { startApp } = require('./helpers');
  const a = await startApp(); const id = a.deps.tenants.list()[0].id;
  const auth = { authorization: 'Bearer ' + a.deps.adminToken, 'content-type': 'application/json' };
  const patch = (b) => fetch(a.base + '/admin/tenants/' + id, { method: 'PATCH', headers: auth, body: JSON.stringify(b) });
  try {
    assert.strictEqual((await patch({ shopify: { shop: 'quantacase.com', mode: 'public', public_domain: 'quantacase.com', admin_shop: 'rf-safe-quantacase.myshopify.com' }, order_lookup_enabled: true })).status, 200);
    assert.strictEqual(a.deps.tenants.get(id).order_lookup_enabled, true);
    assert.strictEqual((await patch({ shopify: { shop: 'quantacase.com', mode: 'public', client_secret: 'x' } })).status, 400);
    assert.strictEqual((await patch({ shopify: { shop: 'quantacase.com', mode: 'public', admin_shop: 'evil.com' } })).status, 400);
    assert.strictEqual((await patch({ order_lookup_enabled: 'yes' })).status, 400);
    assert.strictEqual((await patch({ secrets: { shopify_client_secret: 'env:X' } })).status, 400);
  } finally { await a.close(); }
});
test('runtime: SHOPIFY_ADMIN_* env binds only to the tenant whose admin_shop matches', () => {
  const path = require('path'); const fs = require('fs'); const os = require('os');
  const { buildDeps } = require('../src/runtime'); const { ENV } = require('./helpers');
  const env = { ...ENV, SHOPIFY_ADMIN_SHOP: 'rf-safe-quantacase.myshopify.com', SHOPIFY_ADMIN_CLIENT_ID: 'cid', SHOPIFY_ADMIN_CLIENT_SECRET: SECRET };
  const d = buildDeps({ mode: 'demo', env, tenantsDir: path.join(__dirname, '../demo/tenants'), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pa-o-')), log: () => {} });
  const base = { id: 'z1', shopify: { shop: 'quantacase.com', mode: 'public', admin_shop: 'rf-safe-quantacase.myshopify.com' }, order_lookup_enabled: true };
  assert.ok(d.shopifyFor(base).admin);
  assert.strictEqual(d.shopifyFor({ ...base, id: 'z2', shopify: { ...base.shopify, admin_shop: 'other.myshopify.com' } }).admin, null);
  assert.strictEqual(d.shopifyFor({ ...base, id: 'z3', order_lookup_enabled: false }).admin, null);
});
