'use strict';
// John, Nov 18 2026 9:53 PM ET (via Jarvis): "Yes, have Coder fix the refund checker hold and the no-model warranty reply on
// callbots.org". Mock data only: no network, no real email, no keys. Reproduces held test r.da81c6a6 and test r.27cdb25a
// (texts copied from the read-only edge-test records; no PII).
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const B = require('../vendor/sitemail/src/mailbox/bots');
const P = require('../vendor/sitemail/src/mailbox/policy');
const W = require('../vendor/sitemail/src/mailbox/warranty');
const SN = require('../vendor/sitemail/src/mailbox/system-notes');
const { MailBots } = B;
const { MailboxStore } = require('../vendor/sitemail/src/mailbox/store');
const { Sealer, newKey } = require('../vendor/sitemail/src/mailbox/crypto');

const dirs = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-refund-nomodel-')); dirs.push(d); return d; }
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const MODELS = { models: [{ id: 'grok-4.7', aliases: [], prompt_text_token_price: 20000, cached_prompt_text_token_price: 5000, completion_text_token_price: 60000, output_modalities: ['text'] }] };
function passGrade() { return { verdict: 'pass', main_question: 'q', answers_main_question: true, questions_asked: ['q'], unanswered: [], unasked_additions: [], notes: 'ok', improvements: [] }; }
function harness() {
  const dir = tmp();
  const store = new MailboxStore({ file: path.join(dir, 'mailbox.json'), sealer: new Sealer(newKey()) });
  store.setSettings({ auto_send: false, daily_cap: 20 }, 'test');
  const fetchImpl = async (url, opt = {}) => {
    if (String(url).includes('/v1/language-models')) return { ok: true, json: async () => MODELS };
    if (String(url).includes('/chat/completions')) return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(passGrade()) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const bots = new MailBots({ store, env: { XAI_API_KEY: 'xai-test-not-real' }, fetchImpl,
    tools: { state: () => ({ shopify: { connected: false } }), kbUrls: () => [], kbVersion: () => 't', entryBySlug: () => null, connectedForOrders: () => false, action: async () => ({ hits: [] }) },
    ownDomains: ['callbots.org'], received: async () => [], original: async () => null, createDraft: async () => ({ code: 500 }), autoSend: async () => ({ auto: false }) });
  for (const id of ['sorter', 'replier', 'checker']) bots.toggle(id, true);
  return { bots, store };
}
const draftOf = (h, orig, body) => h.store.createDraft({ author: 'bot:replier', reply_to_id: orig.id, to: 'customer@example.com', subject: 'Re: ' + orig.subject, body });

// ---- 1. Refund timing --------------------------------------------------------------------------------------------------
const REFUND_Q = { id: 'r.da81c6a6-71e7-44b9-afe2-5a1d1a3a5315', subject: 'When will I get my refund?', text: 'Hi, I mailed my case back for a return. Once it arrives at RF Safe, how long until I see the refund?\n\nThanks,\nAngela\n' };
const HELD_DRAFT = 'Hi Angela,\n\nRefunds are issued within 24 hours of your return arriving at RF Safe on a workday. After that, your bank or card company needs its own processing time before the refund shows on your statement.\n\nThe RF Safe team\n';
const BANK = ' After that, your bank needs its own processing time before the refund shows.';

test('refund: the held r.da81c6a6 draft (approved 24-hour workday wording + bank note) now passes the deterministic rule', () => {
  assert.strictEqual(B.refundProblem(HELD_DRAFT), null);
  for (const s of HELD_DRAFT.split(/(?<=[.!?])\s+|\n+/).filter(x => x.trim())) assert.deepStrictEqual(P.hardBlock(s), [], s);
});
test('refund: close variants of the approved sentence pass (with the bank note)', () => {
  for (const s of [
    'Refunds are issued within 24 hours of your return arriving at RF Safe on a workday.',
    'Your refund is issued within 24 hours of your return arriving at RF Safe on a workday.',
    'Refunds are issued within 24 hours of the returned case arriving at RF Safe on workdays.',
    'Refunds are issued within 24 hours after your return arrives at RF Safe on a business day.'
  ]) assert.strictEqual(B.refundProblem(s + BANK), null, s);
});
test('refund: without the bank processing note, the approved sentence is still held', () => {
  assert.ok(B.refundProblem('Hi,\n\nRefunds are issued within 24 hours of your return arriving at RF Safe on a workday.\n\nThe RF Safe team'));
});
test('refund: every other promised timeline is still held, even next to the approved wording', () => {
  for (const s of [
    'Refunds are issued within 48 hours of your return arriving at RF Safe on a workday.',
    'Refunds are issued within 24 hours.',
    'Refunds are issued within 24 hours of your return arriving at RF Safe on a workday, and it will be in your account in 3 days.',
    'Your refund will arrive within 5 business days.',
    'You will get your refund in 2 weeks.',
    'We will process your refund today.',
    'Your refund has been issued.',
    'Refunds are issued within 24 hours of your return arriving at RF Safe on a workday. Your refund will post within 3 days.'
  ]) assert.ok(B.refundProblem(s + BANK), s);
  assert.ok(B.refundProblem('You will get a full refund.' + BANK), 'amount promises still fail');
});
test('refund checker end to end: the r.da81c6a6 draft passes review; a 3-day promise fails', async () => {
  const h = harness();
  const g = await h.bots.review(h.bots.db.installed.checker, REFUND_Q, draftOf(h, REFUND_Q, HELD_DRAFT), { kb_gaps: [], store_lookup: { products: [] } });
  assert.doesNotMatch(String(g.notes || ''), /Promises a refund amount or timeline/);
  const bad = HELD_DRAFT.replace('After that,', 'Your refund will reach you within 3 days. After that,');
  const g2 = await h.bots.review(h.bots.db.installed.checker, REFUND_Q, draftOf(h, REFUND_Q, bad), { kb_gaps: [], store_lookup: { products: [] } });
  assert.strictEqual(g2.verdict, 'fail'); assert.match(g2.notes, /Promises a refund amount or timeline/);
});

// ---- 2. Warranty no_model ----------------------------------------------------------------------------------------------
const NOMODEL_Q = { id: 'r.27cdb25a-527f-49c5-8568-8a026295cb4d', from: 'pat@example.com', subject: 'Warranty for my case', text: 'Hi, I need to get a warranty done on my case.\n' };
const O1173 = [{ order_number: '#1173', status: 'processing', tracking: [], items: [{ title: 'RF Safe QuantaCase for Apple iPhone 17 Pro Max', color: 'Black', quantity: 1 }] }];
const SENT_REPLY = "Hi there,\n\nReplacement cases are always $20 plus shipping for as long as you own that phone.\n\nTo get one, reply to this email with the original order number (or the name, email and phone number used on the order) plus the phone model, and the RF Safe team will set up the $20 replacement.\n\nWe can't offer coupon codes or other discounts, but the cases are sometimes discounted, so check back during holiday sales.\n\nWhich phone model is the replacement for?\n\nThe RF Safe team\n";

test('no_model: the check lists the models on file, asks which phone, and adds the different email or phone line', () => {
  const wc = W.forEmail(NOMODEL_Q, { match: 'email', orders: O1173 });
  assert.strictEqual(wc.result, 'no_model');
  assert.strictEqual(wc.sentence, 'The cases we show as warrantable under this email are for the iPhone 17 Pro Max. Which phone is the replacement case for? ' + W.OTHER_CONTACT);
  const two = W.forEmail(NOMODEL_Q, { match: 'email', orders: [...O1173, { order_number: '#1162', items: [{ title: 'RF Safe QuantaCase for Samsung Galaxy S24' }] }] });
  assert.match(two.sentence, /^The cases we show as warrantable under this email are for the iPhone 17 Pro Max and Galaxy S24\. Which phone is the replacement case for\?/);
  const notes = SN.build({ orderFacts: { match: 'email', orders: O1173 }, warranty: wc }).text;
  assert.ok(notes.includes('Include these sentences word for word: "' + wc.sentence + '"'));
  assert.doesNotMatch(wc.sentence, /pat@example\.com/);
});
test('no_model checker rule: the sent r.27cdb25a reply (no models, no other-contact line) fails; each missing part fails; full reply passes', () => {
  const wc = W.forEmail(NOMODEL_Q, { match: 'email', orders: O1173 });
  const p = W.problem(wc, SENT_REPLY);
  assert.ok(p && p.kind === 'warranty_no_model'); assert.match(p.problem, /models on file/); assert.match(p.problem, /different email or phone line/);
  assert.strictEqual(p.edits[0].text, wc.sentence);
  const full = SENT_REPLY.replace('Which phone model is the replacement for?', wc.sentence);
  assert.strictEqual(W.problem(wc, full), null);
  // Missing the list.
  assert.match(W.problem(wc, full.replace('The cases we show as warrantable under this email are for the iPhone 17 Pro Max. ', '')).problem, /models on file/);
  // Missing the which-phone question.
  assert.match(W.problem(wc, full.replace(W.NO_MODEL_ASK + ' ', '').replace('Which phone model is the replacement for?', '')).problem, /which phone the replacement is for/);
  // Missing the other-contact line.
  assert.match(W.problem(wc, full.replace(W.OTHER_CONTACT, '')).problem, /different email or phone line/);
  // Lists a different model than the one on file.
  assert.ok(W.problem(wc, full.replace('iPhone 17 Pro Max.', 'iPhone 17 Pro.')));
});
test('no_model checker end to end: review fails the sent reply with an add edit, passes the full reply', async () => {
  const h = harness();
  const wc = W.forEmail(NOMODEL_Q, { match: 'email', orders: O1173 });
  const extra = { kb_gaps: [], store_lookup: { products: [] }, ...SN.fields(null, SN.build({ orderFacts: { match: 'email', orders: O1173 }, warranty: wc })) };
  const g = await h.bots.review(h.bots.db.installed.checker, NOMODEL_Q, draftOf(h, NOMODEL_Q, SENT_REPLY), extra);
  assert.strictEqual(g.verdict, 'fail'); assert.ok((g.edits || []).some(e => e.action === 'add' && e.text === wc.sentence), JSON.stringify(g.edits));
  const ok = SENT_REPLY.replace('Which phone model is the replacement for?', wc.sentence);
  const g2 = await h.bots.review(h.bots.db.installed.checker, NOMODEL_Q, draftOf(h, NOMODEL_Q, ok), extra);
  assert.strictEqual(g2.verdict, 'pass', g2.notes);
  for (const s of wc.sentence.split(/(?<=[.!?])\s+/)) { assert.strictEqual(B.handoffProblem(s, []), null, s); assert.deepStrictEqual(P.hardBlock(s), [], s); }
});
