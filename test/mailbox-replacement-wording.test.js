'use strict';
// Replacement-case wording (RF Safe approved, Nov 17 2026), same as rfsafe.app: for a discount or replacement question the
// writer says, in order, (a) $20 plus shipping replacement policy, (b) how to get one, (c) no coupon codes, check back during
// holiday sales. Mock data only.
const test = require('node:test'); const assert = require('node:assert');
const B = require('../vendor/sitemail/src/mailbox/bots');
const { defaults } = require('../vendor/sitemail/src/mailbox/bot-defaults');
const P = require('../vendor/sitemail/src/mailbox/policy');

const OK = "Hi Lee,\n\nReplacement cases are always $20 plus shipping for as long as you own that phone. To get one, reply to this email with your original order number (or the name, email and phone number used on the order) plus your phone model, and the RF Safe team will set up the $20 replacement. We can't offer coupon codes or other discounts, but the cases are sometimes discounted, so check back during holiday sales.\n\nThe RF Safe team";

test('writer default: replacement policy, how to get one, then no coupon codes / holiday sales, in up to three sentences', () => {
  assert.match(defaults.replier.prompt, /in up to three sentences: \(a\) replacement cases are always \$20 plus shipping for as long as they own that phone; \(b\) how to get one: reply to this email with the original order number \(or the name, email and phone number used on the order\) plus the phone model, and the RF Safe team will set up the \$20 replacement; \(c\) we can\\?'t offer coupon codes or other discounts, but the cases are sometimes discounted, so check back during holiday sales\./);
  assert.doesNotMatch(defaults.replier.prompt, /can\\?'t authorize discounts/);
  assert.match(defaults.replier.prompt, /Never offer, promise or invent a discount, code or percentage off/);
  assert.strictEqual(defaults.replier.version, '1.9.26');
});

test('checker default: accepts the new order and does not require the literal "can\'t authorize discounts"', () => {
  const ck = defaults.checker.prompt;
  assert.match(ck, /in order: replacement cases are always \$20 plus shipping[^"]*will set up the \$20 replacement[^"]*can\\?'t offer coupon codes or other discounts/);
  assert.match(ck, /do not fail it just because it lacks the literal phrase "can\\?'t authorize discounts"/);
  assert.match(ck, /Fail any draft that offers, promises or invents a discount/);
  assert.strictEqual(defaults.checker.version, '1.9.26');
});

test('"the RF Safe team will set up the $20 replacement" is not a hand-off, deferral, discount offer or hard block; "we\'ll get back to you" still is a hand-off', () => {
  assert.strictEqual(B.handoffProblem(OK, []), null);
  assert.strictEqual(B.discountOffer(OK), null);
  for (const s of OK.split(/(?<=[.!?])\s+|\n+/).filter(x => x.trim())) assert.deepStrictEqual(P.hardBlock(s), [], s);
  for (const b of ["Hi Lee, replacement cases are always $20 plus shipping. We'll get back to you about the replacement.", 'Hi Lee, the RF Safe team will follow up on your replacement.', 'Hi Lee, someone from our team will contact you about the replacement.'])
    assert.ok(B.handoffProblem(b, []), b);
  for (const b of ['Use code FAMILY20 at checkout.', 'I can give you 15% off if you order four.']) assert.ok(B.discountOffer(b), b);
});
