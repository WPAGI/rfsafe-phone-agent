'use strict';
const P = require('./policy');
const crypto = require('crypto');
const { Sealer } = require('./crypto');
const { ShopifyAdmin, assertReadOnlyQuery, verifyOrderContact, safeOrderView, normEmail, ADMIN_API_VERSION } = require('../shopify');
const SHOP = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const SCOPES = ['read_products', 'read_inventory', 'read_orders', 'read_fulfillments', 'read_shipping'];
// Per-site (brand.json site; portable package: port/site.config.js). rfsafe.app -> https://rfsafe.app/mail/tools/shopify/callback.
const B = require('../brand');
const CALLBACK = 'https://' + (B.site || 'rfsafe.app') + '/mail/tools/shopify/callback';
const INVENTORY = 'query Inventory($q:String!){ productVariants(first:10, query:$q){ nodes{ sku title displayName inventoryQuantity product{ title handle status onlineStoreUrl } } } }';
const ORDER = 'query OrderStatus($q:String!){ orders(first:5, query:$q){ nodes{ name createdAt cancelledAt displayFulfillmentStatus email phone shippingAddress{ city provinceCode countryCodeV2 phone } lineItems(first:10){ nodes{ title quantity } } fulfillments(first:5){ displayStatus estimatedDeliveryAt deliveredAt trackingInfo(first:3){ company number url } } } } }';
const ORDER_LOOKUP = 'query OrderLookup($q:String!){ orders(first:5, query:$q, sortKey:CREATED_AT, reverse:true){ nodes{ name createdAt cancelledAt displayFulfillmentStatus email customer{ defaultEmailAddress{ emailAddress } } fulfillments(first:5){ displayStatus estimatedDeliveryAt deliveredAt trackingInfo(first:3){ company number url } } } } }';
const PRODUCT = 'query ProductLink($q:String!){ products(first:5, query:$q){ nodes{ title handle status onlineStoreUrl priceRangeV2{ minVariantPrice{ amount currencyCode } } options{ name values } variants(first:20){ nodes{ id title price inventoryQuantity availableForSale } } } } }';
const fail = (m, status = 400) => Object.assign(new Error(m), { status });
const eq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
// Registry: each connector keeps credentials private and exposes only explicitly named read actions.
class MailTools {
  #env; #seal; #admin; #nonce = new Map(); #hits = new Map();
  constructor({ store, env, fetchImpl, kb, now = () => Date.now(), shopifyOAuth = true, callbackUrl = CALLBACK }) {
    this.callbackUrl = callbackUrl; this.store = store; this.#env = env; this.fetch = fetchImpl; this.kb = kb; this.now = now;
    // Derive a connector-only encryption key: a Shopify blob cannot be opened as a mail copy.
    const root = store.sealer.key; this.#seal = new Sealer(crypto.createHmac('sha256', root).update('mailbox:connector:shopify:v1').digest('base64'));
    store.db.tools ||= { kb: true, shopify: { connected: false }, log: [] };
    const sh = store.db.tools.shopify; if (!sh || 'mode' in sh) { store.db.tools.shopify = { connected: false }; store.save(); }
    this.oauthEnabled = shopifyOAuth !== false;
  }
  state() { return this.store.db.tools; }
  log(actor, connector, action, status) { const s = this.state(); s.log.push({ at: this.store.iso(), actor, connector, action, status }); s.log = s.log.slice(-5000); this.store.save(); }
  allow(actor) { const t = this.now(), a = (this.#hits.get(actor) || []).filter(x => t - x < 86400000); if (a.length >= 2000 || a.filter(x => t - x < 60000).length >= 30) return false; a.push(t); this.#hits.set(actor, a); return true; }
  // Presence checks only (names, never values). 'existing' = the site's SHOPIFY_ADMIN_* store connection (option A);
  // 'oauth' = the standard approval-screen install with SHOPIFY_APP_CLIENT_ID / SHOPIFY_APP_SECRET.
  ready(via) { const e = this.#env; return via === 'existing' ? !!(SHOP.test(e.SHOPIFY_ADMIN_SHOP || '') && e.SHOPIFY_ADMIN_CLIENT_ID && e.SHOPIFY_ADMIN_CLIENT_SECRET) : via === 'oauth' ? !!(this.oauthEnabled && e.SHOPIFY_APP_CLIENT_ID && e.SHOPIFY_APP_SECRET) : false; }
  shopifyCard() {
    const s = this.state().shopify; const base = { id: 'shopify', name: 'Shopify', group: 'Connect a store', actions: ['inventory', 'order_status', 'product_link'] };
    if (s.connected) return { ...base, state: 'connected', status: 'Connected', connected: true, shop: s.shop, via: s.via, via_label: s.via === 'existing' ? 'Existing ' + (B.site || 'rfsafe.app') + ' store connection' : 'Shopify approval screen (OAuth)', connected_at: s.connected_at, can_disconnect: true, confirm_word: 'DISCONNECT',
      detail: s.via === 'existing' ? 'Disconnect only stops the Mailbox using it. The store site’s own Shopify connection is not changed.' : 'Disconnect deletes the stored access token.' };
    // Initial state: the existing store connection is offered first. The approval-screen path appears once it has been disconnected, or when no existing connection exists.
    if (!s.disconnected_once && this.ready('existing')) return { ...base, state: 'existing_found', status: 'Existing store connection found', connected: false, primary: { method: 'existing', label: 'Connect', enabled: true }, detail: 'Uses the store connection rfsafe.app already has. Off until you click Connect. Bots get read-only lookups; the store login never leaves the server.' };
    const oauth = this.ready('oauth');
    return { ...base, state: 'oauth', status: oauth ? 'Not connected' : 'Shopify app not set up', connected: false, primary: { method: 'oauth', label: 'Connect Shopify', enabled: oauth, needs_shop: true },
      secondary: this.ready('existing') ? { method: 'existing', label: 'Use the existing store connection instead' } : null, scopes: SCOPES, callback: this.callbackUrl,
      detail: (oauth ? 'Opens Shopify’s approval screen. Read-only scopes: ' + SCOPES.join(', ') + '.' : 'The Shopify app client ID and secret are not set up on this site.') + ' The app’s allowed redirect URLs must include ' + this.callbackUrl + '.' };
  }
  cards() { return [{ id: 'kb', name: 'Knowledge base', group: 'Knowledge', status: this.state().kb && this.kb ? 'Connected' : 'Disconnected', connected: !!(this.state().kb && this.kb), can_disconnect: true, primary: { method: 'kb', label: 'Connect', enabled: !!this.kb }, actions: ['search'] }, this.shopifyCard()]; }
  disconnect(id, b = {}) {
    if (id === 'kb') { this.state().kb = false; this.log('owner', id, 'disconnect', 200); return { ok: true }; }
    if (id !== 'shopify') throw fail('unknown_tool', 404);
    if (b.confirm !== 'DISCONNECT') throw fail('typed_confirmation_required', 428);
    const s = this.state().shopify; if (!s.connected) throw fail('not_connected', 409);
    // Existing connection: only the Mailbox's use ends; env and the store integration are untouched. OAuth: the sealed token is deleted.
    this.state().shopify = { connected: false, disconnected_once: true, last: { via: s.via, shop: s.shop, at: this.store.iso() } };
    this.#admin?.invalidate(); this.#admin = null; this.#nonce.clear(); this.log('owner', id, 'disconnect:' + s.via, 200); return { ok: true };
  }
  connect(id, b = {}) {
    if (id === 'kb') { if (!this.kb) throw fail('kb_unavailable', 409); this.state().kb = true; this.log('owner', id, 'connect', 200); return { ok: true }; }
    if (id !== 'shopify') throw fail('unknown_tool', 404);
    const s = this.state().shopify; if (s.connected) throw fail('already_connected', 409); if (b.confirm !== 'CONNECT') throw fail('confirm_required', 428);
    if (b.method === 'existing') { if (!this.ready('existing')) throw fail('Shopify app not set up', 409); this.state().shopify = { connected: true, via: 'existing', shop: this.#env.SHOPIFY_ADMIN_SHOP, connected_at: this.store.iso(), disconnected_once: !!s.disconnected_once }; this.log('owner', id, 'connect:existing', 200); return { ok: true }; }
    if (b.method !== 'oauth') throw fail('bad_method'); if (!this.ready('oauth')) throw fail('Shopify app not set up', 409);
    const shop = String(b.shop || '').toLowerCase().trim(); if (!SHOP.test(shop)) throw fail('shop must be <name>.myshopify.com');
    const nonce = crypto.randomBytes(32).toString('base64url'); this.#nonce.set(nonce, { shop, at: this.now() });
    for (const [k, v] of this.#nonce) if (this.now() - v.at > 600000) this.#nonce.delete(k);
    this.log('owner', id, 'oauth_start', 200);
    return { ok: true, authorize_url: `https://${shop}/admin/oauth/authorize?` + new URLSearchParams({ client_id: this.#env.SHOPIFY_APP_CLIENT_ID, scope: SCOPES.join(','), redirect_uri: this.callbackUrl, state: nonce }) };
  }
  async callback(params) {
    const s = this.state().shopify; if (s.connected || !this.ready('oauth')) throw fail('Shopify app not set up', 409);
    // Reject duplicate parameters before canonicalising, then bind state to owner session and chosen shop.
    const q = {}; for (const [k, v] of params) { if (k in q) throw fail('bad_callback'); q[k] = v; }
    if (!SHOP.test(q.shop || '')) throw fail('bad_shop');
    const msg = Object.keys(q).filter(k => k !== 'hmac' && k !== 'signature').sort().map(k => `${k}=${q[k]}`).join('&');
    const h = crypto.createHmac('sha256', this.#env.SHOPIFY_APP_SECRET).update(msg).digest('hex');
    if (!/^[a-f0-9]{64}$/.test(q.hmac || '') || !eq(h, q.hmac)) throw fail('bad_hmac', 403);
    // state is a single-use 256-bit nonce minted by the signed-in owner for this exact shop, valid 10 minutes.
    const n = this.#nonce.get(q.state); if (n) this.#nonce.delete(q.state);
    if (!n || n.shop !== q.shop || this.now() - n.at > 600000) throw fail('bad_state', 403);
    if (!q.code || !/^\d+$/.test(q.timestamp || '') || Math.abs(this.now() / 1000 - Number(q.timestamp)) > 600) throw fail('bad_callback');
    const r = await this.fetch(`https://${q.shop}/admin/oauth/access_token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: this.#env.SHOPIFY_APP_CLIENT_ID, client_secret: this.#env.SHOPIFY_APP_SECRET, code: q.code }), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw fail('shopify_connect_failed', 502); const j = await r.json();
    const granted = String(j.scope || '').split(','); if (!j.access_token || SCOPES.some(x => !granted.includes(x))) throw fail('read_scopes_missing', 409);
    // Never return the token, even to the owner/browser.
    this.state().shopify = { connected: true, via: 'oauth', shop: q.shop, connected_at: this.store.iso(), disconnected_once: !!s.disconnected_once, box: this.#seal.seal({ connector: 'shopify', shop: q.shop, token: j.access_token }) }; this.log('owner', 'shopify', 'oauth_connected', 200); return { ok: true };
  }
  #client() {
    const s = this.state().shopify; if (!s.connected || !this.ready(s.via)) throw fail('shopify_not_connected', 409);
    if (s.via === 'existing') { if (s.shop !== this.#env.SHOPIFY_ADMIN_SHOP) throw fail('shop_mismatch'); this.#admin ||= new ShopifyAdmin({ shop: s.shop, clientId: this.#env.SHOPIFY_ADMIN_CLIENT_ID, clientSecret: this.#env.SHOPIFY_ADMIN_CLIENT_SECRET, fetchImpl: this.fetch, now: this.now }); return this.#admin; }
    const c = this.#seal.open(s.box); if (c.connector !== 'shopify' || c.shop !== s.shop || !SHOP.test(c.shop)) throw fail('connector_invalid');
    return { query: async (query, variables) => { assertReadOnlyQuery(query); const r = await this.fetch(`https://${c.shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': c.token }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20000) }); if (!r.ok) throw fail('shopify_query_failed', 502); const j = await r.json(); if (j.errors) throw fail('shopify_query_failed', 502); return j; } };
  }
  // Known KB URLs for the checker's deterministic link check (read-only; empty when the KB is not connected).
  kbVersion() { try { return this.kb && typeof this.kb.version === 'function' ? String(this.kb.version() || '') : ''; } catch { return ''; } }
  kbUrls() { try { return this.state().kb && this.kb && typeof this.kb.urls === 'function' ? this.kb.urls() : []; } catch { return []; } }
  // Brain box symptom-to-research map (symptom-map-* entries), read live at reply time.
  symptomMap() { try { return this.kb ? require('../kb-symptoms').mapFrom(this.kb) : []; } catch { return []; } }
  entryBySlug(slug) { try { return this.kb && typeof this.kb.entryBySlug === 'function' ? this.kb.entryBySlug(slug) : null; } catch { return null; } }
  // Mailbox order lookup (src/mailbox/orderlookup.js): one read-only order query through this same Shopify connection.
  // Internal only (not one of the bot API actions); returns just the fields the match rule and the status view need
  // (no address, items, totals, payment or phone). Throws when the store is not connected or refuses the read.
  connectedForOrders() { const s = this.state().shopify; return !!(s && s.connected && this.ready(s.via)); }
  async orderLookupQuery(q) {
    let status = 200;
    try {
      if (!this.allow('mailbox:order_lookup')) throw fail('rate_limited', 429);
      const j = await this.#client().query(ORDER_LOOKUP, { q: String(q || '').slice(0, 200) });
      return (j.data?.orders?.nodes || []).map(o => ({ name: o.name, createdAt: o.createdAt, cancelledAt: o.cancelledAt, displayFulfillmentStatus: o.displayFulfillmentStatus, email: o.email, customer: o.customer ? { defaultEmailAddress: o.customer.defaultEmailAddress || null } : null, fulfillments: (o.fulfillments || []).map(f => ({ displayStatus: f.displayStatus, estimatedDeliveryAt: f.estimatedDeliveryAt, deliveredAt: f.deliveredAt, trackingInfo: (f.trackingInfo || []).map(t => ({ company: t.company, number: t.number, url: t.url })) })) }));
    } catch (e) { status = e.status || 502; throw e; }
    finally { this.log('mailbox', 'shopify', 'order_lookup', status); }
  }
  async action(actor, id, action, b = {}) {
    let status = 200;
    try {
      if (!this.allow(actor)) throw fail('rate_limited', 429);
      if (id === 'kb' && action === 'search') { if (!this.state().kb || !this.kb) throw fail('kb_not_connected', 409); return { hits: (this.kb.search(String(b.query || '').slice(0, 500), Math.min(5, Math.max(1, Number(b.k) || 3)), typeof b.title === 'string' && b.title.length <= 300 ? { title: b.title } : undefined) || []).map((h) => (h && P.hasRelatedLine(h.text) ? { ...h, text: P.stripRelated(h.text) } : h)).filter((h) => !h || String(h.text || '').trim()) }; } // KB "Related:" lines never reach the writer or checker (triage bug 5)
      if (id !== 'shopify' || !['inventory', 'order_status', 'product_link'].includes(action)) throw fail('action_not_allowed', 403);
      const client = this.#client();
      if (action === 'order_status') {
        const num = String(b.order || '').trim().replace(/^#/, ''); const email = normEmail(b.email);
        if (!/^\d{3,10}$/.test(num)) throw fail('bad_order_number'); if (!email) throw fail('email_required');
        const j = await client.query(ORDER, { q: 'name:' + num }); const o = (j.data?.orders?.nodes || []).find(x => String(x.name).replace(/^#/, '') === num);
        if (!o || !verifyOrderContact(o, { email, phones: [] })) return { ok: false, reason: 'not_found_or_not_verified' };
        return { ok: true, ...safeOrderView(o) };
      }
      const q = String(b.query || '').trim().slice(0, 120); if (!q) throw fail('query_required');
      if (action === 'inventory') { const j = await client.query(INVENTORY, { q }); return { variants: (j.data?.productVariants?.nodes || []).filter(v => v.product?.status === 'ACTIVE').map(v => ({ sku: v.sku, title: v.displayName || v.title, quantity: v.inventoryQuantity })) }; }
      const j = await client.query(PRODUCT, { q }); return { products: (j.data?.products?.nodes || []).filter(v => v.status === 'ACTIVE' && /^https:\/\//.test(v.onlineStoreUrl || '')).map(v => ({ title: v.title, url: v.onlineStoreUrl, ...(v.handle ? { handle: v.handle } : {}), price: v.priceRangeV2?.minVariantPrice ? { amount: v.priceRangeV2.minVariantPrice.amount, currency: v.priceRangeV2.minVariantPrice.currencyCode } : null,
        ...(((v.options || []).some(o => (o.values || []).length)) ? { options: (v.options || []).filter(o => (o.values || []).length).map(o => ({ name: o.name, values: o.values || [] })) } : {}),
        variants: (v.variants?.nodes || []).slice(0, 20).map(x => ({ ...((String(x.id || '').match(/(\d+)$/) || [])[1] ? { id: String(x.id).match(/(\d+)$/)[1] } : {}), title: x.title, price: x.price != null ? String(x.price) : null, in_stock: Number.isFinite(Number(x.inventoryQuantity)) ? Math.max(0, Number(x.inventoryQuantity)) : null, available: x.availableForSale !== false })) }))
        .sort((a, b) => rank(b.title, q) - rank(a.title, q)) };
    } catch (e) { status = e.status || 502; throw fail(e.status ? e.message : 'connector_unavailable', status); }
    finally { this.log(actor, id, action, status); }
  }
}
// Prefer the product whose title matches the asked-for model exactly (e.g. "iPhone 16 Pro" over "iPhone 16 Pro Max").
function rank(title, q) { const t = String(title).toLowerCase(); const w = String(q).toLowerCase(); let n = t.includes(w) ? 10 : 0; for (const x of ['max', 'plus', 'ultra', 'mini']) if (t.includes(' ' + x) && !w.includes(x)) n -= 5; return n; }
module.exports = { MailTools, SHOP, SCOPES, CALLBACK, INVENTORY, PRODUCT, ORDER, ORDER_LOOKUP };
