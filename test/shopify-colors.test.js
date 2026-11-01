'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { ShopifyClient, summarizeOptions } = require('../src/shopify');
const { Tools } = require('../src/tools');

const AIR = { handle: 'rf-safe-apple-iphone-17-air-quantacase', title: 'RF Safe Apple iPhone 17 Air QuantaCase', price: '69.99', available: true };
const PRO = { handle: 'rf-safe-iphone-17-pro-quantacase', title: 'RF Safe Apple iPhone 17 Pro QuantaCase', price: '69.00', available: true };
const AIR_JS = { handle: AIR.handle, options: [{ name: 'Color', position: 1, values: ['Black', 'Brown'] }], variants: [{ id: 111, title: 'Black', available: true, price: 6999 }, { id: 222, title: 'Brown', available: false, price: 6999 }] };

function fetchMock({ failJs = false, hangJs = false } = {}) {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET' });
    if (url.includes('/search/suggest.json')) return { ok: true, status: 200, json: async () => ({ resources: { results: { products: [AIR, PRO] } } }) };
    if (url.endsWith('.js')) {
      if (hangJs) return new Promise(() => {});
      if (failJs || !url.includes(AIR.handle)) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => AIR_JS };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  f.calls = calls; return f;
}

test('public mode: iPhone 17 Air case lists Brown unavailable, Black available', async () => {
  const f = fetchMock(); const c = new ShopifyClient({ shop: 'quantacase.com', fetchImpl: f });
  const r = await c.searchProducts('iphone 17 air');
  assert.deepStrictEqual(r[0].options, [{ name: 'Color', values: ['Black', 'Brown'] }]);
  assert.deepStrictEqual(r[0].variants, [{ id: 111, title: 'Black', available: true, price: 69.99 }, { id: 222, title: 'Brown', available: false, price: 69.99 }]);
  const so = summarizeOptions(r[0]); assert.deepStrictEqual(so[0].available, ['Black']); assert.deepStrictEqual(so[0].unavailable, ['Brown']);
  assert.strictEqual(r[1].options, undefined); assert.strictEqual(r[1].title, PRO.title);
  assert.ok(f.calls.every((x) => x.method === 'GET'));
  assert.ok(f.calls.some((x) => x.url === `https://quantacase.com/products/${AIR.handle}.js`));
  
});

test('product_search tool output is compact: colors per product, no raw variants', async () => {
  const c = new ShopifyClient({ shop: 'quantacase.com', fetchImpl: fetchMock() });
  const tools = new Tools({ id: 't', shopify: {}, link_allowlist: ['quantacase.com'] }, { shopifyFor: () => c, kbFor: () => ({}) });
  const out = await tools.run('product_search', { query: 'iphone 17 air' }, { channel: 'sms', caller: '+17275550142' });
  assert.ok(out.ok);
  const o0 = out.products[0].options[0]; assert.deepStrictEqual([o0.name, o0.available, o0.unavailable], ['Color', ['Black'], ['Brown']]);
  assert.ok(!('variants' in out.products[0])); assert.ok(!('handle' in out.products[0])); assert.ok(!('options' in out.products[1]));
  assert.match(tools.definitions().find((d) => d.name === 'product_search').description, /color/i);
});

test('public mode: product .js failure or timeout keeps the base results', async () => {
  const c = new ShopifyClient({ shop: 'quantacase.com', fetchImpl: fetchMock({ failJs: true }) });
  const r = await c.searchProducts('iphone');
  assert.deepStrictEqual(r.map((p) => p.title), [AIR.title, PRO.title]); assert.strictEqual(r[0].options, undefined); assert.strictEqual(r[0].price, '69.99');
  const c2 = new ShopifyClient({ shop: 'quantacase.com', fetchImpl: fetchMock({ hangJs: true }) });
  const t0 = Date.now(); const r2 = await c2.searchProducts('iphone');
  assert.strictEqual(r2.length, 2); assert.ok(Date.now() - t0 < 4000);
});

test('storefront mode maps options and variants', async () => {
  let body;
  const f = async (url, opts) => { body = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ data: { products: { edges: [{ node: { title: AIR.title, handle: AIR.handle, availableForSale: true, priceRange: { minVariantPrice: { amount: '69.99', currencyCode: 'USD' } },
    options: [{ name: 'Color', values: ['Black', 'Brown'] }], variants: { nodes: [{ title: 'Black', availableForSale: true, price: { amount: '69.99' } }, { title: 'Brown', availableForSale: false, price: { amount: '69.99' } }] } } }] } } }) }; };
  const c = new ShopifyClient({ shop: 'quantacase.myshopify.com', mode: 'storefront', storefrontToken: 'x', fetchImpl: f });
  const r = await c.searchProducts('air');
  assert.match(body.query, /options\{ name values \}/); assert.match(body.query, /variants\(first:20\)/);
  assert.deepStrictEqual(r[0].options, [{ name: 'Color', values: ['Black', 'Brown'] }]);
  assert.deepStrictEqual(r[0].variants.map(({ title, available, price }) => ({ title, available, price })), [{ title: 'Black', available: true, price: 69.99 }, { title: 'Brown', available: false, price: 69.99 }]);
});
