'use strict';
const test = require('node:test'); const assert = require('node:assert'); const path = require('path'); const fs = require('fs');
const { ShopifyClient, assertReadOnlyQuery } = require('../src/shopify');
const { mockShopifyFetch } = require('../src/mocks');
const { KB } = require('../src/kb');
test('shopify client is read-only', async () => {
  assert.throws(() => assertReadOnlyQuery('mutation { checkoutCreate { id } }'));
  assert.throws(() => assertReadOnlyQuery('query { a } mutation { b }'));
  assert.doesNotThrow(() => assertReadOnlyQuery('query { products(first:1){edges{node{title}}} }'));
  const f = mockShopifyFetch(); const c = new ShopifyClient({ shop: 'quantacase.com', fetchImpl: f });
  const r = await c.searchProducts('iphone'); assert.strictEqual(r[0].url, 'https://quantacase.com/products/example-quantacase-iphone-17');
  assert.ok(f.calls.every((x) => x.method === 'GET'));
  assert.throws(() => new ShopifyClient({ shop: 'evil.com/../x' }));
});
test('order status needs admin token and matching caller phone; returns no PII', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ orders: [{ name: '#1001', phone: '+1 (727) 555-0142', fulfillment_status: 'fulfilled', fulfillments: [{ tracking_company: 'USPS' }], email: 'x@y.z' }] }) });
  assert.strictEqual((await new ShopifyClient({ shop: 'a.myshopify.com', fetchImpl }).orderStatus({ orderName: '1001', callerPhone: '+17275550142' })).reason, 'order_lookup_not_connected');
  const c = new ShopifyClient({ shop: 'a.myshopify.com', adminToken: 'x', fetchImpl });
  assert.strictEqual((await c.orderStatus({ orderName: '1001', callerPhone: '+17275550000' })).reason, 'not_found_or_not_verified');
  const ok = await c.orderStatus({ orderName: '1001', callerPhone: '+17275550142' });
  assert.deepStrictEqual(Object.keys(ok).sort(), ['cancelled', 'fulfillment_status', 'ok', 'order', 'tracking_company']);
});
test('KB answers with allowlisted sources only and admits when it has nothing', () => {
  const kb = new KB({ dirs: [path.join(__dirname, '../demo/kb/rfsafe')], allowlist: ['rfsafe.org', 'quantacase.com'] });
  const a = kb.answer('what does SAR mean'); assert.ok(a.found); assert.match(a.passages[0].text, /Specific Absorption Rate/); assert.strictEqual(a.passages[0].source, 'https://rfsafe.org/example-what-is-sar');
  assert.strictEqual(kb.answer('zebra migration patterns').found, false);
  const kb2 = new KB({ allowlist: ['rfsafe.org'] }); kb2.addDoc({ title: 't', source: 'https://evil.com/x', body: 'radiation facts here' });
  assert.strictEqual(kb2.search('radiation')[0].source, null);
});
test('KB loads the real brain wiki export (if present on this machine)', { skip: !fs.existsSync('/workspace/brain/wiki/answers') }, () => {
  const kb = new KB({ dirs: ['/workspace/brain/wiki/answers'], allowlist: ['rfsafe.org', 'quantacase.com'] });
  assert.ok(kb.docs.length > 10); assert.ok(kb.answer('SAR limit FCC').found);
});
