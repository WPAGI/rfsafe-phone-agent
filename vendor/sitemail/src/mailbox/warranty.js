'use strict';
// Warranty / $20 replacement past-order model check (John, Nov 18 2026 8:38 PM ET, via Jarvis: "you need to make sure that the
// phones that they ordered in the past are the models that they're expecting to get a warranty replacement for at the twenty
// dollars... if they hadn't, ... the only cases we have that you show ... are the blank model, blank model, or blank model, and to
// please provide the order details for that particular model phone").
//
// Pure functions shared by the Mailbox (vendored sitemail) and the phone/text tools (src/tools.js warranty_check).
// Privacy: callers pass ONLY orders already matched to the requester (Mailbox: sender email via orderindex.factsFor; phone and
// text: caller ID, or an order number verified with the email/phone on it). Only phone models come out of here, never order
// contents, prices, addresses or other customers' data.
//
// Model names are compared as exact keys from bots.phoneKeys (most specific wins): "iPhone 16 Pro" and "iPhone 16 Pro Max" are
// different phones, and so are the Galaxy S24, S24+ (S24 Plus) and S24 Ultra.

// bots.js requires this file, so phoneKeys / specificKeys are loaded lazily (at call time) to avoid a require cycle.
function B() { return require('./bots'); }

const TITLE = 'Replacement check against this sender\'s past orders';
const WARRANTY_Q = /\bwarrant(?:y|ies|ee)\b/i;

// The approved no-orders ask (same facts as the live replacement answer, PR #75).
const NO_ORDERS_ASK = 'To start the replacement, please send your order number, or the name, email and phone number used on the order.';
// John, Nov 18 2026 8:48 PM ET: "let them know that the only cases we show are warrantable under this phone number or email,
// whichever one it is and then you can make a list of 'em ... if the order was placed from a different email or phone number
// ... to please let you know. Or to please call us from that number or use that email. To access warranty information."
const OTHER_CONTACT = 'If the order was placed with a different email or phone number, please let us know, or contact us from that email or call us from that number, to access warranty information.';

// Which identifier the orders were matched under. Never the full phone number or the address itself: "this email",
// "this phone number ending in 0150" (last 4 digits at most), or "that order number" (phone path, order number + contact).
function last4(p) { const d = String(p || '').replace(/\D/g, ''); return d.length >= 4 ? d.slice(-4) : ''; }
function idPhrase(via) {
  const v = via || {};
  if (v.kind === 'phone') return 'this phone number' + (v.last4 ? ' ending in ' + v.last4 : '');
  if (v.kind === 'order') return 'that order number';
  return 'this email';
}

// "+": "S24+" / "Galaxy S24+" is the S24 Plus (phoneKeys alone drops the "+"). Z Fold / Z Flip get their own keys.
function modelKeys(text) {
  let t = String(text || '').replace(/™|®|%E2%84%A2|%C2%AE/gi, ' ');
  t = t.replace(/\b((?:galaxy\s+|samsung\s+(?:galaxy\s+)?)?s\s?\d{2})\s*\+/gi, '$1 Plus');
  const z = [];
  t = t.replace(/\b(?:(?:samsung\s+)?galaxy\s+|samsung\s+)?z\s*[- ]?\s*(fold|flip)\s*[- ]?\s*(\d{1,2})\b/gi, (m, kind, n) => { z.push('galaxy z ' + kind.toLowerCase() + ' ' + n); return ' '; });
  const keys = [...new Set([...B().phoneKeys(t), ...z])];
  return B().specificKeys(keys);
}

const UPPER = new Set(['xl', 'fe', 'z']);
function label(key) {
  return String(key || '').split(' ').filter(Boolean).map(w => {
    if (w === 'iphone') return 'iPhone';
    if (w === 'oneplus') return 'OnePlus';
    if (UPPER.has(w)) return w.toUpperCase();
    if (/^[a-z]\d/.test(w)) return w.charAt(0).toUpperCase() + w.slice(1);
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

function listJoin(xs) {
  const a = (xs || []).filter(Boolean);
  if (a.length <= 1) return a[0] || '';
  if (a.length === 2) return a[0] + ' and ' + a[1];
  return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
}

// A $20 replacement / warranty request ("replacement", a broken or worn case, a lost case, or "warranty").
function isWarrantyRequest(text) {
  const t = String(text || '');
  try { if (B().isReplacementQ(t)) return true; } catch {}
  return WARRANTY_Q.test(t);
}

// Models on the requester's own orders: [{ key, label, orders: ['#1173'] }], in first-seen order.
// orders: [{ order_number, items: [{ title, color? }] }] (orderindex.factsFor shape; the phone path maps to the same shape).
function orderedModels(orders) {
  const out = new Map();
  for (const o of orders || []) {
    for (const it of (o && o.items) || []) {
      const blob = [it && it.title, it && it.variant, it && it.color].filter(Boolean).join(' ');
      for (const k of modelKeys(blob)) {
        if (!out.has(k)) out.set(k, { key: k, label: label(k), orders: [] });
        const rec = out.get(k); const n = o.order_number || o.order || null;
        if (n && !rec.orders.includes(n)) rec.orders.push(n);
      }
    }
  }
  return [...out.values()];
}

// John, Nov 18 2026 8:54 PM ET: "the warranty is applied only toward the phone models that have been purchased. And they're
// good for as long as you own that phone." A requested model that is not on their orders: buy that case at the regular
// price, or reach us from the number or email that model's order was placed with.
const PER_MODEL = 'The $20 replacement applies only to those models, for as long as you own that phone.';
function mismatchSentence(ordered, requested, orderCount, via) {
  const reqs = requested.length > 1 ? listJoin(requested) + ' cases' : requested[0] + ' case';
  return 'The only cases we show as warrantable under ' + idPhrase(via) + ' are for the ' + listJoin(ordered) + '. ' + PER_MODEL + ' For your ' + reqs + ', you would need to buy ' + (requested.length > 1 ? 'them' : 'it') + ' at the regular price, or send us the order details for ' + (requested.length > 1 ? 'them' : 'it') + '. ' + OTHER_CONTACT;
}
// No phone named, orders found (John, Nov 18 2026 9:53 PM ET; r.27cdb25a): list the models on file, ask which one the
// replacement is for, and add the different email / phone line.
const NO_MODEL_ASK = 'Which phone is the replacement case for?';
function noModelSentence(ordered, via) {
  return 'The cases we show as warrantable under ' + idPhrase(via) + ' are for the ' + listJoin(ordered) + '. ' + NO_MODEL_ASK + ' ' + OTHER_CONTACT;
}
function noOrdersSentence(via) {
  return 'We don\'t show any warrantable orders under ' + idPhrase(via) + '. ' + OTHER_CONTACT;
}

// The check. match: 'email' | 'phone' | 'order' | 'phone_unverified' | 'none'. orders: the requester's own orders only.
// requestedText: the customer's words (subject + body, or what the caller said is the phone).
// Result: { result, requested: [labels], ordered: [labels], matched_orders, sentence? }
//   match       every requested model is on one of their orders -> normal replacement flow
//   mismatch    they have orders, but not for (all of) the requested model(s) -> name their models, ask for that order's details
//   no_orders   no verified orders -> ask for the order number, or the name, email and phone on the order
//   no_model    orders found but no phone model named -> ask which phone (normal replacement answer asks for the model)
//   no_items    orders found but their items could not be read (live lookup failed) -> normal flow, no model claims
// via: { kind: 'email' | 'phone' | 'order', last4? } names the identifier in the reply (never the full value).
function check({ match = 'none', orders = [], requestedText = '', via = { kind: 'email' } } = {}) {
  const requestedKeys = modelKeys(requestedText);
  const requested = requestedKeys.map(label);
  const verified = (match === 'email' || match === 'phone' || match === 'order') && (orders || []).length > 0;
  if (!verified) return { result: 'no_orders', unverified: match === 'phone_unverified', via: via.kind, requested, ordered: [], matched_orders: [], sentence: noOrdersSentence(via) };
  const models = orderedModels(orders);
  if (!models.length) return { result: 'no_items', requested, ordered: [], matched_orders: [] };
  const ordered = models.map(m => m.label);
  if (!requestedKeys.length) return { result: 'no_model', via: via.kind, requested, ordered, matched_orders: [], sentence: noModelSentence(ordered, via) };
  const have = new Map(models.map(m => [m.key, m]));
  const hit = requestedKeys.filter(k => have.has(k)); const miss = requestedKeys.filter(k => !have.has(k));
  const matched_orders = [...new Set(hit.flatMap(k => have.get(k).orders))];
  if (!miss.length) return { result: 'match', requested, ordered, matched: hit.map(label), matched_orders };
  return { result: 'mismatch', requested, ordered, matched: hit.map(label), unmatched: miss.map(label), matched_orders, via: via.kind, sentence: mismatchSentence(ordered, miss.map(label), (orders || []).length, via) };
}

// Mailbox: the check from orderindex.factsFor() facts (null when the index is off or this is not a replacement request).
function forEmail(orig, orderFacts) {
  if (!orderFacts) return null;
  const text = String((orig && orig.subject) || '') + '\n' + String((orig && orig.text) || '');
  if (!isWarrantyRequest(text)) return null;
  // Only the customer's own words (not a quoted earlier reply) name the phone they want replaced.
  const own = text.split(/\n(?:On .{0,200}wrote:|-{2,}\s*Original Message|>)/)[0];
  return check({ match: orderFacts.match, orders: orderFacts.match === 'email' ? (orderFacts.orders || []) : [], requestedText: own, via: { kind: 'email' } });
}

// System-notes lines for the writer and checker.
function noteLines(wc) {
  if (!wc) return null;
  const lines = [TITLE];
  if (wc.requested.length) lines.push('Phone model(s) the customer wants a replacement case for: ' + wc.requested.join(', ') + '.');
  if (wc.result === 'match') {
    lines.push('Result: match. ' + (wc.matched_orders.length ? 'Order ' + wc.matched_orders.join(', ') + ' includes' : 'Their past orders include') + ' a case for the ' + listJoin(wc.matched || wc.requested) + '. Continue with the normal $20 replacement answer.');
  } else if (wc.result === 'mismatch') {
    lines.push('Result: ' + (wc.matched && wc.matched.length ? 'partial match' : 'no match') + '. The cases on this sender\'s own past orders (matched by the sender email) are for: ' + wc.ordered.join(', ') + '.');
    if (wc.matched && wc.matched.length) lines.push('Covered: the ' + listJoin(wc.matched) + (wc.matched_orders.length ? ' (order ' + wc.matched_orders.join(', ') + ')' : '') + ' is on their orders: give the normal $20 replacement answer for it.');
    lines.push('Not covered: the ' + listJoin(wc.unmatched) + '. The $20 replacement applies only to models on their orders.');
    lines.push('Include these sentences word for word: "' + wc.sentence + '"');
    lines.push('Do not say their order includes the ' + listJoin(wc.unmatched) + ', and only name phone models listed in this note.');
  } else if (wc.result === 'no_model') {
    lines.push('Result: the customer did not name the phone. The cases on this sender\'s own past orders (matched by the sender email) are for: ' + wc.ordered.join(', ') + '.');
    lines.push('Include these sentences word for word: "' + wc.sentence + '"');
  } else if (wc.result === 'no_items') {
    lines.push('Result: the items on this sender\'s orders could not be read right now. Use the normal $20 replacement answer and make no claim about which phone their order was for.');
  } else {
    lines.push('Result: no orders on file for this sender' + (wc.unverified ? ' that could be verified' : '') + '. Include these sentences word for word: "' + wc.sentence + '" Also ask for the order number, or the name, email and phone number used on the order. Do not name any phone model as being on their order.');
  }
  return lines.join('\n');
}

function norm(s) { return String(s || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim(); }

// Deterministic checker rule. Returns { problem, edits } or null.
function problem(wc, body) {
  if (!wc) return null;
  const b = norm(body);
  if (wc.result === 'mismatch') {
    if (b.includes(norm(wc.sentence).replace(/[.!?]+$/, ''))) return null;
    return { kind: 'warranty_mismatch', problem: 'Replacement request for the ' + listJoin(wc.unmatched) + ', but the only cases under this email are for the ' + listJoin(wc.ordered) + ': the reply must list those models, ask for the order details for the ' + listJoin(wc.unmatched) + ' and say to contact us from the email or phone the order was placed with', edits: [{ action: 'add', text: wc.sentence, reason: 'Past-order model check: the requested phone is not on this sender\'s orders', fact: wc.sentence, source: 'system_notes' }] };
  }
  if (wc.result === 'no_model') {
    // Every part is required: the models on file (each one), a which-phone question, and the different email / phone line.
    const missing = [];
    const have = new Set(modelKeys(body));
    if (!/\bwarrantable under this (?:email|phone number)\b/.test(b) || wc.ordered.some(l => !modelKeys(l).every(k => have.has(k)))) missing.push('the models on file under this email');
    if (!/\bwhich\b[^?]{0,80}\?/.test(b)) missing.push('which phone the replacement is for');
    if (!b.includes(norm(OTHER_CONTACT).replace(/[.!?]+$/, ''))) missing.push('the different email or phone line');
    if (!missing.length) return null;
    return { kind: 'warranty_no_model', problem: 'Replacement request with orders on file but no phone named: the reply must list ' + listJoin(missing), edits: [{ action: 'add', text: wc.sentence, reason: 'Past-order model check: no phone named; list the models on file, ask which one, and add the different email or phone line', fact: wc.sentence, source: 'system_notes' }] };
  }
  if (wc.result === 'no_orders') {
    const edits = [];
    if (!b.includes(norm(wc.sentence).replace(/[.!?]+$/, ''))) edits.push({ action: 'add', text: wc.sentence, reason: 'Past-order model check: no warrantable orders under this email; say so and how to reach us from the email or phone on the order', fact: wc.sentence, source: 'system_notes' });
    if (!(/\border number\b/.test(b) && /\bname,? email,? and phone\b/.test(b))) edits.push({ action: 'add', text: NO_ORDERS_ASK, reason: 'Past-order model check: ask for the order number, or the name, email and phone on the order', fact: NO_ORDERS_ASK, source: 'system_notes' });
    if (!edits.length) return null;
    return { kind: 'warranty_no_orders', problem: 'Replacement request with no orders on file for this sender: the reply must say no warrantable orders show under this email, ask for the order number (or the name, email and phone number used on the order), and say to let us know or contact us from the email or phone the order was placed with', edits };
  }
  return null;
}

// Phone and text: what the agent should say for a check result (tool "say" field).
function sayFor(wc) {
  if (wc.result === 'match') return 'Their past order includes a case for the ' + listJoin(wc.matched || wc.requested) + '. Continue with the normal $20 replacement steps.';
  if (wc.result === 'mismatch') return (wc.matched && wc.matched.length ? 'Their past order includes a case for the ' + listJoin(wc.matched) + ': continue with the normal $20 replacement steps for it. For the ' + listJoin(wc.unmatched) + ', say: "' : 'Say: "') + wc.sentence + '" Do not name any other phone models, and never read out a full phone number or email.';
  if (wc.result === 'no_model') return 'Ask which phone model the replacement case is for, then check again.';
  if (wc.result === 'no_items') return 'Continue with the normal $20 replacement steps, without saying which phone their order was for.';
  return 'Say: "' + wc.sentence + '" Then ask for the order number, or the name, email and phone number used on the order. Never read out a full phone number or email.';
}

module.exports = { NO_MODEL_ASK, noModelSentence, TITLE, NO_ORDERS_ASK, OTHER_CONTACT, PER_MODEL, idPhrase, last4, noOrdersSentence, WARRANTY_Q, modelKeys, label, listJoin, isWarrantyRequest, orderedModels, mismatchSentence, check, forEmail, noteLines, problem, sayFor };
