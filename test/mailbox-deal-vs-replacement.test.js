'use strict';
// Deal vs replacement, signal hedge, MagSafe wording and shop link (John, Nov 17 2026 4:32 PM ET, relayed by Jarvis:
// "Yes, split the Brain box entry and have Coder fix the prompts on both sites, deploy once tests pass, then retest").
// Mocks only: no network, no real email, no real keys.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const B = require('../vendor/sitemail/src/mailbox/bots');
const { MailBots } = B;
const { defaults } = require('../vendor/sitemail/src/mailbox/bot-defaults');
const { MailboxStore } = require('../vendor/sitemail/src/mailbox/store');
const { Sealer, newKey } = require('../vendor/sitemail/src/mailbox/crypto');

const SHOP = 'https://quantacase.com/'; const TRUTH = 'https://quantacase.com/pages/quantacase-truthcase';
const MAGSAFE = 'The QuantaCase is not MagSafe compatible. As a design preference, RF Safe chose not to add metal plates or magnets to the back of the case. It does not interfere with wireless charging.';
const DEAL = "We don't offer coupon codes or other discounts; check back during holiday sales.";
const REPL = "Replacement cases are always $20 plus shipping for as long as you own that phone. To get one, reply to this email with your original order number (or the name, email and phone number used on the order) plus your phone model, and the RF Safe team will set up the $20 replacement. We can't offer coupon codes or other discounts, but the cases are sometimes discounted, so check back during holiday sales.";
const HEDGE = "QuantaCase's design choices are meant to avoid antenna detuning and the power increases that can come with it. The phone and network manage transmission power. QuantaCase's thin, antenna-conscious design is intended to avoid unnecessary interference, not to guarantee the lowest output under all conditions.";
const Q = {
  deal: { id: 'r.mock-deal', subject: 'Two cases', text: 'Is there a deal if I buy two?' },
  repl: { id: 'r.mock-repl', subject: 'Worn out case', text: 'My QuantaCase is worn out after two years. Can I get a replacement case?' },
  signal: { id: 'r.mock-signal', subject: 'Signal', text: 'Will the case block my signal or make my phone put out more power?' },
  buyer: { id: 'r.mock-buyer', subject: 'Thinking about a case', text: "I'm thinking about buying one of your cases. Is it worth it?" },
  charge: { id: 'r.mock-charge', subject: 'Charging', text: 'Does it work with my wireless charger?' },
  fit: { id: 'r.mock-fit', subject: 'Fit', text: 'How thin is the case?' }
};
const passGrade = () => ({ verdict: 'pass', main_question: 'customer question', answers_main_question: true, questions_asked: ['q'], unanswered: [], unasked_additions: [], notes: 'ok', improvements: [] });
function harness({ kbUrls = [SHOP, TRUTH] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-t-dealrepl-'));
  const store = new MailboxStore({ file: path.join(dir, 'mailbox.json'), sealer: new Sealer(newKey()) });
  const tools = { state: () => ({ shopify: { connected: true } }), kbUrls: () => kbUrls, kbVersion: () => 'test', entryBySlug: () => null, connectedForOrders: () => false, action: async () => ({ hits: [] }) };
  const fetchImpl = async (url) => String(url).includes('/v1/language-models') ? { ok: true, status: 200, json: async () => ({ models: [] }) }
    : String(url).includes('/chat/completions') ? { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(passGrade()) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) }
    : { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  const bots = new MailBots({ store, env: { XAI_API_KEY: 'xai-test-not-real' }, fetchImpl, tools, ownDomains: ['rfsafe.app'], received: async () => [], original: async () => null, createDraft: async () => ({ code: 201, body: {} }) });
  store.setSettings({ auto_send: true, daily_cap: 20 }, 'test'); bots.db.cap = 100;
  for (const id of ['sorter', 'replier', 'checker']) bots.toggle(id, true);
  for (const r of Object.values(bots.db.installed)) if (r.enabled) r.enabled_at = 0;
  const review = (orig, body) => bots.review(bots.db.installed.checker, orig, store.createDraft({ author: 'bot:replier', reply_to_id: orig.id, to: 'pat@sample.example', subject: 'Re: ' + orig.subject, body }), { kb_gaps: [] });
  return { bots, review, dir };
}
const mail = (...parts) => 'Hi there,\n\n' + parts.join('\n\n') + '\n\nThe RF Safe team';

test('prompt defaults 1.9.27: deal answer only for deal questions; the $20 replacement text only for replacement questions', () => {
  for (const k of ['sorter', 'replier', 'checker']) assert.strictEqual(defaults[k].version, '1.9.27', k);
  const w = defaults.replier.prompt, c = defaults.checker.prompt;
  assert.match(w, /For a deal, coupon, promo-code, discount, multiple-case or bulk question \(for example "Is there a deal if I buy two\?"\), answer that part only with: we don\\?'t offer coupon codes or other discounts; check back during holiday sales\. Do not add the replacement-case policy to a deal question\./);
  assert.match(w, /Only when the customer actually asks about a replacement case[^.]*, answer from the owner-approved policy, in this order, in up to three sentences: \(a\) replacement cases are always \$20 plus shipping[^;]*; \(b\) how to get one: reply to this email with the original order number[^;]*will set up the \$20 replacement; \(c\) we can\\?'t offer coupon codes or other discounts/);
  assert.doesNotMatch(w, /For a discount, coupon, promo-code or replacement-case question/);
  assert.match(c, /Do not require the replacement-case policy on a deal question/);
  assert.match(c, /Fail a replacement-case draft that leaves out the \$20 policy or how to get one/);
  assert.match(c, /Fail any draft that offers, promises or invents a discount/);
  assert.doesNotMatch(c, /for a discount or replacement-case question the answer is/);
});

test('deal question "Is there a deal if I buy two?": the deal answer passes; adding the replacement how-to fails', async () => {
  assert.ok(B.isDealQ(Q.deal.subject + '\n' + Q.deal.text)); assert.ok(!B.isReplacementQ(Q.deal.text));
  const h = harness();
  const ok = await h.review(Q.deal, mail(DEAL));
  assert.strictEqual(ok.verdict, 'pass', ok.notes);
  const bad = await h.review(Q.deal, mail(DEAL + ' ' + REPL));
  assert.strictEqual(bad.verdict, 'fail'); assert.match(bad.notes, /Deal question: the draft adds the \$20 replacement-case policy/);
  assert.ok((bad.edits || []).some(e => e.action === 'cut' && /\$20 plus shipping/.test(e.text)), JSON.stringify(bad.edits));
  const missing = await h.review(Q.deal, mail('Thanks for asking about two cases.'));
  assert.strictEqual(missing.verdict, 'fail'); assert.match(missing.notes, /does not say we don't offer coupon codes/);
  // The checker still fails any offered or invented discount on a deal question.
  const offer = await h.review(Q.deal, mail('Yes, use code FAMILY20 for 20% off two cases. ' + DEAL));
  assert.strictEqual(offer.verdict, 'fail'); assert.match(offer.notes, /Offers or promises a discount/);
  for (const q of ['Do you have a coupon code?', 'Any bulk discount for 10 cases?', 'Is the case on sale for Black Friday?', 'Is there a family deal on multiple cases?']) assert.ok(B.isDealQ(q), q);
  for (const q of ['I want to order two cases for my iPhone 16 and iPhone 17.', 'How do I deal with a weak signal?']) assert.ok(!B.isDealQ(q), q);
});

test('replacement question: the replacement text in the approved order passes; a replacement answer without it, or out of order, fails', async () => {
  const h = harness();
  const ok = await h.review(Q.repl, mail(REPL));
  assert.strictEqual(ok.verdict, 'pass', ok.notes);
  const missing = await h.review(Q.repl, mail(DEAL));
  assert.strictEqual(missing.verdict, 'fail'); assert.match(missing.notes, /Replacement-case question: the draft leaves out the \$20 replacement policy or how to get one/);
  assert.ok((missing.edits || []).some(e => e.action === 'add' && e.text === REPL), JSON.stringify(missing.edits));
  const order = await h.review(Q.repl, mail("To get one, reply to this email with your original order number plus your phone model, and the RF Safe team will set up the $20 replacement. Replacement cases are always $20 plus shipping for as long as you own that phone."));
  assert.strictEqual(order.verdict, 'fail'); assert.match(order.notes, /must come before how to get one/);
  assert.strictEqual(B.handoffProblem(mail(REPL), []), null, '"will set up the $20 replacement" is still not a hand-off');
  for (const q of ['How much is a replacement case?', 'My case cracked, what can I do?', 'I lost my QuantaCase.', 'Is there a discount on a replacement case?']) assert.ok(B.isReplacementQ(q), q);
  assert.ok(!B.isReplacementQ('I got a replacement phone, an iPhone 16. Which case fits?'));
});

test('signal question: the hedged wording passes; flat "is not detuned" / "does not ramp up power" claims fail', async () => {
  const w = defaults.replier.prompt, c = defaults.checker.prompt;
  assert.ok(w.replace(/\\'/g, "'").includes(HEDGE)); assert.ok(c.replace(/\\'/g, "'").includes(HEDGE));
  assert.match(w, /Never say flatly that the antenna is not detuned or that the phone does not ramp up \(or raise\) its power/);
  assert.doesNotMatch(w, /the phone\\?'s antenna is not detuned and does not ramp up its power;/);
  assert.match(c, /fail a draft that says flatly that the antenna is not detuned or that the phone does not ramp up \(or raise\) its power/);
  const h = harness();
  const ok = await h.review(Q.signal, mail('No, it is not designed to block your signal. ' + HEDGE));
  assert.strictEqual(ok.verdict, 'pass', ok.notes);
  for (const flat of ["No. The phone's antenna is not detuned and does not ramp up its power.", 'It has an ultra-thin build so the phone does not ramp up power.', "The case won't make your phone raise its power.", 'Your antenna will not be detuned.']) {
    assert.ok(B.flatSignalClaim(flat), flat);
    const g = await h.review(Q.signal, mail('No, it is not designed to block your signal. ' + flat));
    assert.strictEqual(g.verdict, 'fail', flat); assert.match(g.notes, /States flatly that the antenna is not detuned/);
    assert.ok((g.edits || []).some(e => e.action === 'change' && e.instead === HEDGE), JSON.stringify(g.edits));
  }
  assert.strictEqual(B.flatSignalClaim('Metal clasps can detune the antenna, and magnets can make the phone ramp up its power.'), null, 'the red flags are not a flat claim');
});

test('MagSafe wording appears only when charging comes up, and then word for word', async () => {
  const w = defaults.replier.prompt, c = defaults.checker.prompt;
  assert.ok(w.includes('Do not mention MagSafe or wireless charging unless the customer asks about charging, MagSafe, magnets or wireless charging; when they do, use this exact text: "' + MAGSAFE + '"'));
  assert.ok(c.includes(MAGSAFE));
  const h = harness();
  const ok = await h.review(Q.charge, mail(MAGSAFE));
  assert.strictEqual(ok.verdict, 'pass', ok.notes);
  const old = await h.review(Q.charge, mail('The QuantaCase is not MagSafe compatible. It does not interfere with wireless charging.'));
  assert.strictEqual(old.verdict, 'fail'); assert.match(old.notes, /does not use the owner-approved MagSafe text word for word/);
  assert.ok((old.edits || []).some(e => e.action === 'add' && e.text === MAGSAFE));
  const unasked = await h.review(Q.fit, mail('The case is ultra-thin.', MAGSAFE));
  assert.strictEqual(unasked.verdict, 'fail'); assert.match(unasked.notes, /Mentions MagSafe or wireless charging, which the customer did not ask about/);
  const plain = await h.review(Q.fit, mail('The case is ultra-thin.'));
  assert.strictEqual(plain.verdict, 'pass', plain.notes);
  assert.strictEqual(B.chargingProblem('Will it work with MagSafe?', mail('No, ' + MAGSAFE.charAt(0).toLowerCase() + MAGSAFE.slice(1))), null, 'a leading "No," is fine');
});

test('a buyer who names no phone model gets the shop link and the TruthCase page link; a named model does not need it', async () => {
  const w = defaults.replier.prompt;
  assert.match(w, /thinking about buying a case but names no phone model \(and it is not a deal question\), add the shop link https:\/\/quantacase\.com\/ on its own line[^.]*along with the TruthCase page link https:\/\/quantacase\.com\/pages\/quantacase-truthcase on its own line\./);
  const h = harness();
  const ok = await h.review(Q.buyer, mail('The QuantaCase is made for your exact phone.', 'Shop QuantaCase and pick your phone model here:\n' + SHOP, 'How the TruthCase design works:\n' + TRUTH));
  assert.strictEqual(ok.verdict, 'pass', ok.notes);
  const missing = await h.review(Q.buyer, mail('The QuantaCase is made for your exact phone.', TRUTH));
  assert.strictEqual(missing.verdict, 'fail'); assert.match(missing.notes, /Buying question with no phone model: the draft needs the shop link/);
  assert.ok((missing.edits || []).some(e => e.action === 'add' && e.text.includes(SHOP)), JSON.stringify(missing.edits));
  assert.ok(!B.isBuyerNoModel('I want to buy a case for my iPhone 16 Pro.'), 'named model');
  assert.ok(!B.isBuyerNoModel('Is there a deal if I buy two?'), 'deal question gets only the deal answer');
  assert.ok(!B.isBuyerNoModel('Where is my order #1042? I bought a case last week.'), 'existing order');
  // The link allowlist is not widened: when the shop link is not an allowed link on a site, it is not demanded.
  const closed = harness({ kbUrls: [TRUTH] });
  const g = await closed.review(Q.buyer, mail('The QuantaCase is made for your exact phone.', TRUTH));
  assert.strictEqual(g.verdict, 'pass', g.notes);
});
