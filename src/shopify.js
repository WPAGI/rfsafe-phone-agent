'use strict';
// READ-ONLY Shopify client. Two modes:
//  - "public": the storefront's public JSON (/products.json, /search/suggest.json). No token needed.
//  - "storefront": Storefront GraphQL API with a public-access token (unauthenticated_read_product_listings).
// Optional order-status lookup (Admin GraphQL, read_orders) is OFF by default, needs the caller verified, and returns status only.
// There is no code path that issues a mutation, a POST other than a GraphQL *query*, or a checkout.
const API_VERSION = '2025-07'; // Storefront API
const ADMIN_API_VERSION = '2026-10'; // Admin GraphQL (order lookup)
const DETAIL_COUNT = 3; const DETAIL_TIMEOUT_MS = 2500;
const SUGGEST_LIMIT = 10; // Shopify /search/suggest.json maximum

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
  async searchProducts(query, limit = SUGGEST_LIMIT) {
    query = String(query || '').slice(0, 100);
    const cap = Math.min(SUGGEST_LIMIT, Math.max(1, Number(limit) || SUGGEST_LIMIT));
    if (this.mode === 'storefront') {
      const j = await this._gql('query($q:String!,$n:Int!){ products(first:$n, query:$q){ edges{ node{ title handle availableForSale priceRange{ minVariantPrice{ amount currencyCode } } options{ name values } variants(first:20){ nodes{ id title availableForSale price{ amount } } } } } } }', { q: query, n: cap });
      const items = (j.data?.products?.edges || []).map(({ node: n }) => ({ title: n.title, price: n.priceRange.minVariantPrice.amount, currency: n.priceRange.minVariantPrice.currencyCode, available: n.availableForSale, url: this.productUrl(n.handle), handle: n.handle,
        options: (n.options || []).map((o) => ({ name: o.name, values: o.values || [] })),
        variants: (n.variants?.nodes || []).map((v) => ({ id: variantId(v.id), title: v.title, available: !!v.availableForSale, price: Number(v.price?.amount) })) }));
      return rankProducts(items, query).slice(0, cap);
    }
    // Always ask for Shopify's maximum. The old top-5 cut hid exact models that suggest ranks later (iPhone 14 is 9th).
    const j = await this._get(`https://${this.shop}/search/suggest.json?q=${encodeURIComponent(query)}&resources[type]=product&resources[limit]=${SUGGEST_LIMIT}`);
    const items = (j.resources?.results?.products || []).slice(0, SUGGEST_LIMIT).map((p) => ({ title: p.title, price: p.price, currency: 'USD', available: p.available, url: this.productUrl(p.handle), handle: p.handle }));
    await this._mergeExactProducts(query, items);
    const ranked = rankProducts(items, query);
    // Colors/options after re-rank, so the exact model is one of the top 3 that get a detail fetch.
    await Promise.all(ranked.slice(0, DETAIL_COUNT).map(async (it) => {
      try { fillFromProductJs(it, await this._getTimeout(`https://${this.publicDomain}/products/${encodeURIComponent(it.handle)}.js`, DETAIL_TIMEOUT_MS)); }
      catch { /* skip quietly */ }
    }));
    return ranked.slice(0, cap);
  }
  // Fallback when suggest omitted the model: GET /products/{handle}.js. A 404 or timeout is skipped.
  async _mergeExactProducts(query, items) {
    const have = new Set(items.map((p) => String(p.handle || '').toLowerCase()));
    const handles = candidateHandles(query).filter((h) => !have.has(h));
    if (!handles.length) return;
    const found = await Promise.all(handles.map(async (h) => {
      try { return itemFromProductJs(await this._getTimeout(`https://${this.publicDomain}/products/${encodeURIComponent(h)}.js`, DETAIL_TIMEOUT_MS), (handle) => this.productUrl(handle)); }
      catch { return null; }
    }));
    for (const hit of found) {
      if (!hit) continue;
      const key = String(hit.handle).toLowerCase();
      if (have.has(key)) continue;
      have.add(key); items.push(hit);
    }
  }
  async _getTimeout(url, ms) {
    const ac = typeof AbortController === 'function' ? new AbortController() : null; let timer;
    const t = new Promise((_, rej) => { timer = setTimeout(() => { ac?.abort(); rej(new Error('timeout')); }, ms); });
    try {
      return await Promise.race([(async () => { const r = await this.fetch(url, { method: 'GET', headers: { accept: 'application/json' }, ...(ac ? { signal: ac.signal } : {}) }); if (!r.ok) throw new Error('shopify http ' + r.status); return r.json(); })(), t]);
    } finally { clearTimeout(timer); }
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

// Variant words. A query that does not include one ranks products that carry it lower.
const MODEL_WORDS = ['pro', 'max', 'plus', 'air', 'mini', 'ultra'];
const MODEL_PREFIXES = ['rf safe', 'apple', 'quantacase', 'quanta case', 'quanta', 'samsung', 'google'];
const MODEL_SUFFIXES = ['anti radiation phone case', 'anti radiation case', 'phone case rfid blocking', 'phone radiation shield', 'phone case', 'anti radiation', 'rfid blocking', 'model rfs1', 'quantacase', 'quanta case', 'rf safe', 'rfs1', 'cases', 'case', 'black'];
const HANDLE_NOISE = new Set(['a', 'an', 'the', 'for', 'with', 'and', 'case', 'cases', 'rfs1', 'anti', 'radiation', 'antiradiation', 'phone', 'model', 'rf', 'safe', 'apple', 'quantacase', 'quanta']);

function wordsOf(text) {
  return String(text || '').toLowerCase().replace(/®|™/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

// "iPhone 14 case" and "iPhone 14 RFS1 anti-radiation case" both become iphone-14.
// A bare word ("iphone") is not a product handle; probing it would add a timeout before the detail fetch.
function candidateHandles(query) {
  const words = wordsOf(query);
  const kept = words.filter((w) => !HANDLE_NOISE.has(w));
  const slugs = [];
  const add = (parts) => {
    const slug = parts.join('-');
    if (!slug || slug.length > 80 || slugs.includes(slug)) return;
    if (!slug.includes('-') && !/\d/.test(slug)) return;
    slugs.push(slug);
  };
  add(kept);
  if (kept.length !== words.length) add(words);
  return slugs.slice(0, 4);
}

function containsEveryWord(text, words) {
  if (!words.length) return true;
  const set = new Set(wordsOf(text));
  return words.every((w) => set.has(w));
}

function extraModelWords(item, words) {
  const q = new Set(words);
  const hay = new Set([...wordsOf(item.title), ...wordsOf(item.handle)]);
  let n = 0;
  for (const w of MODEL_WORDS) if (hay.has(w) && !q.has(w)) n += 1;
  return n;
}

function stripAffix(s, list, fromStart) {
  for (const affix of list) {
    if (s === affix) return '';
    if (fromStart && s.startsWith(affix + ' ')) return s.slice(affix.length + 1).trim();
    if (!fromStart && s.endsWith(' ' + affix)) return s.slice(0, -(affix.length + 1)).trim();
  }
  return s;
}

// Brand prefixes ("RF Safe® Apple") and catalog suffixes ("Anti-Radiation Case") are not the model name.
function modelName(item) {
  let s = wordsOf(item.title || item.handle).join(' ');
  const raw = s;
  for (let i = 0; i < 6; i++) {
    const next = stripAffix(s, MODEL_PREFIXES, true).replace(/^(for|rfs1|model)\s+/, '');
    if (next === s) break;
    s = next.trim();
  }
  for (let i = 0; i < 8; i++) {
    const next = stripAffix(s, MODEL_SUFFIXES, false);
    if (next === s) break;
    s = next.trim();
  }
  return s || raw;
}

// (1) every query word in the title or the handle, (2) fewer extra model words, (3) shortest model name.
function rankProducts(items, query) {
  const words = wordsOf(query);
  return items.map((item, i) => ({ item, i })).sort((a, b) => {
    const am = containsEveryWord(a.item.title, words) || containsEveryWord(a.item.handle, words) ? 0 : 1;
    const bm = containsEveryWord(b.item.title, words) || containsEveryWord(b.item.handle, words) ? 0 : 1;
    if (am !== bm) return am - bm;
    const ax = extraModelWords(a.item, words); const bx = extraModelWords(b.item, words);
    if (ax !== bx) return ax - bx;
    const al = modelName(a.item).length; const bl = modelName(b.item).length;
    if (al !== bl) return al - bl;
    return a.i - b.i;
  }).map((x) => x.item);
}

function fillFromProductJs(it, d) {
  if (!d || typeof d !== 'object') return;
  if (Array.isArray(d.options)) it.options = d.options.map((o) => (typeof o === 'string' ? { name: o, values: [] } : { name: o.name, values: o.values || [] }));
  if (Array.isArray(d.variants)) it.variants = d.variants.slice(0, 50).map((v) => ({ id: variantId(v.id), title: v.title, available: !!v.available, price: Number(v.price) / 100 }));
}

function itemFromProductJs(d, urlFor) {
  if (!d || typeof d.handle !== 'string' || !d.handle || typeof d.title !== 'string' || !d.title) return null;
  const it = { title: d.title, price: typeof d.price === 'number' ? (d.price / 100).toFixed(2) : (d.price == null ? undefined : String(d.price)), currency: 'USD', available: d.available, url: urlFor(d.handle), handle: d.handle };
  fillFromProductJs(it, d);
  return it;
}

// Shopify variant id: number from the .js, or a Storefront gid like gid://shopify/ProductVariant/123 -> 123.
function variantId(id) {
  if (id == null) return undefined;
  const m = String(id).match(/(\d+)\s*$/); if (!m) return undefined;
  const n = Number(m[1]); return Number.isSafeInteger(n) ? n : m[1];
}

// Compact per-option stock for voice/SMS: [{name, available:[...], unavailable:[...], values:[{value, available, variant_id, url}]}].
// A value is available if any variant with it is. Each value links to its own variant (?variant=<id>) so a named color opens on that color.
// p.url is the base product URL; the variant URL is built from it.
function summarizeOptions(p) {
  const opts = (p.options || []).filter((o) => o.name && !(o.name === 'Title' && o.values.length <= 1 && o.values[0] === 'Default Title'));
  if (!opts.length || !(p.variants || []).length) return undefined;
  const base = p.url ? String(p.url).split('?')[0] : '';
  return opts.map((o, i) => {
    const part = (v) => (opts.length === 1 ? String(v.title) : String(v.title).split(' / ')[i]);
    const vals = o.values.length ? o.values : [...new Set(p.variants.map(part).filter(Boolean))];
    const avail = []; const unavail = []; const values = [];
    for (const val of vals) {
      const has = p.variants.filter((v) => part(v) === val);
      const pick = has.find((v) => v.available) || has[0];
      (pick && pick.available ? avail : unavail).push(val);
      const e = { value: val, available: !!(pick && pick.available) };
      if (pick && pick.id != null) { e.variant_id = pick.id; if (base) e.url = `${base}?variant=${pick.id}`; }
      values.push(e);
    }
    return { name: o.name, available: avail, unavailable: unavail, values };
  });
}

// When a text names an option value (e.g. "brown"), the link for it: {value, available, url, alt?} where alt is an available value's link if it is sold out.
function linkForNamed(p, text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
  for (const o of p.options || []) {
    for (const e of o.values || []) {
      const w = String(e.value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (w && e.url && t.includes(' ' + w + ' ')) {
        const alt = e.available ? undefined : (o.values || []).find((x) => x.available && x.url);
        return { value: e.value, available: e.available, url: e.url, ...(alt ? { alt: { value: alt.value, url: alt.url } } : {}) };
      }
    }
  }
  return null;
}
// One product line for a text reply, preferring the named color's variant URL.
function productLine(p, text) {
  const n = linkForNamed(p, text);
  if (n) return `${p.title} in ${n.value}: $${p.price}${n.available ? '' : ` (${n.value} is sold out${n.alt ? `; ${n.alt.value} is available: ${n.alt.url}` : ''})`}. Order on our site: ${n.url}`;
  return `${p.title}: $${p.price}${p.available ? '' : ' (currently unavailable)'}. Order on our site: ${p.url}`;
}

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

module.exports = { ShopifyClient, summarizeOptions, variantId, linkForNamed, productLine, ShopifyAdmin, assertReadOnlyQuery, verifyOrderContact, safeOrderView, normEmail, ADMIN_API_VERSION };
