'use strict';
// "System notes for this email" (John, Nov 16, 2026, 12:14 PM ET): one block placed right under the customer's email for the
// writer and the checker. Facts our system added, never the customer's words. Callbots Mailbox only; phone and text untouched.
// Order details appear only for orders matched by the sender's email address. No address or payment details, ever.
const PC = require('./phone-catalog');

const TITLE = 'System notes for this email';
const INTRO = 'Added automatically by our system, not written by the customer. Use these facts when replying.';
const CATALOG_TITLE = 'QuantaCases for phones mentioned in this email';
const ORDERS_TITLE = 'Orders on file for this sender';
const ORDERS_MATCH = 'This email address matches these orders:';
const ORDERS_NONE = 'No orders on file for this email or phone number.';
const ORDERS_PHONE_ONLY = 'A phone number in this email may match an order on file, but it could not be verified as the sender\'s. Do not mention any order details.';
const SWITCH_RULE = 'has not shipped yet. If the customer wants a different color, offer to switch the order to that color before it ships (they just reply with the color they want) instead of a return or mailing it back.';

function isProcessing(o) { return !!o && o.status === 'processing'; }

// Other in-stock colors of the ordered phone's QuantaCase (catalog + live stock), not counting the color ordered.
function otherColors(product, ordered, fallback = PC.DEFAULT_COLOR) {
  const seen = new Set([String(ordered || '').toLowerCase()]); const out = [];
  for (const v of ((product && product.variants) || []).filter(v => v.available !== false)) {
    const c = PC.colorName(v, fallback); const k = c.toLowerCase();
    if (seen.has(k)) continue; seen.add(k); out.push(c);
  }
  return out;
}

function orderLines(order, productFor, fallback) {
  const lines = [];
  const tr = (order.tracking || [])[0];
  let head = '- ' + order.order_number + ': ' + (order.status ? order.status + (isProcessing(order) ? ' (not shipped yet)' : '') : 'status unavailable');
  if (tr) head += ', tracking ' + (tr.carrier ? tr.carrier + ' ' : '') + tr.number + (tr.url ? ' ' + tr.url : '');
  lines.push(head);
  for (const it of (order.items || [])) {
    lines.push('  Ordered: ' + it.title + ', ' + it.color + (it.quantity > 1 ? ' (qty ' + it.quantity + ')' : ''));
    const product = productFor ? productFor(it) : null;
    if (!product) continue;
    const others = otherColors(product, it.color, fallback);
    lines.push('  ' + (others.length ? 'Other in-stock colors for this phone: ' + others.join(', ') + '. ' : 'No other colors in stock for this phone right now. ') + 'Current listing: ' + PC.formatProductLine(product, fallback).replace(/^- /, ''));
  }
  return lines;
}

// catalogHit: phoneCatalog.resolve() result. orderFacts: orderIndex.factsFor() result (null when the index is off).
// productFor(item): the catalog product (with live stock) for an ordered item, or null.
function build({ catalogHit = null, orderFacts = null, productFor = null, fallback = PC.DEFAULT_COLOR } = {}) {
  const sections = [];
  const found = (catalogHit && catalogHit.found) || [];
  if (found.length) sections.push([CATALOG_TITLE, ...found.map(x => PC.formatProductLine(x.product, fallback))].join('\n'));
  const switchOrders = [];
  if (orderFacts) {
    const lines = [ORDERS_TITLE];
    if (orderFacts.match === 'email' && orderFacts.orders && orderFacts.orders.length) {
      lines.push(ORDERS_MATCH);
      for (const o of orderFacts.orders) { lines.push(...orderLines(o, productFor, fallback)); if (isProcessing(o)) switchOrders.push(o.order_number); }
      for (const n of switchOrders) lines.push('Switch before shipping: ' + n + ' ' + SWITCH_RULE);
    } else if (orderFacts.match === 'phone_unverified') lines.push(ORDERS_PHONE_ONLY);
    else lines.push(ORDERS_NONE);
    sections.push(lines.join('\n'));
  }
  if (!sections.length) return null;
  return { text: [TITLE, INTRO, ...sections].join('\n\n'), switch_orders: switchOrders };
}

// Fields for writer/checker inputs. phone_catalog stays structured for the deterministic catalog checks.
function fields(catalogHit, notes) {
  const out = {};
  if (catalogHit && catalogHit.found && catalogHit.found.length) out.phone_catalog = { title: PC.BLOCK_TITLE, models: catalogHit.models || [], products: catalogHit.found.map(x => x.product) };
  if (notes && notes.text) out.system_notes = notes.text;
  if (notes && notes.switch_orders && notes.switch_orders.length) out.switch_orders = notes.switch_orders;
  return out;
}

// The customer wants a different color: a color word plus a change word (not an address change or a plain status question).
const COLOR_WORD = /\bcolou?rs?\b|\b(?:black|brown|turquoise|blue|navy|red|green|pink|purple|white|gr[ae]y|tan|beige|gold)\b/i;
const CHANGE_WORD = /\b(?:different|another|other|wrong|switch|swap|change|exchange|return|instead|rather)\b/i;
const WANTS_CHANGE = { test: (t) => COLOR_WORD.test(t) && CHANGE_WORD.test(t) };
const OFFERS_SWITCH = /\b(?:switch|swap|change|update)\b[^.?!]{0,120}\b(?:before (?:it|the order|your order) (?:ships|ship|goes out)|has(?:n'?t| not) shipped|not shipped yet|hasn'?t gone out)\b|\b(?:before (?:it|the order|your order) (?:ships|goes out)|has(?:n'?t| not) shipped yet|not shipped yet)\b[^.?!]{0,120}\b(?:switch|swap|change|update)\b/i;
// Deterministic checker rule: a processing email-matched order + a color/exchange request => the reply offers the switch.
function switchProblem(origText, body, switchOrders) {
  if (!switchOrders || !switchOrders.length) return null;
  if (!WANTS_CHANGE.test(String(origText || ''))) return null;
  if (OFFERS_SWITCH.test(String(body || ''))) return null;
  return 'Order ' + switchOrders.join(', ') + ' has not shipped yet: offer to switch it to the color they want before it ships (they reply with the color) instead of a return';
}

module.exports = { TITLE, INTRO, CATALOG_TITLE, ORDERS_TITLE, ORDERS_MATCH, ORDERS_NONE, ORDERS_PHONE_ONLY, SWITCH_RULE, build, fields, otherColors, switchProblem, offersSwitch: (b) => OFFERS_SWITCH.test(String(b || '')) };
