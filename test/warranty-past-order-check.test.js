'use strict';
// Warranty / $20 replacement past-order model check (John, Nov 18 2026 8:38 PM ET, via Jarvis). Mock data only: no network,
// no real orders, no real email, texts or calls, no keys. Order #1173 is a mock processing (unshipped) order and stays that
// way: every Shopify call here is a read-only query, never a mutation.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const W = require('../vendor/sitemail/src/mailbox/warranty');
const SN = require('../vendor/sitemail/src/mailbox/system-notes');
const OI = require('../vendor/sitemail/src/mailbox/orderindex');
const B = require('../vendor/sitemail/src/mailbox/bots');
const P = require('../vendor/sitemail/src/mailbox/policy');
const { MailBots } = B;
const { MailboxStore } = require('../vendor/sitemail/src/mailbox/store');
const { Sealer, newKey } = require('../vendor/sitemail/src/mailbox/crypto');
const { ShopifyClient, assertReadOnlyQuery } = require('../src/shopify');
const { Tools, Approvals } = require('../src/tools');

const dirs = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-warranty-')); dirs.push(d); return d; }
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// ---- Mock orders (example.com / 555 numbers only) -------------------------------------------------------------------------
const li = (title, variantTitle = 'Black') => ({ title, variantTitle, quantity: 1 });
const ORDERS = {
  // #1173: mock processing order, iPhone 17 Pro Max, must stay unshipped.
  '1173': { id: 'gid://shopify/Order/1173', name: '#1173', updatedAt: '2026-11-16T20:00:00Z', createdAt: '2026-11-16T19:00:00Z', cancelledAt: null, displayFulfillmentStatus: 'UNFULFILLED', email: 'pat@example.com', phone: null,
    customer: { firstName: 'Pat', defaultEmailAddress: { emailAddress: 'pat@example.com' }, defaultPhoneNumber: { phoneNumber: '+17275550173' } },
    shippingAddress: { address1: '1 Mock St', city: 'Clearwater', provinceCode: 'FL', phone: null },
    lineItems: { nodes: [li('RF Safe QuantaCase™ for Apple iPhone 17 Pro Max')] }, fulfillments: [] },
  // Dana: two past orders, iPhone 15 Pro Max and Galaxy S24 (email + phone on file).
  '1150': { id: 'gid://shopify/Order/1150', name: '#1150', updatedAt: '2025-12-01T12:00:00Z', createdAt: '2025-12-01T12:00:00Z', cancelledAt: null, displayFulfillmentStatus: 'FULFILLED', email: 'dana@example.com', phone: '+18135550150',
    customer: { firstName: 'Dana', defaultEmailAddress: { emailAddress: 'dana@example.com' }, defaultPhoneNumber: { phoneNumber: '+18135550150' } },
    shippingAddress: { address1: '2 Mock Ave', city: 'Tampa', provinceCode: 'FL', phone: null },
    lineItems: { nodes: [li('RF Safe QuantaCase for Apple iPhone 15 Pro Max')] }, fulfillments: [{ displayStatus: 'DELIVERED', trackingInfo: [] }] },
  '1162': { id: 'gid://shopify/Order/1162', name: '#1162', updatedAt: '2026-03-01T12:00:00Z', createdAt: '2026-03-01T12:00:00Z', cancelledAt: null, displayFulfillmentStatus: 'FULFILLED', email: 'dana@example.com', phone: '+18135550150',
    customer: { firstName: 'Dana', defaultEmailAddress: { emailAddress: 'dana@example.com' }, defaultPhoneNumber: { phoneNumber: '+18135550150' } },
    shippingAddress: { address1: '2 Mock Ave', city: 'Tampa', provinceCode: 'FL', phone: null },
    lineItems: { nodes: [li('RF Safe QuantaCase for Samsung Galaxy S24')] }, fulfillments: [{ displayStatus: 'DELIVERED', trackingInfo: [] }] },
  // Representative earlier caller (phone only on the order, no email match): bought an iPhone 15 Pro case.
  '1120': { id: 'gid://shopify/Order/1120', name: '#1120', updatedAt: '2025-06-01T12:00:00Z', createdAt: '2025-06-01T12:00:00Z', cancelledAt: null, displayFulfillmentStatus: 'FULFILLED', email: 'caller@example.com', phone: '+17275550120',
    customer: { firstName: 'Chris', defaultEmailAddress: { emailAddress: 'caller@example.com' }, defaultPhoneNumber: { phoneNumber: '+17275550120' } },
    shippingAddress: { address1: '3 Mock Rd', city: 'Largo', provinceCode: 'FL', phone: null },
    lineItems: { nodes: [li('RF Safe QuantaCase for Apple iPhone 15 Pro')] }, fulfillments: [{ displayStatus: 'DELIVERED', trackingInfo: [] }] }
};

// Read-only fake Admin API: answers "name:NNNN" and free-text phone searches; any mutation throws.
function fakeAdmin() {
  const calls = [];
  return {
    calls,
    async query(q, vars = {}) {
      assertReadOnlyQuery(q); calls.push({ q, vars });
      const term = String(vars.q || '');
      let nodes = [];
      const m = term.match(/^name:(\d+)$/);
      if (m) nodes = ORDERS[m[1]] ? [ORDERS[m[1]]] : [];
      // Free-text search is fuzzy on purpose (returns a near-miss too); the client must verify the phone itself.
      else if (/^\d{10}$/.test(term)) nodes = Object.values(ORDERS).filter(o => JSON.stringify(o).replace(/\D/g, '').includes(term.slice(-7)));
      return { data: { orders: { nodes } } };
    }
  };
}
const statusOf = (o) => OI.statusLabel(o);

// ---- 1. Model normalization -----------------------------------------------------------------------------------------------
test('normalization: Pro vs Pro Max, S24 vs S24+ vs S24 Ultra, 16 vs 16e, Z Fold, product titles with ™', () => {
  assert.deepStrictEqual(W.modelKeys('iPhone 16 Pro'), ['iphone 16 pro']);
  assert.deepStrictEqual(W.modelKeys('iPhone 16 Pro Max'), ['iphone 16 pro max']);
  assert.deepStrictEqual(W.modelKeys('my 16 promax'), ['iphone 16 pro max']);
  assert.deepStrictEqual(W.modelKeys('Galaxy S24'), ['galaxy s24']);
  assert.deepStrictEqual(W.modelKeys('QuantaCase for Samsung Galaxy S24+'), ['galaxy s24 plus']);
  assert.deepStrictEqual(W.modelKeys('my s24+ case'), ['galaxy s24 plus']);
  assert.deepStrictEqual(W.modelKeys('Samsung Galaxy S24 Ultra'), ['galaxy s24 ultra']);
  assert.deepStrictEqual(W.modelKeys('apple-iphone-16-e'), ['iphone 16e']);
  assert.deepStrictEqual(W.modelKeys('iPhone 16'), ['iphone 16']);
  assert.deepStrictEqual(W.modelKeys('Galaxy Z Fold 6'), ['galaxy z fold 6']);
  assert.deepStrictEqual(W.modelKeys('RF Safe QuantaCase™ for Apple iPhone 17 Pro Max'), ['iphone 17 pro max']);
  assert.strictEqual(W.label('iphone 16 pro max'), 'iPhone 16 Pro Max'); assert.strictEqual(W.label('galaxy s24 plus'), 'Galaxy S24 Plus'); assert.strictEqual(W.label('pixel 9 pro xl'), 'Pixel 9 Pro XL');
  const own = [{ order_number: '#1', items: [{ title: 'QuantaCase for iPhone 16 Pro' }] }];
  assert.strictEqual(W.check({ match: 'email', orders: own, requestedText: 'replacement for my iPhone 16 Pro Max' }).result, 'mismatch');
  assert.strictEqual(W.check({ match: 'email', orders: own, requestedText: 'replacement for my iPhone 16 Pro' }).result, 'match');
  const s24 = [{ order_number: '#2', items: [{ title: 'QuantaCase for Samsung Galaxy S24' }] }];
  for (const t of ['my Galaxy S24+ case broke', 'my S24 Ultra case broke']) assert.strictEqual(W.check({ match: 'email', orders: s24, requestedText: t }).result, 'mismatch', t);
  assert.strictEqual(W.check({ match: 'email', orders: s24, requestedText: 'my Samsung Galaxy S24 case broke' }).result, 'match');
});

// ---- 2. The check itself ----------------------------------------------------------------------------------------------------
const DANA = [{ order_number: '#1150', items: [{ title: 'RF Safe QuantaCase for Apple iPhone 15 Pro Max', color: 'Black' }] }, { order_number: '#1162', items: [{ title: 'RF Safe QuantaCase for Samsung Galaxy S24', color: 'Black' }] }];
test('match: requested model is on one of their orders -> normal flow, matched order named', () => {
  const r = W.check({ match: 'email', orders: DANA, requestedText: 'My Galaxy S24 case is worn out, can I get the $20 replacement?' });
  assert.strictEqual(r.result, 'match'); assert.deepStrictEqual(r.matched_orders, ['#1162']); assert.strictEqual(r.sentence, undefined);
  assert.match(W.noteLines(r), /Result: match\. Order #1162 includes a case for the Galaxy S24\. Continue with the normal \$20 replacement answer\./);
});
test('mismatch: lists every model on their orders and asks for the order details for the requested model', () => {
  const r = W.check({ match: 'email', orders: DANA, requestedText: 'My iPhone 16 Pro case cracked. Replacement please?' });
  assert.strictEqual(r.result, 'mismatch'); assert.deepStrictEqual(r.ordered, ['iPhone 15 Pro Max', 'Galaxy S24']);
  assert.strictEqual(r.sentence, 'The only cases we show as warrantable under this email are for the iPhone 15 Pro Max and Galaxy S24. Please send the order details for your iPhone 16 Pro case so we can start the replacement. ' + W.OTHER_CONTACT);
  const three = W.check({ match: 'email', orders: [...DANA, { order_number: '#1170', items: [{ title: 'QuantaCase for Google Pixel 9' }] }], requestedText: 'replacement for my iPhone 16 Pro' });
  assert.match(three.sentence, /under this email are for the iPhone 15 Pro Max, Galaxy S24 and Pixel 9\. Please send the order details for your iPhone 16 Pro case/);
  const one = W.check({ match: 'email', orders: [DANA[0]], requestedText: 'replacement for my iPhone 16 Pro' });
  assert.strictEqual(one.sentence, 'The only cases we show as warrantable under this email are for the iPhone 15 Pro Max. Please send the order details for your iPhone 16 Pro case so we can start the replacement. ' + W.OTHER_CONTACT);
  // The sentence is not a hand-off, discount offer or hard block.
  for (const t of [r.sentence, W.noOrdersSentence({ kind: 'email' }), W.noOrdersSentence({ kind: 'phone', last4: '0150' })]) for (const sent of t.split(/(?<=[.!?])\s+/)) { assert.strictEqual(B.handoffProblem(sent, []), null, sent); assert.strictEqual(B.discountOffer(sent), null, sent); assert.deepStrictEqual(P.hardBlock(sent), [], sent); }
});
test('no orders (or only an unverified phone hit): ask for order number, or name, email and phone; no models named', () => {
  for (const match of ['none', 'phone_unverified']) {
    const r = W.check({ match, orders: [], requestedText: 'replacement for my iPhone 16 Pro' });
    assert.strictEqual(r.result, 'no_orders'); assert.deepStrictEqual(r.ordered, []);
    const n = W.noteLines(r); assert.match(n, /ask for the order number, or the name, email and phone number used on the order/); assert.doesNotMatch(n, /15 Pro Max|S24/);
    assert.strictEqual(r.sentence, "We don't show any warrantable orders under this email. " + W.OTHER_CONTACT); assert.ok(n.includes(r.sentence));
  }
  // Orders from a phone_unverified hit are never used even if a caller passes them in.
  assert.strictEqual(W.check({ match: 'phone_unverified', orders: DANA, requestedText: 'iPhone 16 Pro replacement' }).result, 'no_orders');
});
test('no model named: ask which phone; no_items: normal flow without model claims', () => {
  assert.strictEqual(W.check({ match: 'email', orders: DANA, requestedText: 'My case broke, replacement?' }).result, 'no_model');
  assert.strictEqual(W.check({ match: 'email', orders: [{ order_number: '#9', items: [] }], requestedText: 'iPhone 16 Pro replacement' }).result, 'no_items');
});
test('forEmail: only for a replacement / warranty request, only with the index on', () => {
  const facts = { match: 'email', orders: DANA };
  assert.strictEqual(W.forEmail({ subject: 'Hi', text: 'Do you have a case for the iPhone 16 Pro?' }, facts), null, 'not a replacement request');
  assert.strictEqual(W.forEmail({ subject: 'Replacement', text: 'iPhone 16 Pro replacement please' }, null), null, 'index off -> no check');
  assert.strictEqual(W.forEmail({ subject: 'Warranty', text: 'Is my iPhone 16 Pro case under warranty?' }, facts).result, 'mismatch');
  assert.strictEqual(W.forEmail({ subject: 'Re: case', text: 'My S24 case broke.\n\nOn Mon, RF Safe wrote:\n> iPhone 16 Pro' }, facts).result, 'match', 'quoted reply text is not the request');
});

// ---- 3. Mailbox: email-match vs phone-match, other customers never visible ------------------------------------------------
function index(adminQuery) {
  const api = OI.createOrderIndex({ dataDir: tmp(), sealer: new Sealer(newKey()), adminQuery, env: { SITEMAIL_ORDER_INDEX: '1' }, now: () => new Date('2026-11-18T20:00:00Z'), log: () => {} });
  for (const o of Object.values(ORDERS)) api.upsert(o);
  return api;
}
const statusQuery = (admin) => async (q, vars) => admin.query(q, vars);
test('Mailbox: sender email matches -> their own models only; a stranger typing their phone sees nothing', async () => {
  const admin = fakeAdmin(); const oi = index(statusQuery(admin));
  const dana = { from: 'Dana <dana@example.com>', subject: 'Replacement case', text: 'My iPhone 16 Pro case cracked, can I get a $20 replacement?' };
  const f = await oi.factsFor(dana); assert.strictEqual(f.match, 'email');
  const wc = W.forEmail(dana, f); assert.strictEqual(wc.result, 'mismatch'); assert.deepStrictEqual(wc.ordered, ['iPhone 15 Pro Max', 'Galaxy S24']);
  assert.doesNotMatch(JSON.stringify(wc), /17 Pro Max|15 Pro\b(?! Max)|#1173|#1120|pat@|caller@/, 'no other customer\'s orders');
  // Stranger includes Dana's phone number in the body: phone-only hit is unverified, nothing named.
  const stranger = { from: 'someone@example.net', subject: 'Replacement', text: 'Replacement for my iPhone 15 Pro Max please, my number is 813-555-0150' };
  const sf = await oi.factsFor(stranger); assert.strictEqual(sf.match, 'phone_unverified');
  const swc = W.forEmail(stranger, sf); assert.strictEqual(swc.result, 'no_orders'); assert.deepStrictEqual(swc.ordered, []);
  const notes = SN.build({ orderFacts: sf, warranty: swc });
  assert.doesNotMatch(notes.text, /#1150|#1162|Galaxy S24/); assert.match(notes.text, new RegExp(W.TITLE));
  // Unknown sender, no phone: no orders.
  const nf = await oi.factsFor({ from: 'new@example.org', subject: 'Replacement', text: 'iPhone 16 Pro case broke' });
  assert.strictEqual(W.forEmail({ subject: 'Replacement', text: 'iPhone 16 Pro case broke' }, nf).result, 'no_orders');
  assert.ok(admin.calls.every(c => !/mutation/i.test(c.q)));
});
test('System notes carry the check; SN.fields passes it to the checker', () => {
  const wc = W.check({ match: 'email', orders: DANA, requestedText: 'iPhone 16 Pro replacement' });
  const notes = SN.build({ orderFacts: { match: 'email', orders: DANA.map(o => ({ ...o, status: 'delivered', tracking: [] })) }, warranty: wc });
  assert.match(notes.text, /Replacement check against this sender's past orders\nPhone model\(s\) the customer wants a replacement case for: iPhone 16 Pro\.\nResult: no match\./);
  assert.ok(notes.text.includes('Include these sentences word for word: "' + wc.sentence + '"'));
  assert.deepStrictEqual(SN.fields(null, notes).warranty_check, wc);
  assert.strictEqual(SN.build({ orderFacts: null, warranty: null }), null, 'index off: no block at all (unchanged)');
});

// ---- 4. Checker (deterministic backstop) ----------------------------------------------------------------------------------
const MODELS = { models: [{ id: 'grok-4.7', aliases: [], prompt_text_token_price: 20000, cached_prompt_text_token_price: 5000, completion_text_token_price: 60000, output_modalities: ['text'] }] };
function passGrade() { return { verdict: 'pass', main_question: 'replacement', answers_main_question: true, questions_asked: ['q'], unanswered: [], unasked_additions: [], notes: 'ok', improvements: [] }; }
function harness({ orderIndex = null, writerBody = 'Hi there,\n\nThanks.\n\nThe RF Safe team' } = {}) {
  const dir = tmp();
  const store = new MailboxStore({ file: path.join(dir, 'mailbox.json'), sealer: new Sealer(newKey()) });
  store.setSettings({ auto_send: false, daily_cap: 20 }, 'test');
  const messages = new Map(); const captured = [];
  const fetchImpl = async (url, opt = {}) => {
    if (String(url).includes('/v1/language-models')) return { ok: true, json: async () => MODELS };
    if (String(url).includes('/chat/completions')) {
      const b = JSON.parse(opt.body); const sys = b.messages[0].content; let user = {}; try { user = JSON.parse(b.messages[1].content); } catch {}
      captured.push({ sys, user });
      const out = /Classify/.test(sys) ? { folder: 'inbox', reason: 'q' } : /Independently review/.test(sys) ? passGrade() : { needs_reply: true, reason: 'ok', body: writerBody };
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(out) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const bots = new MailBots({
    store, env: { XAI_API_KEY: 'xai-test-not-real' }, fetchImpl, orderIndex,
    tools: { state: () => ({ shopify: { connected: false } }), kbUrls: () => [], kbVersion: () => 't', entryBySlug: () => null, connectedForOrders: () => false, action: async () => ({ hits: [] }) },
    ownDomains: ['callbots.org'],
    received: async () => [...messages.values()].map(m => ({ id: m.id, created_at: m.created_at })),
    original: async (id) => messages.get(id) || null,
    createDraft: async (who, b) => { const orig = messages.get(b.reply_to_id) || {}; const d = store.createDraft({ author: who, reply_to_id: b.reply_to_id, to: orig.from, subject: 'Re: ' + (orig.subject || ''), body: b.body, reason: b.reason }); return { code: 201, body: { draft: { id: d.id } } }; },
    autoSend: async () => ({ auto: false, reason: 'auto_send_off' })
  });
  bots.db.cap = 100;
  for (const id of ['sorter', 'replier', 'checker']) bots.toggle(id, true);
  for (const r of Object.values(bots.db.installed)) if (r.enabled) r.enabled_at = 0;
  return { bots, messages, captured, store };
}
const REPL = B.REPLACEMENT_ANSWER;
test('checker: mismatch draft without the model sentence fails with an add edit; with it, passes', async () => {
  const h = harness();
  const orig = { id: 'r.mock-dana', from: 'dana@example.com', subject: 'Replacement case', text: 'My iPhone 16 Pro case cracked. Can I get a replacement?' };
  const wc = W.check({ match: 'email', orders: DANA, requestedText: orig.subject + '\n' + orig.text });
  const extra = { kb_gaps: [], store_lookup: { products: [] }, ...SN.fields(null, SN.build({ orderFacts: { match: 'email', orders: DANA }, warranty: wc })) };
  const bad = h.store.createDraft({ author: 'bot:replier', reply_to_id: orig.id, to: orig.from, subject: 'Re: x', body: 'Hi Dana,\n\n' + REPL + '\n\nThe RF Safe team' });
  const g = await h.bots.review(h.bots.db.installed.checker, orig, bad, extra);
  assert.strictEqual(g.verdict, 'fail'); assert.match(g.notes, /only cases under this email are for the iPhone 15 Pro Max and Galaxy S24/);
  assert.ok((g.edits || []).some(e => e.action === 'add' && e.text === wc.sentence), JSON.stringify(g.edits));
  const good = h.store.createDraft({ author: 'bot:replier', reply_to_id: orig.id, to: orig.from, subject: 'Re: x', body: 'Hi Dana,\n\n' + REPL + ' ' + wc.sentence + '\n\nThe RF Safe team' });
  const g2 = await h.bots.review(h.bots.db.installed.checker, orig, good, extra);
  assert.strictEqual(g2.verdict, 'pass', g2.notes);
});
test('checker: match draft with the normal replacement answer passes (normal flow unchanged)', async () => {
  const h = harness();
  const orig = { id: 'r.mock-dana2', from: 'dana@example.com', subject: 'Replacement case', text: 'My Galaxy S24 case is worn out. Replacement?' };
  const wc = W.check({ match: 'email', orders: DANA, requestedText: orig.subject + '\n' + orig.text });
  const d = h.store.createDraft({ author: 'bot:replier', reply_to_id: orig.id, to: orig.from, subject: 'Re: x', body: 'Hi Dana,\n\n' + REPL + '\n\nThe RF Safe team' });
  const g = await h.bots.review(h.bots.db.installed.checker, orig, d, { kb_gaps: [], store_lookup: { products: [] }, ...SN.fields(null, SN.build({ orderFacts: { match: 'email', orders: DANA }, warranty: wc })) });
  assert.strictEqual(g.verdict, 'pass', g.notes);
});
test('checker: no orders -> draft must ask for order number, or name, email and phone', async () => {
  const h = harness();
  const orig = { id: 'r.mock-new', from: 'new@example.org', subject: 'Warranty', text: 'Is my iPhone 16 Pro case under warranty? It cracked.' };
  const wc = W.check({ match: 'none', orders: [], requestedText: orig.text });
  const extra = { kb_gaps: [], store_lookup: { products: [] }, ...SN.fields(null, SN.build({ orderFacts: { match: 'none', orders: [] }, warranty: wc })) };
  const bad = h.store.createDraft({ author: 'bot:replier', reply_to_id: orig.id, to: orig.from, subject: 'Re: x', body: 'Hi there,\n\nReplacement cases are always $20 plus shipping for as long as you own that phone.\n\nThe RF Safe team' });
  const g = await h.bots.review(h.bots.db.installed.checker, orig, bad, extra);
  assert.strictEqual(g.verdict, 'fail'); assert.ok((g.edits || []).some(e => e.text === W.NO_ORDERS_ASK)); assert.ok((g.edits || []).some(e => e.text === wc.sentence));
  const noLine = h.store.createDraft({ author: 'bot:replier', reply_to_id: orig.id, to: orig.from, subject: 'Re: x', body: 'Hi there,\n\n' + REPL + '\n\nThe RF Safe team' });
  const g1 = await h.bots.review(h.bots.db.installed.checker, orig, noLine, extra);
  assert.strictEqual(g1.verdict, 'fail', 'the ask alone is not enough: the no-warrantable-orders + other email/phone line is required'); assert.ok((g1.edits || []).some(e => e.text === wc.sentence));
  const good = h.store.createDraft({ author: 'bot:replier', reply_to_id: orig.id, to: orig.from, subject: 'Re: x', body: 'Hi there,\n\n' + wc.sentence + ' ' + REPL + '\n\nThe RF Safe team' });
  assert.strictEqual((await h.bots.review(h.bots.db.installed.checker, orig, good, extra)).verdict, 'pass');
});
test('Mailbox pipeline: writer and checker get the replacement check in System notes (index on); nothing with the index off', async () => {
  const admin = fakeAdmin(); const oi = index(statusQuery(admin));
  const m = { id: 'r.mock-pipeline', subject: 'Replacement case', text: 'Hi, my iPhone 16 Pro case cracked. Can I get the $20 replacement?', from: 'Dana <dana@example.com>', created_at: new Date().toISOString(), folder: 'inbox' };
  const on = harness({ orderIndex: oi }); on.messages.set(m.id, m); on.store.putCopy(m.id, m);
  await on.bots.wake('owner');
  for (let i = 0; i < 20; i++) { if (on.bots.pending) await on.bots.pending; await new Promise(r => setTimeout(r, 30)); if (!on.bots.running && !on.bots.again) break; }
  const writer = on.captured.find(c => c.user && c.user.message && !/Independently review/.test(c.sys) && !/Classify/.test(c.sys));
  assert.ok(writer && writer.user.system_notes, 'writer got system notes');
  assert.match(writer.user.system_notes, /Replacement check against this sender's past orders/);
  assert.ok(writer.user.system_notes.includes('The only cases we show as warrantable under this email are for the iPhone 15 Pro Max and Galaxy S24. Please send the order details for your iPhone 16 Pro case so we can start the replacement. ' + W.OTHER_CONTACT));
  assert.doesNotMatch(writer.user.system_notes.split('Replacement check')[1], /dana@example\.com|8135550150|813-555-0150/, 'no identifier echoed in the warranty section');
  assert.doesNotMatch(writer.user.system_notes, /#1173|#1120|17 Pro Max/);
  const checker = on.captured.find(c => /Independently review/.test(c.sys));
  assert.ok(checker, 'checker ran'); assert.match(String(checker.user.system_notes || ''), /Replacement check against this sender's past orders/);
  // Index off: no orders block and no replacement check.
  const off = harness({ orderIndex: null }); off.messages.set(m.id, m); off.store.putCopy(m.id, m);
  await off.bots.wake('owner');
  for (let i = 0; i < 20; i++) { if (off.bots.pending) await off.bots.pending; await new Promise(r => setTimeout(r, 30)); if (!off.bots.running && !off.bots.again) break; }
  assert.ok(off.captured.length && off.captured.every(c => !/Replacement check/.test(String((c.user && c.user.system_notes) || ''))));
  assert.ok(admin.calls.every(c => !/mutation/i.test(c.q)));
});

// ---- 5. Phone and text: warranty_check tool (only when order_lookup_enabled is on) -----------------------------------------
function tools(over = {}, admin = fakeAdmin()) {
  const shop = new ShopifyClient({ shop: 'quantacase.com', mode: 'public', admin, fetchImpl: async () => ({ ok: false }) });
  const logs = [];
  const t = new Tools({ id: 'r', name: 'R', numbers: [], link_allowlist: ['quantacase.com'], shopify: { shop: 'quantacase.com', mode: 'public' }, order_lookup_enabled: true, ...over }, { kbFor: () => null, shopifyFor: () => shop, approvals: new Approvals(), log: (e, d) => logs.push([e, d]) });
  return { t, admin, logs };
}
test('phone/text: warranty_check exists only when order_lookup_enabled is on (it is off in production and stays off)', async () => {
  const off = tools({ order_lookup_enabled: false }).t;
  assert.ok(!off.definitions().some(d => d.name === 'warranty_check'));
  assert.strictEqual((await off.run('warranty_check', { phone_model: 'iPhone 16 Pro' }, { channel: 'voice', callId: 'c', caller: '+18135550150' })).error, 'unknown_tool');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'tenants.js'), 'utf8'), /order_lookup_enabled: false,/, 'tenant default stays off');
  assert.ok(tools().t.definitions().some(d => d.name === 'warranty_check' && d.parameters.required.includes('phone_model')));
  const { buildSmsInstructions } = require('../src/sms');
  assert.doesNotMatch(buildSmsInstructions({ id: 'r', name: 'R', link_allowlist: ['quantacase.com'], order_lookup_enabled: false }), /warranty_check/);
  assert.match(buildSmsInstructions({ id: 'r', name: 'R', link_allowlist: ['quantacase.com'], order_lookup_enabled: true }), /warranty_check/);
});
test('phone: caller ID matches -> match / mismatch from that caller\'s own orders only', async () => {
  const { t, admin } = tools();
  const ctx = { channel: 'voice', callId: 'c1', caller: '+1 813-555-0150' };
  const m = await t.run('warranty_check', { phone_model: 'Galaxy S24' }, ctx);
  assert.strictEqual(m.result, 'match'); assert.deepStrictEqual(m.matched_orders, ['#1162']);
  const mm = await t.run('warranty_check', { phone_model: 'iPhone 16 Pro' }, ctx);
  assert.strictEqual(mm.result, 'mismatch'); assert.deepStrictEqual(mm.ordered_models, ['iPhone 15 Pro Max', 'Galaxy S24']);
  assert.ok(mm.say.includes('The only cases we show as warrantable under this phone number ending in 0150 are for the iPhone 15 Pro Max and Galaxy S24. Please send the order details for your iPhone 16 Pro case so we can start the replacement. ' + W.OTHER_CONTACT), mm.say);
  const s = JSON.stringify([m, mm]);
  for (const bad of ['Mock Ave', 'Tampa', 'dana@', '555-0150', '8135550150', '#1173', '#1120', 'price']) assert.ok(!s.includes(bad), bad);
  assert.ok(admin.calls.every(c => !/mutation/i.test(c.q)));
});
test('phone: a different caller never sees someone else\'s orders (fuzzy search near-miss is verified away)', async () => {
  const { t } = tools();
  // 813-555-0150 is Dana; 999-555-0150 shares the last 7 digits, so the fake free-text search returns Dana's orders too.
  const r = await t.run('warranty_check', { phone_model: 'Galaxy S24' }, { channel: 'voice', callId: 'c2', caller: '+19995550150' });
  assert.strictEqual(r.result, 'no_orders'); assert.deepStrictEqual(r.ordered_models, []);
  assert.match(r.say, /order number, or the name, email and phone number used on the order/);
  assert.ok(r.say.includes("We don't show any warrantable orders under this phone number ending in 0150. " + W.OTHER_CONTACT), r.say);
  assert.doesNotMatch(r.say, /9995550150|999-555|\+1999/, 'never the full number');
  // A spoken email with no order number is never enough to list orders.
  const e = await t.run('warranty_check', { phone_model: 'Galaxy S24', email: 'dana@example.com' }, { channel: 'voice', callId: 'c3', caller: '+19995550111' });
  assert.strictEqual(e.result, 'no_orders');
});
test('phone/text: order number + matching email (email match) works; wrong email does not; SMS sender number counts as caller', async () => {
  const { t } = tools();
  const ok = await t.run('warranty_check', { phone_model: 'iPhone 15 Pro Max', order_number: '1150', email: 'Dana@Example.com' }, { channel: 'voice', callId: 'c4', caller: '+19995550111' });
  assert.strictEqual(ok.result, 'match'); assert.deepStrictEqual(ok.matched_orders, ['#1150']);
  const bad = await t.run('warranty_check', { phone_model: 'iPhone 15 Pro Max', order_number: '1150', email: 'other@example.com' }, { channel: 'voice', callId: 'c5', caller: '+19995550111' });
  assert.strictEqual(bad.result, 'no_orders');
  const sms = await t.run('warranty_check', { phone_model: 'iPhone 15 Pro Max' }, { channel: 'sms', caller: '+18135550150' });
  assert.strictEqual(sms.result, 'match');
});
test('order #1173 (mock, processing): match for the 17 Pro Max, mismatch for the 17 Pro; never written to, stays unshipped', async () => {
  const admin = fakeAdmin(); const { t } = tools({}, admin);
  const before = JSON.stringify(ORDERS['1173']);
  const ctx = { channel: 'voice', callId: 'c1173', caller: '+17275550173' };
  const a = await t.run('warranty_check', { phone_model: 'iPhone 17 Pro Max' }, ctx);
  assert.strictEqual(a.result, 'match'); assert.deepStrictEqual(a.matched_orders, ['#1173']);
  const b = await t.run('warranty_check', { phone_model: 'iPhone 17 Pro' }, ctx);
  assert.strictEqual(b.result, 'mismatch');
  assert.match(b.say, /The only cases we show as warrantable under this phone number ending in 0173 are for the iPhone 17 Pro Max\. Please send the order details for your iPhone 17 Pro case/);
  const c = await t.run('warranty_check', { phone_model: 'iPhone 17 Pro Max', order_number: '#1173', email: 'pat@example.com' }, { channel: 'voice', callId: 'c1173b', caller: '+19995550111' });
  assert.strictEqual(c.result, 'match');
  // Mailbox side for #1173 by email.
  const oi = index(statusQuery(admin));
  const f = await oi.factsFor({ from: 'pat@example.com', subject: 'Replacement', text: 'replacement for my iPhone 17 Pro' });
  assert.strictEqual(f.orders[0].status, 'processing');
  assert.strictEqual(W.forEmail({ subject: 'Replacement', text: 'replacement for my iPhone 17 Pro' }, f).result, 'mismatch');
  assert.strictEqual(JSON.stringify(ORDERS['1173']), before); assert.strictEqual(statusOf(ORDERS['1173']), 'processing');
  assert.ok(admin.calls.length > 0 && admin.calls.every(x => !/mutation/i.test(x.q)), 'read-only queries only');
  await assert.rejects(admin.query('mutation { orderClose(input:{id:"gid://shopify/Order/1173"}){ order{ id } } }', {}), /read-only/);
});
test('earlier caller case (REPRESENTATIVE fixture; no concrete transcript found): caller bought an iPhone 15 Pro case, asks for a 15 Pro Max replacement', async () => {
  // A caller asked for the $20 replacement for a phone model that was not the model on their past order. The repo, call-log
  // fixtures and the edge-test seed had no concrete record of that call, so this is a representative mock: caller ID matches
  // order #1120 (iPhone 15 Pro), and they ask about an iPhone 15 Pro Max.
  const { t } = tools();
  const r = await t.run('warranty_check', { phone_model: 'iPhone 15 Pro Max' }, { channel: 'voice', callId: 'c-early', caller: '+17275550120' });
  assert.strictEqual(r.result, 'mismatch'); assert.deepStrictEqual(r.ordered_models, ['iPhone 15 Pro']);
  assert.match(r.say, /The only cases we show as warrantable under this phone number ending in 0120 are for the iPhone 15 Pro\. Please send the order details for your iPhone 15 Pro Max case so we can start the replacement\./);
  const ok = await t.run('warranty_check', { phone_model: 'iPhone 15 Pro' }, { channel: 'voice', callId: 'c-early', caller: '+17275550120' });
  assert.strictEqual(ok.result, 'match');
});
test('phone: lookup not connected -> normal replacement steps, no model claims', async () => {
  const t = new Tools({ id: 'r', name: 'R', numbers: [], link_allowlist: ['quantacase.com'], shopify: { shop: 'quantacase.com', mode: 'public' }, order_lookup_enabled: true }, { kbFor: () => null, shopifyFor: () => new ShopifyClient({ shop: 'quantacase.com' }), approvals: new Approvals(), log: () => {} });
  const r = await t.run('warranty_check', { phone_model: 'iPhone 16 Pro' }, { channel: 'voice', callId: 'x', caller: '+18135550150' });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.error, 'order_lookup_not_connected'); assert.match(r.say, /normal \$20 replacement steps/);
});
test('edge-test seed email r.35d09429 (Galaxy S24 replacement, read-only seed text): match for an S24 order, mismatch for an S24 Ultra order', () => {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seeds', 'edge-tests', 'callbots.org.json'), 'utf8')).find(t => t.id === 'r.35d09429-1d6c-47cd-ba0d-779080b53924');
  assert.ok(seed, 'seed present');
  const orig = { subject: seed.subject, text: seed.question };
  assert.strictEqual(W.forEmail(orig, { match: 'email', orders: [DANA[1]] }).result, 'match');
  const ultra = W.forEmail(orig, { match: 'email', orders: [{ order_number: '#1101', items: [{ title: 'RF Safe QuantaCase for Samsung Galaxy S24 Ultra' }] }] });
  assert.strictEqual(ultra.result, 'mismatch');
  assert.strictEqual(ultra.sentence, 'The only cases we show as warrantable under this email are for the Galaxy S24 Ultra. Please send the order details for your Galaxy S24 case so we can start the replacement. ' + W.OTHER_CONTACT);
});

test('John 8:48 PM wording across channels: names the identifier (email / phone last 4 / order number), lists models, other-contact line; never a full number or address', async () => {
  const { t } = tools();
  const sm = await t.run('warranty_check', { phone_model: 'Pixel 9' }, { channel: 'sms', caller: '+18135550150' });
  assert.strictEqual(sm.result, 'mismatch');
  assert.ok(sm.say.includes('The only cases we show as warrantable under this phone number ending in 0150 are for the iPhone 15 Pro Max and Galaxy S24.'), sm.say);
  assert.ok(sm.say.includes(W.OTHER_CONTACT));
  const sn = await t.run('warranty_check', { phone_model: 'Pixel 9' }, { channel: 'sms', caller: '+16465550999' });
  assert.strictEqual(sn.result, 'no_orders'); assert.ok(sn.say.includes("We don't show any warrantable orders under this phone number ending in 0999. " + W.OTHER_CONTACT), sn.say);
  const vn = await t.run('warranty_check', { phone_model: 'Pixel 9' }, { channel: 'voice', callId: 'c-vn', caller: '+16465550999' });
  assert.strictEqual(vn.result, 'no_orders'); assert.ok(vn.say.includes(W.OTHER_CONTACT));
  const om = await t.run('warranty_check', { phone_model: 'Galaxy S24', order_number: '1150', email: 'dana@example.com' }, { channel: 'voice', callId: 'c-om', caller: '+19995550111' });
  assert.strictEqual(om.result, 'mismatch'); assert.match(om.say, /under that order number are for the iPhone 15 Pro Max\./);
  assert.strictEqual(W.noOrdersSentence({ kind: 'phone', last4: W.last4('') }), "We don't show any warrantable orders under this phone number. " + W.OTHER_CONTACT);
  for (const r of [sm, sn, vn, om]) { const j = JSON.stringify(r); for (const bad of ['8135550150', '813-555', '6465550999', '646-555', 'dana@', '9995550111', 'Mock Ave']) assert.ok(!j.includes(bad), bad); }
  const mis = W.forEmail({ subject: 'Replacement', text: 'Replacement for my Pixel 9 please' }, { match: 'email', orders: DANA });
  const none = W.forEmail({ subject: 'Replacement', text: 'Replacement for my Pixel 9 please' }, { match: 'none', orders: [] });
  const nm = SN.build({ orderFacts: { match: 'email', orders: DANA }, warranty: mis }).text; const nn = SN.build({ orderFacts: { match: 'none', orders: [] }, warranty: none }).text;
  assert.ok(nm.includes('The only cases we show as warrantable under this email are for the iPhone 15 Pro Max and Galaxy S24.') && nm.includes(W.OTHER_CONTACT));
  assert.ok(nn.includes("We don't show any warrantable orders under this email. " + W.OTHER_CONTACT));
});
