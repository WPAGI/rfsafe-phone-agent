'use strict';
// "System notes for this email" (John, Nov 16, 2026, 12:14 PM ET). Mock data only: no network, no real orders.
// Scenario from test r.a4b36626: order #1173 matched by email, processing, a Black iPhone 17 Pro Max QuantaCase;
// Brown and Turquoise in stock at $69.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const SN = require('../vendor/sitemail/src/mailbox/system-notes');
const OI = require('../vendor/sitemail/src/mailbox/orderindex');
const PC = require('../vendor/sitemail/src/mailbox/phone-catalog');
const { extractPhoneModels, fixSignoff } = require('../vendor/sitemail/src/mailbox/bots');
const { defaults } = require('../vendor/sitemail/src/mailbox/bot-defaults');
const { Sealer, newKey } = require('../vendor/sitemail/src/mailbox/crypto');

const URL17 = 'https://quantacase.com/products/apple-iphone-17-pro-max';
const PRODUCT_17 = { title: 'iPhone 17 Pro Max QuantaCase', url: URL17, price: '69.00', variants: [
  { id: 1, title: 'Black', available: true, price: '69.00' }, { id: 2, title: 'Brown', available: true, price: '69.00' }, { id: 3, title: 'Turquoise', available: true, price: '69.00' }] };
const ORDER_1173 = { name: '#1173', cancelledAt: null, displayFulfillmentStatus: 'UNFULFILLED', fulfillments: [],
  lineItems: { nodes: [{ title: 'iPhone 17 Pro Max QuantaCase', variantTitle: 'Black', quantity: 1 }] },
  shippingAddress: { address1: '1 Mock St' }, paymentGatewayNames: ['mock'] };
const EMAIL = { from: 'Pat Mock <pat@mock.example>', subject: 'Wrong color', text: 'I ordered the black case for my iPhone 17 Pro Max but I would rather have a different color. Can I exchange it?' };

async function index1173() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sn-'));
  const api = OI.createOrderIndex({ dataDir: dir, sealer: new Sealer(newKey()), env: { SITEMAIL_ORDER_INDEX: '1' }, hmacSecret: 'x', log: () => {},
    adminQuery: async (q) => ({ data: { orders: { nodes: /lineItems/.test(q) ? [ORDER_1173] : [] } } }) });
  api.upsert({ id: 'gid://shopify/Order/1173', name: '#1173', email: 'pat@mock.example', customer: { firstName: 'Pat' } });
  return { api, dir };
}

test('#1173: the block lists the ordered item and color, the other in-stock colors, and the switch-before-shipping note', async () => {
  const { api, dir } = await index1173();
  try {
    const facts = await api.factsFor(EMAIL);
    assert.strictEqual(facts.match, 'email');
    assert.deepStrictEqual(facts.orders[0].items, [{ title: 'iPhone 17 Pro Max QuantaCase', color: 'Black', quantity: 1 }]);
    assert.deepStrictEqual(extractPhoneModels(facts.orders[0].items[0].title, ''), ['iPhone 17 Pro Max']);
    const catalogHit = { models: ['iPhone 17 Pro Max'], found: [{ model: 'iPhone 17 Pro Max', product: PRODUCT_17 }] };
    const notes = SN.build({ catalogHit, orderFacts: facts, productFor: () => PRODUCT_17 });
    const t = notes.text;
    assert.ok(t.startsWith(SN.TITLE + '\n\n' + SN.INTRO + '\n\n' + SN.CATALOG_TITLE + '\n'), t);
    assert.match(t, /Orders on file for this sender\nThis email address matches these orders:\n- #1173: processing \(not shipped yet\)/);
    assert.match(t, /Ordered: iPhone 17 Pro Max QuantaCase, Black/);
    assert.match(t, /Other in-stock colors for this phone: Brown, Turquoise\. /);
    assert.match(t, /\$69/); assert.ok(t.includes(URL17));
    assert.match(t, /Switch before shipping: #1173 has not shipped yet\. If the customer wants a different color, offer to switch/);
    assert.deepStrictEqual(notes.switch_orders, ['#1173']);
    assert.doesNotMatch(t, /Mock St|payment|gateway/i, 'no address or payment details');
    const f = SN.fields(catalogHit, notes);
    assert.strictEqual(f.system_notes, t); assert.deepStrictEqual(f.switch_orders, ['#1173']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('index keeps storing only first name, order number, email and phone; items are fetched live', () => {
  assert.match(OI.STATUS_QUERY, /lineItems\(first:10\)\{ nodes\{ title variantTitle quantity \} \}/);
  assert.doesNotMatch(OI.STATUS_QUERY, /address|payment|price/i);
  assert.deepStrictEqual(Object.keys(OI.keepRecord({ name: '#1173', email: 'a@b.example', lineItems: ORDER_1173.lineItems, customer: { firstName: 'Pat' } })).sort(), ['email', 'email_unsubscribed', 'first_name', 'order_number', 'phone', 'sms_unsubscribed']);
  assert.deepStrictEqual(OI.itemsOf({ lineItems: { nodes: [{ title: 'Case', variantTitle: 'Default Title', quantity: 2 }] } }), [{ title: 'Case', color: 'Black', quantity: 2 }]);
});

test('phone-only match stays unverified with no details; no match says no orders on file', () => {
  const p = SN.build({ orderFacts: { match: 'phone_unverified', orders: [] } }).text;
  assert.ok(p.includes(SN.ORDERS_PHONE_ONLY)); assert.doesNotMatch(p, /#\d{4}|Ordered:/);
  assert.ok(SN.build({ orderFacts: { match: 'none', orders: [] } }).text.includes('No orders on file for this email or phone number.'));
  assert.strictEqual(SN.build({}), null);
});

test('switch-before-shipping rule: in writer and checker prompts, and the checker fails a mail-it-back reply', () => {
  assert.match(defaults.replier.prompt, /offer to switch the order to that color before it ships/);
  assert.match(defaults.checker.prompt, /Fail a draft that tells the customer to return or mail back an order that has not shipped yet/);
  const back = 'Hi Pat,\n\nTo exchange a case, mail it back to us and we will send the new color.\n\nThe RF Safe team';
  const sw = 'Hi Pat,\n\nYour order #1173 has not shipped yet, so we can switch it to Brown or Turquoise before it ships. Just reply with the color you want.\n\nThe RF Safe team';
  assert.ok(SN.switchProblem(EMAIL.subject + '\n' + EMAIL.text, back, ['#1173']));
  assert.strictEqual(SN.switchProblem(EMAIL.subject + '\n' + EMAIL.text, sw, ['#1173']), null);
  assert.strictEqual(SN.switchProblem(EMAIL.subject + '\n' + EMAIL.text, back, []), null, 'shipped orders keep the normal return path');
});

test('callbots sign-off is "The RF Safe team"', () => {
  assert.match(defaults.replier.prompt, /the sign-off "The RF Safe team"/);
  assert.doesNotMatch(defaults.replier.prompt, /a sign-off from the site team/);
  assert.strictEqual(fixSignoff('Hi Pat,\n\nThanks!\n\nBest,\nThe QuantaCase Team'), 'Hi Pat,\n\nThanks!\n\nBest,\nThe RF Safe team');
  assert.strictEqual(fixSignoff('Hi Pat,\n\nThanks,\nThe RF Safe team'), 'Hi Pat,\n\nThanks,\nThe RF Safe team');
  assert.strictEqual(fixSignoff('Our team will follow up on the team question.\n\nThe RF Safe team'), 'Our team will follow up on the team question.\n\nThe RF Safe team');
});
