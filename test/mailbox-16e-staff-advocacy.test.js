'use strict';
// Nov 16, 2026 held test emails (mock data only): r.65159806 / r.5d54bdd0 "Phone for my 12 year old" (iPhone 16 vs 16e),
// staff names in a reply ("as John Coates approved it"), r.4c0eb3df (an advocacy KB entry forced into a shipping reply).
const test = require('node:test'); const assert = require('node:assert');
const B = require('../vendor/sitemail/src/mailbox/bots');
const { defaults } = require('../vendor/sitemail/src/mailbox/bot-defaults');

const P16 = { title: 'iPhone 16 RFS1 Anti-Radiation Case', handle: 'apple-iphone-16', url: 'https://quantacase.com/products/apple-iphone-16', price: { amount: '69.00', currency: 'USD' }, variants: [{ id: '1', title: 'Black', price: '69.00', available: true }] };
const P16E = { title: 'Quanta case Apple iPhone 16 E Anti-Radiation', handle: 'apple-iphone-16-e', url: 'https://quantacase.com/products/apple-iphone-16-e', price: { amount: '69.99', currency: 'USD' }, variants: [{ id: '2', title: 'Black', price: '69.99', available: true }, { id: '3', title: 'Turquoise', price: '69.99', available: true }] };
const P16PRO = { title: 'iPhone 16 Pro Anti-Radiation Case', handle: 'apple-iphone-16-pro', url: 'https://quantacase.com/products/apple-iphone-16-pro', price: { amount: '69.00', currency: 'USD' }, variants: [{ id: '4', title: 'Black', price: '69.00', available: true }] };
const P16PLUS = { title: 'iPhone 16 Plus Anti-Radiation Case', handle: 'apple-iphone-16-plus', url: 'https://quantacase.com/products/apple-iphone-16-plus', price: { amount: '69.00', currency: 'USD' }, variants: [{ id: '5', title: 'Black', price: '69.00', available: true }] };
const SL = { products: [P16E, P16, P16PRO, P16PLUS] };
const ASK = "My daughter is turning 12 and getting her first phone, an iPhone 16. Would your case be a good choice for her, and what else should we do to keep her exposure down?";

test('16 vs 16e: "e" is its own model key, in titles, handles and email text', () => {
  assert.deepStrictEqual(B.phoneKeys(P16E.title), ['iphone 16e']);
  assert.deepStrictEqual(B.phoneKeys('apple iphone 16 e'), ['iphone 16e']);
  assert.deepStrictEqual(B.phoneKeys('my iPhone 16e'), ['iphone 16e']);
  assert.deepStrictEqual(B.phoneKeys(P16.title), ['iphone 16']);
  assert.deepStrictEqual(B.phoneKeys('iPhone 16 Pro and an iPhone 16 Plus'), ['iphone 16 pro', 'iphone 16 plus']);
  assert.deepStrictEqual(B.extractPhoneModels('', ASK).map(m => m.toLowerCase()), ['iphone 16']);
  assert.deepStrictEqual(B.extractPhoneModels('', 'Cases for an iPhone 16 and an iPhone 16e?').map(m => B.phoneKeys(m)[0]), ['iphone 16', 'iphone 16e'], 'both kept: the 16e is not a more specific iPhone 16');
});

test('r.65159806: an iPhone 16 email needs only the iPhone 16 facts, never the 16e listing', () => {
  const good = "Hi there,\n\nThe iPhone 16 RFS1 Anti-Radiation Case comes in Black, is $69.00 and in stock: https://quantacase.com/products/apple-iphone-16\n\nThe RF Safe team";
  assert.deepStrictEqual(B.missingProductProblems(good, SL, ASK), []);
  const miss = B.missingProductProblems('Hi there,\n\nWe have tips.\n\nThe RF Safe team', SL, ASK);
  assert.strictEqual(miss.length, 1); assert.strictEqual(miss[0].product.handle, 'apple-iphone-16');
  assert.deepStrictEqual(B.checkLinks(good, { storeLookup: SL, asked: ASK }).problems, []);
  const wrong = B.checkLinks('Case: https://quantacase.com/products/apple-iphone-16-e', { storeLookup: SL, asked: ASK }).problems;
  assert.strictEqual(wrong.length, 1, 'the 16e link does not match an iPhone 16 question');
  assert.deepStrictEqual(B.checkLinks('Case: https://quantacase.com/products/apple-iphone-16-e', { storeLookup: SL, asked: 'Do you have an iPhone 16e case?' }).problems, []);
  for (const [ask, h] of [['iPhone 16 Pro case?', 'apple-iphone-16-pro'], ['iPhone 16 Plus case?', 'apple-iphone-16-plus'], ['iPhone 16e case?', 'apple-iphone-16-e']]) {
    const m = B.missingProductProblems('Hi.', SL, ask); assert.strictEqual(m.length, 1, ask); assert.strictEqual(m[0].product.handle, h, ask);
  }
});

test('staff names: attributions are dropped; John Coates becomes "the founder of RF Safe", never "owner"', () => {
  assert.strictEqual(B.stripStaffNames("RF Safe's position, as John Coates approved it: we don't recommend that children use cell phones."), "RF Safe's position: we don't recommend that children use cell phones.");
  assert.strictEqual(B.stripStaffNames('The policy, approved by Katie Webb, is simple.'), 'The policy is simple.');
  assert.strictEqual(B.stripStaffNames('Our policy (approved by John Coates) is simple.'), 'Our policy is simple.');
  assert.strictEqual(B.stripStaffNames('John Coates started RF Safe in 2009.'), 'The founder of RF Safe started RF Safe in 2009.');
  assert.strictEqual(B.stripStaffNames('Ask our owner.'), 'Ask the founder of RF Safe.');
  const greet = 'Hi John,\n\nThanks for writing.\n\nThe RF Safe team';
  assert.strictEqual(B.stripStaffNames(greet), greet, "a customer's own first name stays");
  assert.match(defaults.replier.prompt, /Never name staff in a reply/); assert.match(defaults.replier.prompt, /the founder of RF Safe/);
  assert.match(defaults.checker.prompt, /Fail a draft that names staff/);
  assert.strictEqual(defaults.replier.version, '1.9.27');
});

test('r.4c0eb3df: an advocacy entry never backs a deferral edit; date words alone are not a topic match', () => {
  const SHARE = { title: 'Share this to protect our children!', layer: 'full', text: "> We're scheduling a Zoom conference call for early next week to talk strategy on contacting your key U.S. Reps before the next vote. Please let us know your availability." };
  const SHIP = { title: 'Shipping times', layer: 'light', text: 'Orders ship from Florida by USPS; the West Coast takes about 4 to 6 business days.' };
  const DEADLINE = "I'd like to have it before the end of next week.";
  assert.ok(require('../vendor/sitemail/src/kblight').goodMatch(require('../vendor/sitemail/src/kblight').queryTerms(DEADLINE), SHARE), 'the old rule matched it (before, next, week)');
  assert.strictEqual(B.advocacyEntry(SHARE), true);
  assert.strictEqual(B.supportHit(DEADLINE, SHARE), false);
  assert.strictEqual(B.supportHit(DEADLINE, { ...SHARE, title: 'Plain', text: 'before the end of next week' }), false, 'time words only');
  assert.strictEqual(B.supportHit('How long does shipping take to San Diego, California?', SHIP), true);
  assert.strictEqual(B.supportHit('Is there a Zoom call about contacting our U.S. Reps before the vote?', SHARE), true, 'asked about advocacy');
});

test('r.4c0eb3df end to end: deferralProblems returns no edit from the advocacy entry', async () => {
  const SHARE = { title: 'Share this to protect our children!', layer: 'full', text: "> We're scheduling a Zoom conference call for early next week to talk strategy on contacting your key U.S. Reps before the next vote." };
  const fake = { tools: { action: async () => ({ hits: [SHARE] }) } };
  const body = "Hi there,\n\nWe do carry it. For delivery before the end of next week, our team will confirm the timing for you.\n\nThe RF Safe team";
  const out = await B.MailBots.prototype.deferralProblems.call(fake, { id: 'replier' }, body, ["I'd like to have it before the end of next week."], { products: [] });
  assert.deepStrictEqual(out, []);
});
