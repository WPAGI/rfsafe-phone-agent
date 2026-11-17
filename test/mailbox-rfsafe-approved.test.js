'use strict';
// John, Nov 16 8:24-8:25 PM ET (via Jarvis): "rather than saying John Coats approved it, you would say that something is RF
// safe approved." Never present him as owner or operator; founder/history facts only when the customer asks. Mock data only.
const test = require('node:test'); const assert = require('node:assert');
const B = require('../vendor/sitemail/src/mailbox/bots');
const { defaults } = require('../vendor/sitemail/src/mailbox/bot-defaults');
const s = B.stripStaffNames;

test('approval attributions become "RF Safe approved" wording', () => {
  assert.strictEqual(s("RF Safe's position, as John Coates approved it: we don't recommend that children use cell phones."), "RF Safe's approved position: we don't recommend that children use cell phones.");
  assert.strictEqual(s('Our policy (approved by John Coates) is simple.'), "RF Safe's approved policy is simple.");
  assert.strictEqual(s('The policy, approved by Katie Webb, is simple.'), 'The policy, RF Safe approved, is simple.');
  assert.strictEqual(s('This wording was approved by John Coates.'), 'This wording is RF Safe approved.');
  assert.strictEqual(s('We ship fast, as John Coates approved it.'), 'We ship fast (RF Safe approved).');
  assert.strictEqual(s('Signed off by the owner.'), 'RF Safe approved.');
  for (const x of ["RF Safe's position, as John Coates approved it: no.", 'Approved by Katie Webb.', 'It was confirmed by Mr. Coates.']) {
    const out = s(x, { founderOk: true });
    assert.doesNotMatch(out, /John|Coates|Katie|Webb|owner/i, out); assert.match(out, /RF Safe approved|RF Safe's approved/);
  }
});

test('never owner or operator; the name stays only for founder or history questions', () => {
  assert.strictEqual(s('John Coates, the owner of RF Safe, said hi.'), 'The founder of RF Safe said hi.');
  assert.strictEqual(s('John Coates, the owner of RF Safe, said hi.', { founderOk: true }), 'John Coates, the founder of RF Safe, said hi.');
  assert.strictEqual(s("Email RF Safe's owner and operator."), 'Email the founder of RF Safe.');
  assert.strictEqual(s('John Coates started RF Safe in 2009.', { founderOk: true }), 'John Coates started RF Safe in 2009.');
  assert.strictEqual(s('Katie Webb will help.', { founderOk: true }), 'RF Safe will help.');
  assert.ok(B.founderQ('Who founded RF Safe?', '')); assert.ok(B.founderQ('', "What's the history of RF Safe?"));
  assert.ok(!B.founderQ('Case for iPhone 15 Pro', 'Do you ship to California?'));
  assert.ok(!B.founderQ('Phone for my 12 year old', 'Is an iPhone 16 OK for my son?'));
});

test("a customer's own name is untouched", () => {
  for (const g of ['Hi John,\n\nThanks for writing.\n\nThe RF Safe team', 'Hi Katie,\n\nYour case ships today.\n\nThe RF Safe team']) assert.strictEqual(s(g), g);
  assert.strictEqual(B.fixGreeting('Hi Katie,\n\nYour case ships today.\n\nThe RF Safe team', 'Katie'), 'Hi Katie,\n\nYour case ships today.\n\nThe RF Safe team');
});

test('prompt defaults 1.9.26 carry the RF Safe approved rule', () => {
  for (const k of ['replier', 'checker']) {
    assert.strictEqual(defaults[k].version, '1.9.26');
    assert.match(defaults[k].prompt, /RF Safe approved/); assert.match(defaults[k].prompt, /owner, operator/); assert.match(defaults[k].prompt, /the founder of RF Safe/);
    assert.match(defaults[k].prompt, /founder or history/);
  }
  assert.match(defaults.replier.prompt, /The RF Safe team/);
});
