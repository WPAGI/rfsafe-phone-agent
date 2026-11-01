'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { ShopifyClient, summarizeOptions, variantId, linkForNamed, productLine } = require('../src/shopify');
const { Tools } = require('../src/tools');

// Real product .js shape (iPhone 17 RFS1: Black, Brown, Turquoise), trimmed to what the client reads.
const H = 'rf-safe-iphone-17-quantacase-model-rfs1-black';
const RFS1 = { handle: H, options: [{ name: 'Color', position: 1, values: ['Black', 'Brown', 'Turquoise'] }],
  variants: [{ id: 52347073397015, title: 'Black', available: true, price: 6900 }, { id: 55171864592663, title: 'Brown', available: true, price: 6900 }, { id: 55171864625431, title: 'Turquoise', available: false, price: 6900 }] };
const SUG = { handle: H, title: 'RF Safe iPhone 17 QuantaCase Model RFS1', price: '69.00', available: true };
const fetchMock = async (url) => {
  if (url.includes('/search/suggest.json')) return { ok: true, status: 200, json: async () => ({ resources: { results: { products: [SUG] } } }) };
  if (url.endsWith(`/products/${H}.js`)) return { ok: true, status: 200, json: async () => RFS1 };
  return { ok: false, status: 404, json: async () => ({}) };
};
const client = () => new ShopifyClient({ shop: 'quantacase.myshopify.com', publicDomain: 'quantacase.com', fetchImpl: fetchMock });

test('sample .js in color-diagnosis matches the RFS1 ids used here (if present)', () => {
  const f = '/workspace/code/color-diagnosis/rf-safe®-iphone-17-quantacase®-model-rfs1-black.js.json';
  if (!fs.existsSync(f)) return;
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(d.variants.find((v) => v.title === 'Brown').id, 55171864592663);
});

test('iPhone 17 RFS1 Brown returns its ?variant= URL on the configured domain', async () => {
  const tools = new Tools({ id: 't', shopify: {}, link_allowlist: ['quantacase.com'] }, { shopifyFor: () => client(), kbFor: () => ({}) });
  const out = await tools.run('product_search', { query: 'iphone 17 rfs1' }, { channel: 'sms', caller: '+17275550142' });
  const brown = out.products[0].options[0].values.find((v) => v.value === 'Brown');
  assert.deepStrictEqual(brown, { value: 'Brown', available: true, variant_id: 55171864592663, url: `https://quantacase.com/products/${H}?variant=55171864592663` });
  assert.strictEqual(out.products[0].url, `https://quantacase.com/products/${H}`);
  const n = linkForNamed(out.products[0], 'Can you text me the link for the brown one?');
  assert.strictEqual(n.url, brown.url);
  assert.match(productLine(out.products[0], 'brown iphone 17 case'), /\?variant=55171864592663$/);
  assert.match(productLine(out.products[0], 'iphone 17 case'), new RegExp(`/products/${H}$`));
});

test('sold-out color is available:false, still has a URL, and the reply offers an available color', async () => {
  const [p] = await client().searchProducts('iphone 17');
  const [o] = summarizeOptions(p);
  const tq = o.values.find((v) => v.value === 'Turquoise');
  assert.strictEqual(tq.available, false); assert.strictEqual(tq.url, `https://quantacase.com/products/${H}?variant=55171864625431`);
  assert.deepStrictEqual(o.unavailable, ['Turquoise']);
  const line = productLine({ ...p, options: [o] }, 'turquoise please');
  assert.match(line, /Turquoise is sold out; Black is available: https:\/\/quantacase\.com\/products\/.+\?variant=52347073397015/);
});

test('multi-option: first available variant containing the value, else the first one', () => {
  const p = { url: 'https://quantacase.com/products/x', options: [{ name: 'Color', values: ['Black', 'Brown'] }, { name: 'Size', values: ['S', 'L'] }],
    variants: [{ id: 1, title: 'Black / S', available: false }, { id: 2, title: 'Black / L', available: true }, { id: 3, title: 'Brown / S', available: false }, { id: 4, title: 'Brown / L', available: false }] };
  const [c, s] = summarizeOptions(p);
  assert.deepStrictEqual(c.values.map((v) => [v.value, v.variant_id, v.available]), [['Black', 2, true], ['Brown', 3, false]]);
  assert.deepStrictEqual(s.values.map((v) => [v.value, v.variant_id]), [['S', 1], ['L', 2]]);
  assert.strictEqual(c.values[0].url, 'https://quantacase.com/products/x?variant=2');
});

test('storefront: variant gid parsed to a number and used in the URL', async () => {
  let body;
  const f = async (url, opts) => { body = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ data: { products: { edges: [{ node: { title: 'RFS1', handle: H, availableForSale: true, priceRange: { minVariantPrice: { amount: '69.00', currencyCode: 'USD' } },
    options: [{ name: 'Color', values: ['Black', 'Brown'] }], variants: { nodes: [{ id: 'gid://shopify/ProductVariant/52347073397015', title: 'Black', availableForSale: true, price: { amount: '69.00' } }, { id: 'gid://shopify/ProductVariant/55171864592663', title: 'Brown', availableForSale: false, price: { amount: '69.00' } }] } } }] } } }) }; };
  const c = new ShopifyClient({ shop: 'quantacase.myshopify.com', mode: 'storefront', storefrontToken: 'x', publicDomain: 'quantacase.com', fetchImpl: f });
  const [p] = await c.searchProducts('rfs1');
  assert.match(body.query, /nodes\{ id title/);
  assert.deepStrictEqual(p.variants.map((v) => v.id), [52347073397015, 55171864592663]);
  const [o] = summarizeOptions(p);
  assert.strictEqual(o.values[1].url, `https://quantacase.com/products/${H}?variant=55171864592663`); assert.strictEqual(o.values[1].available, false);
  assert.strictEqual(variantId('gid://shopify/ProductVariant/123'), 123); assert.strictEqual(variantId(null), undefined); assert.strictEqual(variantId('junk'), undefined);
});

test('tool descriptions steer named colors to the variant url', () => {
  const tools = new Tools({ id: 't', shopify: {}, sms_enabled: true, email_enabled: true, link_allowlist: ['quantacase.com'] }, { shopifyFor: () => client(), kbFor: () => ({}), emailFor: () => ({}) });
  const d = Object.fromEntries(tools.definitions().map((x) => [x.name, x.description]));
  for (const n of ['product_search', 'send_link_sms', 'send_email']) if (d[n]) assert.match(d[n], /variant url|\?variant=/, n);
  assert.match(d.product_search, /sold out/);
});
