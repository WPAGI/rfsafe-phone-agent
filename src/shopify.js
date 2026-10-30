'use strict';
// READ-ONLY Shopify client. Two modes:
//  - "public": the storefront's public JSON (/products.json, /search/suggest.json). No token needed.
//  - "storefront": Storefront GraphQL API with a public-access token (unauthenticated_read_product_listings).
// Optional order-status lookup (Admin API read_orders) is OFF by default and returns status only.
// There is no code path that issues a mutation, a POST other than a GraphQL *query*, or a checkout.
const API_VERSION = '2025-07';

function assertReadOnlyQuery(q) {
  const s = String(q).replace(/#[^\n]*/g, '').trim();
  if (!/^(query\b|\{)/.test(s) || /\bmutation\b|\bsubscription\b/i.test(s)) throw new Error('shopify client is read-only: only GraphQL queries allowed');
}

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$|^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

class ShopifyClient {
  constructor({ shop, mode = 'public', storefrontToken = null, adminToken = null, fetchImpl = globalThis.fetch, publicDomain = null }) {
    if (!SHOP_RE.test(shop || '')) throw new Error('bad shop domain');
    this.shop = shop; this.mode = mode; this.sfToken = storefrontToken; this.adminToken = adminToken; this.fetch = fetchImpl; this.publicDomain = publicDomain || shop;
  }
  async _get(url, headers = {}) {
    const r = await this.fetch(url, { method: 'GET', headers: { accept: 'application/json', ...headers } });
    if (!r.ok) throw new Error('shopify http ' + r.status);
    return r.json();
  }
  async _gql(query, variables) {
    assertReadOnlyQuery(query);
    const r = await this.fetch(`https://${this.shop}/api/${API_VERSION}/graphql.json`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Shopify-Storefront-Access-Token': this.sfToken }, body: JSON.stringify({ query, variables }) });
    if (!r.ok) throw new Error('shopify http ' + r.status);
    return r.json();
  }
  productUrl(handle) { return `https://${this.publicDomain}/products/${encodeURIComponent(handle)}`; }
  async searchProducts(query, limit = 5) {
    query = String(query || '').slice(0, 100);
    if (this.mode === 'storefront') {
      const j = await this._gql('query($q:String!,$n:Int!){ products(first:$n, query:$q){ edges{ node{ title handle availableForSale priceRange{ minVariantPrice{ amount currencyCode } } } } } }', { q: query, n: limit });
      return (j.data?.products?.edges || []).map(({ node: n }) => ({ title: n.title, price: n.priceRange.minVariantPrice.amount, currency: n.priceRange.minVariantPrice.currencyCode, available: n.availableForSale, url: this.productUrl(n.handle) }));
    }
    const j = await this._get(`https://${this.shop}/search/suggest.json?q=${encodeURIComponent(query)}&resources[type]=product&resources[limit]=${limit}`);
    return (j.resources?.results?.products || []).slice(0, limit).map((p) => ({ title: p.title, price: p.price, currency: 'USD', available: p.available, url: this.productUrl(p.handle) }));
  }
  // Order status: requires the order number AND the caller's phone/email to match the order. Returns
  // only status fields: no address, no items' payment info, no customer name.
  async orderStatus({ orderName, callerPhone }) {
    if (!this.adminToken) return { ok: false, reason: 'order_lookup_not_connected' };
    if (!/^#?\d{3,10}$/.test(String(orderName))) return { ok: false, reason: 'bad_order_number' };
    const name = '#' + String(orderName).replace('#', '');
    const j = await this._get(`https://${this.shop}/admin/api/${API_VERSION}/orders.json?status=any&name=${encodeURIComponent(name)}&fields=name,phone,financial_status,fulfillment_status,cancelled_at,fulfillments`, { 'X-Shopify-Access-Token': this.adminToken });
    const o = (j.orders || [])[0];
    const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
    if (!o || !callerPhone || digits(o.phone) !== digits(callerPhone)) return { ok: false, reason: 'not_found_or_not_verified' };
    const f = (o.fulfillments || [])[0] || {};
    return { ok: true, order: o.name, fulfillment_status: o.fulfillment_status || 'unfulfilled', cancelled: !!o.cancelled_at, tracking_company: f.tracking_company || null };
  }
}

module.exports = { ShopifyClient, assertReadOnlyQuery };
