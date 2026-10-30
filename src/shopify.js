'use strict';
// READ-ONLY Shopify client. Two modes:
//  - "public": the storefront's public JSON (/products.json, /search/suggest.json). No token needed.
//  - "storefront": Storefront GraphQL API with a public-access token (unauthenticated_read_product_listings).
// Optional order-status lookup (Admin GraphQL, read_orders) is OFF by default, needs the caller verified, and returns status only.
// There is no code path that issues a mutation, a POST other than a GraphQL *query*, or a checkout.
const API_VERSION = '2025-07'; // Storefront API
const ADMIN_API_VERSION = '2026-10'; // Admin GraphQL (order lookup)

function assertReadOnlyQuery(q) {
  const s = String(q).replace(/#[^\n]*/g, '').trim();
  if (!/^(query\b|\{)/.test(s) || /\bmutation\b|\bsubscription\b/i.test(s)) throw new Error('shopify client is read-only: only GraphQL queries allowed');
}

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$|^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

class ShopifyClient {
  constructor({ shop, mode = 'public', storefrontToken = null, admin = null, fetchImpl = globalThis.fetch, publicDomain = null }) {
    if (!SHOP_RE.test(shop || '')) throw new Error('bad shop domain');
    this.shop = shop; this.mode = mode; this.sfToken = storefrontToken; this.admin = admin; this.fetch = fetchImpl; this.publicDomain = publicDomain || shop;
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
  // Order status (Admin GraphQL, read_orders). The caller must give the order number AND an email or phone
  // that is on the order (caller ID counts as a phone). Only status fields come back: no street address,
  // no payment info, no prices, no customer name. A miss and a failed check return the same answer.
  async orderStatus({ orderName, email, phone, callerPhone }) {
    if (!this.admin) return { ok: false, reason: 'order_lookup_not_connected' };
    const num = String(orderName || '').trim().replace(/^#/, '').replace(/^order\s*/i, '');
    if (!/^\d{3,10}$/.test(num)) return { ok: false, reason: 'bad_order_number' };
    const em = normEmail(email); const phones = [phone, callerPhone].map(digits10).filter(Boolean);
    if (!em && !phones.length) return { ok: false, reason: 'need_email_or_phone' };
    const j = await this.admin.query(ORDER_QUERY, { q: 'name:' + num });
    const o = (j.data?.orders?.nodes || []).find((x) => String(x.name).replace(/^#/, '') === num);
    if (!o || !verifyOrderContact(o, { email: em, phones })) return { ok: false, reason: 'not_found_or_not_verified' };
    return { ok: true, ...safeOrderView(o) };
  }
}

const ORDER_QUERY = `query($q:String!){ orders(first:5, query:$q){ nodes{ name createdAt cancelledAt displayFulfillmentStatus email phone
  customer{ defaultEmailAddress{ emailAddress } defaultPhoneNumber{ phoneNumber } }
  shippingAddress{ city provinceCode countryCodeV2 phone }
  lineItems(first:10){ nodes{ title quantity } }
  fulfillments(first:5){ displayStatus estimatedDeliveryAt deliveredAt trackingInfo(first:3){ company number } } } } }`;

function digits10(s) { const d = String(s || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; }
function normEmail(s) { const e = String(s || '').trim().toLowerCase().replace(/\s+at\s+/g, '@').replace(/\s+dot\s+/g, '.').replace(/\s+/g, ''); return /^[^@]+@[^@]+\.[a-z]{2,}$/.test(e) ? e : ''; }
function verifyOrderContact(o, { email, phones }) {
  const emails = [o.email, o.customer?.defaultEmailAddress?.emailAddress].map(normEmail).filter(Boolean);
  const ph = [o.phone, o.shippingAddress?.phone, o.customer?.defaultPhoneNumber?.phoneNumber].map(digits10).filter(Boolean);
  return (!!email && emails.includes(email)) || phones.some((p) => ph.includes(p));
}
function safeOrderView(o) {
  const shipments = (o.fulfillments || []).map((f) => ({ status: f.displayStatus || null, estimated_delivery: f.estimatedDeliveryAt || null, delivered_at: f.deliveredAt || null,
    tracking: (f.trackingInfo || []).map((t) => ({ carrier: t.company || null, number_last4: t.number ? String(t.number).slice(-4) : null })) }));
  const a = o.shippingAddress || {};
  return { order: o.name, placed: String(o.createdAt || '').slice(0, 10), cancelled: !!o.cancelledAt, fulfillment_status: String(o.displayFulfillmentStatus || 'UNFULFILLED').toLowerCase(),
    items: (o.lineItems?.nodes || []).map((li) => ({ title: li.title, quantity: li.quantity })),
    ships_to: [a.city, a.provinceCode].filter(Boolean).join(', ') || null, shipments };
}

// Admin API access via the client-credentials grant (Dev Dashboard app installed on the merchant's own store).
// Tokens last ~24h; cached and refreshed 10 minutes early, single-flight, and dropped on a 401.
// The token and client secret are never logged or returned.
class ShopifyAdmin {
  constructor({ shop, clientId, clientSecret, fetchImpl = globalThis.fetch, now = () => Date.now(), apiVersion = ADMIN_API_VERSION }) {
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop || '')) throw new Error('bad admin shop domain');
    if (!clientId || !clientSecret) throw new Error('shopify admin credentials missing');
    this.shop = shop; this.fetch = fetchImpl; this.now = now; this.apiVersion = apiVersion;
    Object.defineProperty(this, '_cred', { value: { clientId, clientSecret }, enumerable: false });
    this._tok = null; this._exp = 0; this._pending = null;
  }
  async token() {
    if (this._tok && this.now() < this._exp) return this._tok;
    if (!this._pending) this._pending = this._mint().finally(() => { this._pending = null; });
    return this._pending;
  }
  async _mint() {
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this._cred.clientId, client_secret: this._cred.clientSecret }).toString();
    const r = await this.fetch(`https://${this.shop}/admin/oauth/access_token`, { method: 'POST', idempotent: true, headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
    if (!r.ok) throw new Error('shopify token http ' + r.status);
    const j = await r.json();
    if (!j.access_token) throw new Error('shopify token missing');
    const life = Math.max(60, Number(j.expires_in) || 86399);
    this._tok = j.access_token; this._exp = this.now() + Math.max(30, life - 600) * 1000; this.scope = j.scope || null;
    return this._tok;
  }
  invalidate() { this._tok = null; this._exp = 0; }
  async query(query, variables, _retried = false) {
    assertReadOnlyQuery(query);
    const tok = await this.token();
    const r = await this.fetch(`https://${this.shop}/admin/api/${this.apiVersion}/graphql.json`, { method: 'POST', idempotent: true, headers: { 'content-type': 'application/json', accept: 'application/json', 'X-Shopify-Access-Token': tok }, body: JSON.stringify({ query, variables }) });
    if (r.status === 401 && !_retried) { this.invalidate(); return this.query(query, variables, true); }
    if (!r.ok) throw new Error('shopify admin http ' + r.status);
    const j = await r.json();
    if (j.errors && !j.data) throw new Error('shopify admin graphql error');
    return j;
  }
  toJSON() { return { shop: this.shop, apiVersion: this.apiVersion }; }
}

module.exports = { ShopifyClient, ShopifyAdmin, assertReadOnlyQuery, verifyOrderContact, safeOrderView, normEmail, ADMIN_API_VERSION };
