'use strict';
// Callbots mailbox past-customer order index (John, Nov 16 4:31–4:34 AM ET). REVIEW ONLY until John says go.
// Mailbox only: phone and text lookup paths are unchanged. order_lookup_enabled is unchanged.
//
// Stored fields (only): first name, order number, email (lowercased), phone (E.164).
// Every record is marked unsubscribed from email and text and must never be used for marketing.
// The file lives on the server persistent disk (sitemail data dir), mode 0600, sealed with MAILBOX_ENC_KEY
// when a key is available. Never in git, logs, /health, admin pages, or any public GET route.
//
// Privacy (phone-in-body matches): an order is treated as the sender's only when the sender email matches.
// A phone found in the email body may corroborate an email match, but a phone-only hit is unverified:
// the system note says a phone number in the email may match an order on file but could not be verified
// as the sender's, and no order numbers, status, or tracking are included. This prevents leaking another
// customer's orders if someone types a phone number that is not theirs.
//
// Off by default (SITEMAIL_ORDER_INDEX=1 to enable). The orders/create webhook receiver is HMAC-verified
// but is not registered at Shopify until John approves that separately.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NOTE_MATCH = 'System note: this email is associated with the following orders:';
const NOTE_NONE_EMAIL = 'System note: no orders on file for this email.';
const NOTE_NONE_BOTH = 'System note: no orders on file for this email or phone number.';
const NOTE_UNVERIFIED_PHONE = 'System note: a phone number in this email may match an order on file, but it could not be verified as the sender\'s. Do not mention any order details.';
const SYNC_MS = 4 * 60 * 60 * 1000;
const FILE_NAME = 'order-index.sealed';
const FLAG = 'SITEMAIL_ORDER_INDEX';

const LIST_QUERY = 'query($n:Int!,$cursor:String,$q:String){ orders(first:$n, after:$cursor, query:$q, sortKey:UPDATED_AT){ pageInfo{ hasNextPage endCursor } nodes{ id name updatedAt email phone customer{ firstName defaultEmailAddress{ emailAddress } defaultPhoneNumber{ phoneNumber } } } } } }';
const STATUS_QUERY = 'query($q:String!){ orders(first:5, query:$q){ nodes{ name cancelledAt displayFulfillmentStatus fulfillments(first:5){ displayStatus trackingInfo(first:3){ company number url } } } } } }';
const COUNT_QUERY = 'query { ordersCount { count } }';

function flagOn(env = {}) { return /^(1|true|yes|on)$/i.test(String(env[FLAG] || '').trim()); }

function normEmail(s) {
  const e = String(s || '').trim().toLowerCase().replace(/\s+at\s+/g, '@').replace(/\s+dot\s+/g, '.').replace(/\s+/g, '');
  return /^[^@]+@[^@]+\.[a-z]{2,}$/.test(e) ? e : '';
}

function toE164(s) {
  const raw = String(s || '').trim();
  if (!raw) return '';
  const d = raw.replace(/\D/g, '');
  if (!d) return '';
  if (raw.startsWith('+') && d.length >= 8 && d.length <= 15) return '+' + d;
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  if (d.length >= 8 && d.length <= 15) return '+' + d;
  return '';
}

function firstNameOf(v) {
  const t = String(v || '').trim().split(/\s+/)[0] || '';
  const n = t.replace(/[^A-Za-zÀ-ÿ'’.-]/g, '').slice(0, 40);
  return n;
}

function orderNumberOf(v) {
  const s = String(v || '').trim();
  const m = s.match(/#?\s*(\d{3,10})\b/);
  return m ? '#' + m[1] : '';
}

function keepRecord(raw) {
  const email = normEmail(raw && (raw.email || (raw.customer && (raw.customer.email || (raw.customer.defaultEmailAddress && raw.customer.defaultEmailAddress.emailAddress)))));
  const phone = toE164(raw && (raw.phone || (raw.customer && (raw.customer.phone || (raw.customer.defaultPhoneNumber && raw.customer.defaultPhoneNumber.phoneNumber)))));
  const order_number = orderNumberOf(raw && (raw.order_number || raw.name || raw.order));
  const first_name = firstNameOf(raw && (raw.first_name || raw.firstName || (raw.customer && (raw.customer.first_name || raw.customer.firstName))));
  if (!order_number || (!email && !phone)) return null;
  return { first_name: first_name || '', order_number, email, phone, email_unsubscribed: true, sms_unsubscribed: true };
}

function recordId(r) { return String(r && r.order_number || ''); }

function extractPhones(text) {
  const s = String(text || '');
  const out = new Set();
  const re = /(?:\+?\d[\d\s().-]{7,18}\d)/g;
  let m;
  while ((m = re.exec(s))) {
    const p = toE164(m[0]);
    if (p) out.add(p);
  }
  return [...out];
}

function senderEmail(from, text) {
  const header = String(from || '');
  const inAngles = header.match(/<([^>]+)>/);
  return normEmail(inAngles ? inAngles[1] : header) || normEmail(from);
}

function verifyHmac(secret, header, rawBody) {
  const sec = String(secret || '');
  const got = String(header || '').trim();
  if (!sec || !got) return false;
  const digest = crypto.createHmac('sha256', sec).update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8')).digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function statusLabel(o) {
  if (!o) return 'processing';
  if (o.cancelledAt || o.cancelled) return 'cancelled';
  const fulfills = o.fulfillments || o.fulfillments?.nodes || [];
  const list = Array.isArray(fulfills) ? fulfills : (fulfills.nodes || []);
  const fs = list.map(f => String(f.displayStatus || f.status || '').toUpperCase());
  if (fs.some(s => s === 'DELIVERED')) return 'delivered';
  if (fs.some(s => s === 'IN_TRANSIT' || s === 'OUT_FOR_DELIVERY')) return 'in transit';
  const d = String(o.displayFulfillmentStatus || '').toUpperCase();
  if (d === 'FULFILLED' || fs.some(s => s === 'SUCCESS' || s === 'CONFIRMED')) return 'shipped';
  return 'processing';
}

function trackingOf(o) {
  const fulfills = o && (o.fulfillments || []);
  const list = Array.isArray(fulfills) ? fulfills : (fulfills.nodes || []);
  const out = [];
  for (const f of list) {
    for (const t of (f.trackingInfo || [])) {
      if (t && t.number) out.push({ carrier: t.company || null, number: String(t.number), url: t.url || null });
    }
  }
  return out;
}

function formatMatchLine(orderNumber, status, tracking) {
  let s = orderNumber + ' (' + status + ')';
  if (tracking && tracking.length) {
    const t = tracking[0];
    s += ', tracking' + (t.carrier ? ' ' + t.carrier : '') + ' ' + t.number + (t.url ? ' ' + t.url : '');
  }
  return s;
}

function createOrderIndex({ dataDir, fileName = FILE_NAME, sealer, adminQuery, now = () => new Date(), log = () => {}, env = {}, hmacSecret = null, fetchImpl, syncMs = SYNC_MS, mock = false } = {}) {
  if (!dataDir) throw new Error('order-index: dataDir is required');
  const file = path.join(dataDir, fileName);
  let data = { version: 1, updated_at: null, cursor: { last_updated_at: null, last_id: null }, records: [] };
  let timer = null;

  function enabled() { return flagOn(env) && !mock; }

  function load() {
    try {
      if (!sealer) return false;
      const raw = fs.readFileSync(file, 'utf8');
      const opened = sealer.open(raw);
      if (opened && Array.isArray(opened.records)) { data = opened; return true; }
    } catch {}
    return false;
  }

  function save() {
    if (!sealer) throw new Error('order_index_no_key');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + '.tmp';
    const blob = sealer.seal(data);
    fs.writeFileSync(tmp, blob, { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  }

  function upsert(rec) {
    const r = keepRecord(rec);
    if (!r) return false;
    const id = recordId(r);
    const i = data.records.findIndex(x => recordId(x) === id);
    if (i >= 0) data.records[i] = r; else data.records.push(r);
    return true;
  }

  function byEmail(email) {
    const e = normEmail(email);
    if (!e) return [];
    return data.records.filter(r => r.email && r.email === e);
  }

  function byPhone(phone) {
    const p = toE164(phone);
    if (!p) return [];
    return data.records.filter(r => r.phone && r.phone === p);
  }

  function match(from, subject, text) {
    const email = senderEmail(from, text);
    const phones = extractPhones([subject, text].filter(Boolean).join('\n'));
    const emailHits = email ? byEmail(email) : [];
    const seen = new Set(emailHits.map(recordId));
    const phoneHits = [];
    for (const p of phones) {
      for (const r of byPhone(p)) {
        if (seen.has(recordId(r))) continue;
        seen.add(recordId(r));
        phoneHits.push(r);
      }
    }
    return { email, phones, emailHits, phoneHits };
  }

  async function liveStatus(orderNumber) {
    if (typeof adminQuery !== 'function') return null;
    const num = String(orderNumber || '').replace(/^#/, '');
    if (!/^\d{3,10}$/.test(num)) return null;
    try {
      const j = await adminQuery(STATUS_QUERY, { q: 'name:' + num });
      const nodes = (((j || {}).data || {}).orders || {}).nodes || [];
      const o = nodes.find(x => orderNumberOf(x.name) === '#' + num);
      if (!o) return null;
      return { order_number: '#' + num, status: statusLabel(o), tracking: trackingOf(o) };
    } catch {
      return null;
    }
  }

  async function noteFor(orig) {
    if (!flagOn(env)) return null;
    const hit = match(orig && orig.from, orig && orig.subject, orig && orig.text);
    if (hit.emailHits.length) {
      const parts = [];
      for (const r of hit.emailHits) {
        const live = await liveStatus(r.order_number);
        if (live) parts.push(formatMatchLine(live.order_number, live.status, live.tracking));
        else parts.push(r.order_number);
      }
      return NOTE_MATCH + ' ' + parts.join('; ') + '.';
    }
    if (hit.phoneHits.length) return NOTE_UNVERIFIED_PHONE;
    if (hit.phones.length) return NOTE_NONE_BOTH;
    return NOTE_NONE_EMAIL;
  }

  async function importPage(cursor, query) {
    if (typeof adminQuery !== 'function') throw new Error('no_adminQuery');
    const j = await adminQuery(LIST_QUERY, { n: 100, cursor: cursor || null, q: query || null });
    const conn = (((j || {}).data || {}).orders) || {};
    return { nodes: conn.nodes || [], pageInfo: conn.pageInfo || {} };
  }

  async function importAll() {
    if (!flagOn(env)) return { imported: 0, skipped: true };
    let cursor = null; let upserts = 0; let pages = 0;
    for (;;) {
      const { nodes, pageInfo } = await importPage(cursor, null);
      pages += 1;
      let maxUpd = data.cursor.last_updated_at; let lastId = data.cursor.last_id;
      for (const n of nodes) {
        if (upsert(n)) upserts += 1;
        if (n.updatedAt && (!maxUpd || n.updatedAt > maxUpd)) { maxUpd = n.updatedAt; lastId = n.id || lastId; }
      }
      data.cursor = { last_updated_at: maxUpd || data.cursor.last_updated_at, last_id: lastId || data.cursor.last_id };
      data.updated_at = isoNow(now);
      if (!pageInfo.hasNextPage || pages > 200) break;
      cursor = pageInfo.endCursor;
    }
    save();
    log('order_index_import', { upserts, pages });
    return { imported: upserts, pages };
  }

  async function incremental() {
    if (!flagOn(env)) return { upserts: 0, skipped: true };
    const since = data.cursor && data.cursor.last_updated_at;
    const q = since ? ('updated_at:>=' + since) : null;
    if (!q) return importAll();
    let cursor = null; let upserts = 0;
    for (let pages = 0; pages < 50; pages++) {
      const { nodes, pageInfo } = await importPage(cursor, q);
      let maxUpd = data.cursor.last_updated_at; let lastId = data.cursor.last_id;
      for (const n of nodes) {
        if (upsert(n)) upserts += 1;
        if (n.updatedAt && (!maxUpd || n.updatedAt > maxUpd)) { maxUpd = n.updatedAt; lastId = n.id || lastId; }
      }
      data.cursor = { last_updated_at: maxUpd, last_id: lastId };
      if (!pageInfo.hasNextPage) break;
      cursor = pageInfo.endCursor;
    }
    data.updated_at = isoNow(now);
    save();
    log('order_index_sync', { upserts });
    return { upserts };
  }

  function ingestWebhook(raw, headers = {}) {
    if (!flagOn(env)) return { ok: false, status: 404, error: 'off' };
    const secret = hmacSecret || env.SITEMAIL_SHOPIFY_ORDERS_HMAC || env.SHOPIFY_ORDERS_WEBHOOK_SECRET;
    const hmac = headers['x-shopify-hmac-sha256'] || headers['X-Shopify-Hmac-Sha256'];
    if (!verifyHmac(secret, hmac, raw)) return { ok: false, status: 401, error: 'bad_hmac' };
    const topic = String(headers['x-shopify-topic'] || headers['X-Shopify-Topic'] || '');
    if (topic && topic !== 'orders/create' && topic !== 'orders/updated') return { ok: true, status: 200, action: 'ignored' };
    let body;
    try { body = typeof raw === 'string' || Buffer.isBuffer(raw) ? JSON.parse(String(raw)) : raw; } catch { return { ok: false, status: 400, error: 'bad_json' }; }
    const rec = keepRecord(body);
    if (!rec) { log('order_index_webhook', { action: 'skipped' }); return { ok: true, status: 200, action: 'skipped' }; }
    upsert(rec);
    if (body.updated_at || body.updatedAt) {
      const u = body.updated_at || body.updatedAt;
      if (!data.cursor.last_updated_at || u > data.cursor.last_updated_at) data.cursor.last_updated_at = u;
      if (body.admin_graphql_api_id || body.id) data.cursor.last_id = body.admin_graphql_api_id || String(body.id);
    }
    data.updated_at = isoNow(now);
    save();
    log('order_index_webhook', { action: 'upsert' });
    return { ok: true, status: 200, action: 'upsert' };
  }

  function start() {
    if (!flagOn(env) || mock) return api;
    load();
    if (!data.records.length) importAll().catch(() => { log('order_index_import', { err: 'failed' }); });
    else incremental().catch(() => { log('order_index_sync', { err: 'failed' }); });
    timer = setInterval(() => { incremental().catch(() => {}); }, syncMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return api;
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  function fileMode() {
    try { return fs.statSync(file).mode & 0o777; } catch { return null; }
  }

  // Count of stored records only (no payloads). Not for /health or admin pages.
  function recordCount() { return (data.records || []).length; }

  const api = { enabled: () => flagOn(env), load, save, upsert, match, noteFor, importAll, incremental, ingestWebhook, start, stop, fileMode, recordCount, keepRecord, file, data: () => data };
  return api;
}

function isoNow(now) {
  const n = typeof now === 'function' ? now() : now;
  if (typeof n === 'string') return n;
  if (typeof n === 'number') return new Date(n).toISOString();
  if (n && typeof n.toISOString === 'function') return n.toISOString();
  return new Date().toISOString();
}

async function countOrders(adminQuery) {
  if (typeof adminQuery !== 'function') throw new Error('no_adminQuery');
  const j = await adminQuery(COUNT_QUERY, {});
  const n = (((j || {}).data || {}).ordersCount || {}).count;
  if (Number.isFinite(Number(n))) return Number(n);
  throw new Error('orders_count_missing');
}

module.exports = {
  FLAG, NOTE_MATCH, NOTE_NONE_EMAIL, NOTE_NONE_BOTH, NOTE_UNVERIFIED_PHONE, LIST_QUERY, STATUS_QUERY, COUNT_QUERY, SYNC_MS,
  flagOn, normEmail, toE164, firstNameOf, orderNumberOf, keepRecord, extractPhones, senderEmail, verifyHmac, statusLabel, trackingOf, formatMatchLine, createOrderIndex, countOrders
};
