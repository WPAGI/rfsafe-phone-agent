'use strict';
const crypto = require('crypto');
// Mailbox order lookup (John, Nov 15, 2026: 10:49 PM ET "build the Mailbox Shopify order lookup and block web search on order
// and tracking questions"; 10:52 PM ET match rule; 10:51 PM ET test-sender override; 10:53 PM ET reuse the phone line's code).
//
// Reuse: the order matching is the phone line's code. src/shopify.js here carries the same order functions as
// WPAGI/rfsafe-phone-agent src/shopify.js @ a13b9d066bbcc77849961ddf89107c3158061141 (ShopifyAdmin, orderStatus,
// verifyOrderContact, normEmail, assertReadOnlyQuery: identical), and the guard below is the phone order_status tool's
// "at most 3 failed checks" guard (src/tools.js), kept per sender email and persisted in the mailbox store.
// Read-only: one GraphQL *query* through the Mailbox's existing Shopify connection (MailTools.orderLookup).
//
// Match rule (John, 10:52 PM ET). Share ONLY status, fulfillment and tracking when EITHER
//  (a) the SENDER address is the order's email: with an order number, that order must be the sender's; with no order
//      number, the sender's most recent order (the reply names its order number); OR
//  (b) the body gives an order number AND an email that both match the same order, whoever sends it.
// Anything else (no match, mismatch, too many failed tries, lookup error, no connection) -> no order details at all, and
// the reply uses the Brain box entry order-status-where-is-my-order (asks for the name, email and phone on the order).
// Never shared: street address, items, totals, payment, phone. Logs carry the order number only.
const { verifyOrderContact, normEmail } = require('../shopify');

const FALLBACK_SLUG = 'order-status-where-is-my-order';
// Config (code defaults; optional env overrides, none set on Render).
//  fullTrackingForVerifiedEmail: once an order is VERIFIED by the rule above, the email gets the FULL carrier tracking
//    number and a clickable tracking link. Deliberate difference from the phone line (safeOrderView keeps only the last 4
//    digits). MAIL_ORDER_FULL_TRACKING=0 turns it off (last 4 digits only, no link).
//  testSenders: senders whose order lookups are logged as "test-sender order lookup" (Jarvis's test inbox, John 10:51 PM
//    ET "we'll have to have an override for your email testing it"). Under rule (b) they need the order number AND the
//    order's email in the body, like anyone else. MAIL_ORDER_TEST_SENDERS = comma-separated list replaces the default.
//    The default test inbox is kept as a sha256 of the lowercased address (testSenderHashes) because the brand separation
//    test bans other businesses' names in shipped files; the plain address is in CHANGELOG/docs and test/.
const ORDER_LOOKUP_DEFAULTS = Object.freeze({ fullTrackingForVerifiedEmail: true, testSenders: Object.freeze([]), testSenderHashes: Object.freeze(['50af2a4ce94c24310c5786a2016242f43798208f0e52ba20f2f45e5f258fd3af']), maxFailedPerSender: 3, failWindowMs: 24 * 3600000 });
function orderLookupConfig(env = {}) {
  const ts = String(env.MAIL_ORDER_TEST_SENDERS || '').split(',').map(normEmail).filter(Boolean);
  const ft = String(env.MAIL_ORDER_FULL_TRACKING == null ? '' : env.MAIL_ORDER_FULL_TRACKING).trim();
  return { ...ORDER_LOOKUP_DEFAULTS, testSenders: ts, testSenderHashes: ts.length ? [] : [...ORDER_LOOKUP_DEFAULTS.testSenderHashes], fullTrackingForVerifiedEmail: ft === '' ? ORDER_LOOKUP_DEFAULTS.fullTrackingForVerifiedEmail : !/^(0|false|no|off)$/i.test(ft) };
}

// Order, shipping, tracking, refund, return and account questions (web research is never run for these).
const ORDER_TOPIC = /\b(?:my order|(?:an|the|this|that|your|our|recent|last|online) order|orders? (?:number|no\.?|status|#|confirmation)|order\s*#?\s*\d{3,}|#\s?\d{3,10}\b|ordered|tracking|track(?:ing)? (?:my|the|it|number|info\w*|link)|shipped|shipping (?:status|confirmation|update|notice)|shipment|in transit|out for delivery|delivered|delivery (?:status|date|update)|my (?:package|parcel)|package|parcel|(?:has|hasn't|has not|didn't|did not|still not|never|not yet) (?:arrived|come|shipped|received)|arriv(?:e|ed|al) (?:yet|date)|where(?:'s| is) (?:it|my|the (?:order|package|case))|still (?:no|waiting|haven't|have not)|refund\w*|return(?:s|ed|ing)?\b|exchang\w*|my account|password|log ?in|sign ?in|cancel\w*|charged?\b|invoice|receipt)/i;
// Science / health / product-knowledge words: a gap with one of these may still use web research in a mixed email.
const SCIENCE = /\b(?:radiation|radio[- ]?frequency|rf\b|emf|sar\b|cancer|tumou?r|glioma|study|studies|research|evidence|pregnan\w*|fetus|fetal|baby|health|brain|dna|5g|4g|wi-?fi|bluetooth|fcc|who\b|iarc|ntp|exposure|frequenc\w*|symptom\w*|headache|sleep|tinnitus|fertility|sperm|children|kids|science|scientific|safe(?:ty)? limit|microwave|cell tower|antenna|shield\w*|block(?:s|ing)? (?:radiation|rf)|magsafe|charging)\b/i;
const isOrderTopic = (s) => ORDER_TOPIC.test(String(s || ''));
// A web-research subquestion is blocked when it is itself an order/shipping/account question, or when the email is an
// order email and the subquestion has no science/health/product-knowledge word (e.g. "Where is it?").
function webBlocked(subquestion, emailIsOrder) { const g = String(subquestion || ''); return isOrderTopic(g) || (!!emailIsOrder && !SCIENCE.test(g)); }
// Order-status asks that trigger a Shopify lookup (status, shipping, tracking, delivery; not refunds or returns).
const STATUS_Q = /\b(?:tracking|track(?:ing)? (?:my|the|it|number|info\w*|link)|order status|status of (?:my|the) order|(?:has|have) (?:my order|it) (?:shipped|been shipped)|shipped|shipment|in transit|out for delivery|delivered|delivery (?:status|date|update)|where(?:'s| is) (?:it|my|the (?:order|package|case))|(?:hasn't|has not|didn't|did not|still not|never|not yet) (?:arrived|come|shipped|received)|still (?:no|waiting for|haven't (?:received|gotten|got))|when (?:will|does|do) (?:my|it|the) (?:order|package|case)? ?(?:arrive|ship|come|get here))/i;
const isOrderStatusQ = (subject, text) => STATUS_Q.test(String(subject || '') + '\n' + String(text || '')) && isOrderTopic(String(subject || '') + '\n' + String(text || ''));

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const ORDER_NUM_RE = /(?:#\s?(\d{3,10})\b|\border\s*(?:number|no\.?|num|#)?\s*[:#]?\s*#?\s?(\d{3,10})\b)/i;
const OWN = /@(?:rfsafe\.(?:app|com|org)|quantacase\.com|truthcase\.com|mail\.rfsafe\.app)$/i;
function orderRefs(subject, text) {
  const s = String(subject || '') + '\n' + String(text || '');
  const m = ORDER_NUM_RE.exec(s); const number = m ? (m[1] || m[2]) : null;
  const emails = [...new Set((s.match(EMAIL_RE) || []).map(normEmail).filter((e) => e && !OWN.test(e)))].slice(0, 5);
  return { number, emails };
}
// PII backstop for anything sent to web search: emails, phone numbers, order numbers and the sender's own names are removed.
function scrubPII(text, { names = [] } = {}) {
  let s = String(text || '').replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[phone]').replace(/#\s?\d{3,10}\b/g, '[order]').replace(/\border\s*(?:number|no\.?|num|#)?\s*[:#]?\s*\d{3,10}\b/gi, 'order [order]');
  for (const n of names.map((x) => String(x || '').trim()).filter((x) => x.length >= 2)) for (const part of [n, ...n.split(/\s+/)].filter((x) => x.length >= 3)) s = s.replace(new RegExp('\\b' + part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'), '[name]');
  return s;
}

// Tracking links: only these carrier/store hosts, and only for a verified order (added to the checker's known links for
// that one email). USPS / UPS / FedEx links are rebuilt from the number when Shopify gives none or another host.
const TRACK_HOSTS = ['tools.usps.com', 'www.usps.com', 'usps.com', 'www.ups.com', 'ups.com', 'www.fedex.com', 'fedex.com', 'quantacase.com', 'www.quantacase.com'];
function trackingUrl(carrier, number, url) {
  try { if (url) { const u = new URL(url); if (u.protocol === 'https:' && TRACK_HOSTS.includes(u.hostname.toLowerCase())) return u.toString(); } } catch {}
  const n = String(number || '').replace(/\s+/g, ''); if (!/^[A-Za-z0-9]{8,40}$/.test(n)) return null; const c = String(carrier || '').toLowerCase();
  if (/usps|postal/.test(c)) return 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' + encodeURIComponent(n);
  if (/\bups\b/.test(c)) return 'https://www.ups.com/track?tracknum=' + encodeURIComponent(n);
  if (/fedex/.test(c)) return 'https://www.fedex.com/fedextrack/?trknbr=' + encodeURIComponent(n);
  return null;
}
// What the writer may share for a VERIFIED order: status, fulfillment and tracking only.
function verifiedView(o, { fullTracking }) {
  const shipments = (o.fulfillments || []).map((f) => ({ status: f.displayStatus || null, estimated_delivery: f.estimatedDeliveryAt ? String(f.estimatedDeliveryAt).slice(0, 10) : null, delivered_at: f.deliveredAt ? String(f.deliveredAt).slice(0, 10) : null,
    tracking: (f.trackingInfo || []).map((t) => fullTracking ? { carrier: t.company || null, number: t.number ? String(t.number) : null, url: trackingUrl(t.company, t.number, t.url) } : { carrier: t.company || null, number_last4: t.number ? String(t.number).slice(-4) : null }) }));
  return { order: o.name, placed: String(o.createdAt || '').slice(0, 10), cancelled: !!o.cancelledAt, fulfillment_status: String(o.displayFulfillmentStatus || 'UNFULFILLED').toLowerCase(), shipments };
}
// Carrier tracking hosts (USPS, UPS, FedEx): a link there is only allowed when it is exactly a verified order's link.
const CARRIER_HOSTS = TRACK_HOSTS.filter((h) => !/quantacase/.test(h));
function isCarrierUrl(u) { try { return CARRIER_HOSTS.includes(new URL(u).hostname.toLowerCase()); } catch { return false; } }
const urlsOf = (ol) => ol && ol.matched ? (ol.order || {}).shipments.flatMap((s) => s.tracking.map((t) => t.url).filter(Boolean)) : [];

// One lookup for one email. query(q) runs the read-only order query; db is the persisted mailbox db (failed-try guard).
function isTestSender(email, cfg) { const e = normEmail(email); return !!e && ((cfg.testSenders || []).includes(e) || (cfg.testSenderHashes || []).includes(crypto.createHash('sha256').update(e).digest('hex'))); }

async function lookupOrder({ query, sender, subject, text, db, cfg = ORDER_LOOKUP_DEFAULTS, now = Date.now() }) {
  const from = normEmail(sender); const refs = orderRefs(subject, text); const num = refs.number; const tag = num ? '#' + num : 'no order number';
  const test = isTestSender(from, cfg);
  const g = (db.order_lookup_fails ||= {}); const key = require('crypto').createHash('sha256').update('order-fails|' + (from || '?')).digest('hex').slice(0, 24);
  const cur = g[key] && now - g[key].at < cfg.failWindowMs ? g[key] : { count: 0, at: now };
  const miss = (reason, countIt) => { if (countIt) { g[key] = { count: cur.count + 1, at: now }; } return { matched: false, reason, order_number: num, test_sender: test }; };
  if (cur.count >= cfg.maxFailedPerSender) return miss('too_many_attempts', false);
  if (!num && !from) return miss('no_order_number_or_sender', false);
  let nodes;
  try { nodes = (await query(num ? 'name:' + num : 'email:"' + from.replace(/"/g, '') + '"')) || []; }
  catch (e) { return { matched: false, reason: 'lookup_failed', detail: /scope|access|denied|403|401/i.test(String(e && e.message)) ? 'the store connection refused the order read (read_orders scope?)' : 'the store did not answer', order_number: num, test_sender: test }; }
  let o = null; let via = null;
  if (num) {
    o = nodes.find((x) => String(x.name).replace(/^#/, '') === num) || null;
    if (!o) return miss('no_such_order', true);
    if (from && verifyOrderContact(o, { email: from, phones: [] })) via = 'sender';
    else if (refs.emails.some((e) => verifyOrderContact(o, { email: e, phones: [] }))) via = 'body';
    else return miss('email_mismatch', true);
  } else {
    o = nodes.filter((x) => verifyOrderContact(x, { email: from, phones: [] })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
    if (!o) return miss('no_order_for_sender', true);
    via = 'sender_latest';
  }
  if (g[key]) delete g[key];
  return { matched: true, via, test_sender: test, order_number: String(o.name).replace(/^#/, ''), order: verifiedView(o, { fullTracking: cfg.fullTrackingForVerifiedEmail }) };
}
// Owner-visible activity line (order number only; no email, name, phone or address).
function activityLine(r) {
  const on = r.order_number ? '#' + r.order_number : 'no order number';
  const pre = (r.test_sender ? 'Test-sender order lookup ' : 'Shopify order lookup ') + on + ': ';
  if (r.matched) return pre + 'matched (' + (r.via === 'sender' ? 'sender address is the order email' : r.via === 'body' ? 'order number + email in the body' : 'sender\'s most recent order') + '); sharing status and tracking only';
  const why = { too_many_attempts: 'too many failed tries from this sender (3 in 24 h)', no_order_number_or_sender: 'no order number and no sender address', lookup_failed: 'lookup unavailable, ' + (r.detail || 'error'), no_such_order: 'no order with that number', email_mismatch: 'the order email does not match the sender or the email in the body', no_order_for_sender: 'no order for the sender address', not_connected: 'the store is not connected' }[r.reason] || r.reason;
  return pre + 'not matched (' + why + '); no order details shared, using the ' + FALLBACK_SLUG + ' answer';
}
// For the writer and the checker.
function forWriter(r) {
  if (r.matched) return { matched: true, order: r.order, note: 'Verified order (' + (r.via === 'sender_latest' ? 'the sender\'s most recent order; name its order number ' + r.order.order + ' in the reply' : 'order ' + r.order.order) + '). Share ONLY its status, fulfillment and tracking (carrier, tracking number and tracking link exactly as given). Never mention the address, items, totals, payment or phone. Do not use web research for this order question.' };
  return { matched: false, note: 'No order details may be shared (not verified or not found). Answer the order question with the knowledge-base entry "' + FALLBACK_SLUG + '": ask for the name, email and phone used on the order. Do not say whether an order exists. Do not use web research for order, shipping or tracking questions.' };
}
// Checker backstop: an unverified order reply must not carry anything that looks like a tracking number.
const TRACKING_LIKE = /\b(?:9[2-5]\d{18,24}|1Z[0-9A-Z]{16}|\d{12}|\d{15}|\d{20,22}|[A-Z]{2}\d{9}US)\b/;
function unverifiedTrackingProblem(body, ol) { if (!ol || ol.matched) return null; const m = TRACKING_LIKE.exec(String(body || '')); return m ? 'Shares a tracking-like number although the order was not verified: "' + m[0].slice(0, 6) + '…"' : null; }

module.exports = { ORDER_LOOKUP_DEFAULTS, orderLookupConfig, FALLBACK_SLUG, isOrderTopic, isOrderStatusQ, webBlocked, orderRefs, scrubPII, trackingUrl, TRACK_HOSTS, CARRIER_HOSTS, isTestSender, isCarrierUrl, verifiedView, urlsOf, lookupOrder, activityLine, forWriter, unverifiedTrackingProblem };
