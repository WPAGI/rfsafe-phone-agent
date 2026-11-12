'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { ShopifyClient } = require('../src/shopify');
const { Tools } = require('../src/tools');

const BASE = { handle: 'iphone-14', title: 'iPhone 14 RFS1 Anti-Radiation Case', price: '69.99', available: true };
const PRO = { handle: 'iphone-14-pro', title: 'iPhone 14 Pro RFS1 Anti-Radiation Case', price: '69.99', available: true };
const PRO_MAX = { handle: 'iphone-14-pro-max', title: 'iPhone 14 Pro Max QuantaCase Anti-Radiation RF Safe Case', price: '69.99', available: true };
const PLUS = { handle: 'iphone-14-plus', title: 'iPhone 14 Plus', price: '69.99', available: true };
const LONG = { handle: 'iphone-14-special', title: 'iPhone 14 Special Edition', price: '69.99', available: true };
const BRANDED = { handle: 'iphone-14', title: 'RF Safe® Apple iPhone 14 QuantaCase Anti-Radiation Case', price: '69.99', available: true };
const JS14 = { handle: 'iphone-14', title: 'iPhone 14 RFS1 Anti-Radiation Case', available: true, price: 6999, options: [{ name: 'Color', values: ['Black'] }], variants: [{ id: 44049400889623, title: 'Black', available: true, price: 6999 }] };

function fetchMock({ suggest = [], js = {}, hang = [] } = {}) {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push(url);
    if ((opts.method || 'GET') !== 'GET') return { ok: false, status: 405, json: async () => ({}) };
    if (url.includes('/search/suggest.json')) return { ok: true, status: 200, json: async () => ({ resources: { results: { products: suggest } } }) };
    const m = url.match(/\/products\/([^/?#]+)\.js$/);
    if (m) {
      const h = decodeURIComponent(m[1]);
      if (hang.includes(h)) return new Promise(() => {});
      if (Object.prototype.hasOwnProperty.call(js, h)) return { ok: true, status: 200, json: async () => js[h] };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  f.calls = calls; return f;
}
const client = (opts) => new ShopifyClient({ shop: 'quantacase.com', fetchImpl: fetchMock(opts) });
const handles = (rows) => rows.map((p) => p.handle);

test('iPhone 14: exact handle missed by suggest is merged first and in stock', async () => {
  const f = fetchMock({ suggest: [PRO, PRO_MAX, { handle: 'rf-safe-iphone-17-pro', title: 'RF Safe Apple iPhone 17 Pro QuantaCase', price: '69.00', available: true }], js: { 'iphone-14': JS14 } });
  const c = new ShopifyClient({ shop: 'quantacase.com', fetchImpl: f });
  const r = await c.searchProducts('iPhone 14');
  assert.strictEqual(r[0].handle, 'iphone-14');
  assert.strictEqual(r[0].available, true);
  assert.strictEqual(r[0].price, '69.99');
  assert.deepStrictEqual(r[0].options, [{ name: 'Color', values: ['Black'] }]);
  assert.ok(f.calls.some((u) => u.includes('resources[limit]=10')));
  assert.ok(f.calls.some((u) => u.endsWith('/products/iphone-14.js')));
  assert.ok(f.calls.every((u) => !u.includes('POST')));
  const noisy = await client({ suggest: [], js: { 'iphone-14': JS14 } }).searchProducts('iPhone 14 RFS1 anti-radiation case');
  assert.strictEqual(noisy[0].handle, 'iphone-14');
  assert.strictEqual(noisy[0].available, true);
});

test('exact model at suggest index 8 is ranked first', async () => {
  const decoys = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ handle: `iphone-${i}-pro`, title: `iPhone ${i} Pro Case`, price: '69.99', available: true }));
  const suggest = [...decoys, BASE];
  assert.strictEqual(suggest[8].handle, 'iphone-14');
  const r = await client({ suggest }).searchProducts('iPhone 14');
  assert.strictEqual(r[0].handle, 'iphone-14');
  assert.strictEqual(r[0].available, true);
  assert.strictEqual(r.length, 9);
  assert.strictEqual(handles(r).filter((h) => h === 'iphone-14').length, 1);
});

test('detail fetch runs after re-rank, so a buried exact model gets colors', async () => {
  const suggest = [
    { handle: 'iphone-15-pro', title: 'iPhone 15 Pro Case', price: '69.99', available: true },
    { handle: 'iphone-13-pro', title: 'iPhone 13 Pro Case', price: '69.99', available: true },
    { handle: 'iphone-11-pro', title: 'iPhone 11 Pro Case', price: '69.99', available: true },
    BASE,
  ];
  const f = fetchMock({ suggest, js: { 'iphone-14': JS14 } });
  const r = await new ShopifyClient({ shop: 'quantacase.com', fetchImpl: f }).searchProducts('iPhone 14');
  assert.strictEqual(r[0].handle, 'iphone-14');
  assert.deepStrictEqual(r[0].options, [{ name: 'Color', values: ['Black'] }]);
  assert.strictEqual(r[3].options, undefined);
  assert.strictEqual(f.calls.filter((u) => u.endsWith('/products/iphone-14.js')).length, 1);
  assert.ok(!f.calls.some((u) => u.endsWith('/products/iphone-11-pro.js')));
});

test('iPhone 14 Pro keeps the Pro above the Pro Max', async () => {
  const r = await client({ suggest: [PRO_MAX, BASE, PRO] }).searchProducts('iPhone 14 Pro');
  assert.deepStrictEqual(handles(r).slice(0, 3), ['iphone-14-pro', 'iphone-14-pro-max', 'iphone-14']);
});

test('shortest model name ranks iphone-14 above a longer name and above iphone-14-plus', async () => {
  const r = await client({ suggest: [PLUS, LONG, BRANDED] }).searchProducts('iPhone 14');
  assert.deepStrictEqual(handles(r), ['iphone-14', 'iphone-14-special', 'iphone-14-plus']);
});

test('exact-model lookups that 404 still return suggest results', async () => {
  const suggest = [PRO, PRO_MAX];
  const f = fetchMock({ suggest });
  const r = await new ShopifyClient({ shop: 'quantacase.com', fetchImpl: f }).searchProducts('iPhone 14');
  assert.deepStrictEqual(handles(r).sort(), handles(suggest).sort());
  assert.ok(f.calls.some((u) => u.endsWith('/products/iphone-14.js')));
});

test('exact-model lookup timeout is skipped', async () => {
  const f = fetchMock({ suggest: [PRO], hang: ['iphone-14'] });
  const t0 = Date.now();
  const r = await new ShopifyClient({ shop: 'quantacase.com', fetchImpl: f }).searchProducts('iPhone 14');
  assert.deepStrictEqual(handles(r), ['iphone-14-pro']);
  assert.ok(Date.now() - t0 < 4000);
});

test('product_search says when the exact model is missing, and logs titles and handles only', async () => {
  const f = fetchMock({ suggest: [PRO, BASE], js: { 'iphone-14': JS14 } });
  const logs = [];
  const tools = new Tools({ id: 't', shopify: {}, link_allowlist: ['quantacase.com'] }, { shopifyFor: () => new ShopifyClient({ shop: 'quantacase.com', fetchImpl: f }), kbFor: () => ({}), log: (e, fields) => logs.push({ e, ...fields }) });
  const out = await tools.run('product_search', { query: 'iPhone 14' }, { channel: 'voice', caller: '+17275550199', callId: 'CA999' });
  assert.strictEqual(out.products[0].title, BASE.title);
  assert.ok(!('handle' in out.products[0]));
  const row = logs.find((l) => l.e === 'product.search');
  assert.ok(row.products.some((p) => p.handle === 'iphone-14' && p.title === BASE.title));
  const dumped = JSON.stringify(logs);
  assert.ok(!dumped.includes('+17275550199'));
  assert.ok(!dumped.includes('CA999'));
  const desc = tools.definitions().find((d) => d.name === 'product_search').description;
  assert.match(desc, /did not find it/);
  assert.match(desc, /close matches/);
  assert.match(desc, /out of stock only when that product is present with available false/);
});
