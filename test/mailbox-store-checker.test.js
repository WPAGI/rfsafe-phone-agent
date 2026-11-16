'use strict';
// Store lookup + checker fixes (John, Nov 16 3:35–3:37 AM ET). Mocks only: no network, no real email, no real keys.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const B = require('../vendor/sitemail/src/mailbox/bots');
const { MailBots } = B;
const { MailboxStore } = require('../vendor/sitemail/src/mailbox/store');
const { Sealer, newKey } = require('../vendor/sitemail/src/mailbox/crypto');

const TURQ_ID = '55171787817239';
const TURQ = {
  title: 'RF Safe QuantaCase for Apple iPhone 17 Pro Max',
  url: 'https://quantacase.com/products/apple-iphone-17-pro-max?variant=' + TURQ_ID,
  handle: 'apple-iphone-17-pro-max',
  price: { amount: '69.00', currency: 'USD' },
  variants: [
    { id: '52347000000001', title: 'Black', price: '69.00', available: true },
    { id: '52347000000002', title: 'Brown', price: '69.00', available: true },
    { id: TURQ_ID, title: 'Turquoise', price: '69.00', available: true }
  ]
};
const P16 = { title: 'RF Safe QuantaCase for Apple iPhone 16 Pro', url: 'https://quantacase.com/products/apple-iphone-16-pro', handle: 'apple-iphone-16-pro', price: { amount: '69.00', currency: 'USD' }, variants: [{ id: '1', title: 'Black', price: '69.00', available: true }] };
const P17JS = { handle: 'apple-iphone-17-pro-max', title: 'RF Safe QuantaCase for Apple iPhone 17 Pro Max', options: [{ name: 'Color', values: ['Black', 'Brown', 'Turquoise'] }], variants: [{ id: 2, title: 'Black', option1: 'Black', available: true, price: 6900 }, { id: 3, title: 'Brown', option1: 'Brown', available: true, price: 6900 }, { id: 4, title: 'Turquoise', option1: 'Turquoise', available: true, price: 6900 }] };
const MAGSAFE_LIGHT = { title: 'QuantaCase: Is the QuantaCase MagSafe compatible, and does it work with wireless charging?', text: 'The QuantaCase is not MagSafe compatible. As a design preference, RF Safe chose not to add metal plates or magnets to the back of the case. It does not interfere with wireless charging.', layer: 'light', source: null };
const KAREN = { id: 'r.karen-test', subject: 'Two cases before Christmas, MagSafe question', text: "Hi, I need one case for my iPhone 16 Pro and one for my wife's 17 Pro Max. What colors and price for the 17 Pro Max, and is it in stock? Also, does it work with MagSafe?" };
const MODELS = { models: [
  { id: 'grok-4.7', aliases: [], prompt_text_token_price: 20000, cached_prompt_text_token_price: 5000, completion_text_token_price: 60000, output_modalities: ['text'] },
  { id: 'grok-4.20-0309-non-reasoning', aliases: [], prompt_text_token_price: 12500, cached_prompt_text_token_price: 2000, completion_text_token_price: 25000, output_modalities: ['text'] }
] };

function passGrade(notes) {
  return { verdict: 'pass', main_question: 'customer question', answers_main_question: true, questions_asked: ['q'], unanswered: [], unasked_additions: [], notes: notes || 'ok', improvements: [] };
}

function harness(script, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-storefix-'));
  const store = new MailboxStore({ file: path.join(dir, 'mailbox.json'), sealer: new Sealer(newKey()) });
  store.setSettings({ auto_send: true, daily_cap: 20 }, 'test');
  const messages = new Map();
  const sent = [];
  const tools = {
    state: () => ({ shopify: { connected: true } }),
    kbUrls: () => [],
    kbVersion: () => 'test',
    entryBySlug: () => null,
    connectedForOrders: () => false,
    action: async (bot, tool, name, b) => {
      if (tool === 'shopify' && name === 'product_link') return { products: [TURQ] };
      return { hits: [] };
    }
  };
  const fetchImpl = async (url, opt = {}) => {
    const u = String(url);
    if (u.includes('/v1/language-models')) return { ok: true, status: 200, json: async () => MODELS };
    if (u.includes('/chat/completions')) {
      const b = JSON.parse(opt.body);
      const sys = b.messages[0].content;
      let user = {}; try { user = JSON.parse(b.messages[1].content); } catch { user = {}; }
      const out = script({ sys, user });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(out) } }], usage: { prompt_tokens: 40, completion_tokens: 40 } }) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  const bots = new MailBots({
    store, env: { XAI_API_KEY: 'xai-test-not-real' }, fetchImpl, tools,
    ownDomains: ['callbots.org'],
    received: async () => [...messages.values()].map(m => ({ id: m.id, created_at: m.created_at })),
    original: async (id) => messages.get(id) || null,
    productSearch: extra.productSearch || null,
    hostOrderQuery: extra.hostOrderQuery || null,
    createDraft: async (who, b) => {
      const orig = messages.get(b.reply_to_id) || {};
      const d = store.createDraft({ author: who, reply_to_id: b.reply_to_id, to: orig.from, subject: 'Re: ' + (orig.subject || ''), body: b.body, reason: b.reason });
      return { code: 201, body: { draft: { id: d.id } } };
    },
    autoSend: async (d) => {
      const rec = store.addSent({ to: d.to, from: 'info@callbots.org', subject: d.subject, body: d.body, approved_by: 'auto', reply_to_id: d.reply_to_id });
      store.updateDraft(d.id, {}, 'sent'); store.noteAutoSent();
      sent.push({ ...d, sent_id: rec.id });
      return { auto: true, sent_id: rec.id, resend_id: 're_test' };
    }
  });
  bots.db.cap = 100;
  for (const id of ['sorter', 'replier', 'checker']) bots.toggle(id, true);
  for (const r of Object.values(bots.db.installed)) if (r.enabled) r.enabled_at = 0;
  function arrive({ id, subject, text, from }) {
    const m = { id, subject, text, from: from || 'Pat Sample <pat@sample.example>', created_at: new Date().toISOString(), folder: 'inbox' };
    messages.set(id, m); store.putCopy(id, m);
  }
  async function run() {
    await bots.wake('owner');
    for (let i = 0; i < 12; i++) {
      if (bots.pending) await bots.pending;
      await new Promise(r => setTimeout(r, 60));
      if (bots.pending) await bots.pending;
      if (!bots.running && !bots.again) break;
    }
  }
  const steps = (id) => bots.timeline(id).map(x => x.step + ':' + x.status);
  return { bots, store, sent, arrive, run, steps, dir };
}

test('Karen: every model in a two-model email is looked up; "wife\'s 17 Pro Max" is an iPhone, not a Galaxy S17', () => {
  assert.deepStrictEqual(B.extractPhoneModels(KAREN.subject, KAREN.text), ['iPhone 16 Pro', 'iPhone 17 Pro Max']);
  assert.deepStrictEqual(B.handleGuesses('iPhone 17 Pro Max'), ['apple-iphone-17-pro-max', 'iphone-17-pro-max']);
});

test('Karen: a store search that misses the 17 Pro Max is backed by the public product page; a miss is never "we do not carry"', async () => {
  const h = harness(() => passGrade());
  const queries = [];
  h.bots.tools.action = async (bot, tool, name, b) => { if (tool === 'shopify') { queries.push(b.query); return { products: [P16] }; } return { hits: [] }; };
  h.bots.fetch = async (u) => String(u).endsWith('/products/apple-iphone-17-pro-max.js') ? { ok: true, status: 200, json: async () => P17JS } : { ok: false, status: 404, json: async () => ({}) };
  const sl = await h.bots.storeLookupAll(h.bots.db.installed.replier, KAREN, []);
  assert.deepStrictEqual(queries, ['iPhone 16 Pro', 'iPhone 17 Pro Max']);
  assert.deepStrictEqual(sl.products.map(p => p.handle), ['apple-iphone-16-pro', 'apple-iphone-17-pro-max']);
  assert.ok(!sl.verified_missing);
  const marked = B.markMissingPhone(sl, KAREN.subject + '\n' + KAREN.text);
  assert.doesNotMatch(marked.note || '', /do not carry/i);
  h.bots.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const sl2 = await h.bots.storeLookupAll(h.bots.db.installed.replier, KAREN, []);
  assert.deepStrictEqual(sl2.verified_missing, ['iphone 17 pro max']);
  assert.match(B.markMissingPhone(sl2, KAREN.text).note, /no case for: iphone 17 pro max/);
  h.bots.tools.action = async () => { throw new Error('store down'); };
  const sl3 = await h.bots.storeLookupAll(h.bots.db.installed.replier, KAREN, []);
  assert.strictEqual(sl3, null);
  const m3 = B.markMissingPhone({ products: [P16], note: '' }, KAREN.text);
  assert.match(m3.note, /never say we do not carry it/); assert.doesNotMatch(m3.note, /Say plainly that we do not carry/);
});

test('Karen: the checker fails "We do not carry a case for the iPhone 17 Pro Max" when the store has it, with the facts as an edit', async () => {
  const h = harness(({ sys }) => /Independently review/.test(sys) ? passGrade('looks fine') : { folder: 'inbox' });
  h.bots.tools.action = async () => ({ hits: [] });
  const draft = h.store.createDraft({ author: 'bot:replier', reply_to_id: KAREN.id, to: 'k@sample.example', subject: 'Re: cases', body: 'Hi there,\n\nThe iPhone 16 Pro case is $69: https://quantacase.com/products/apple-iphone-16-pro\n\nWe do not carry a case for the iPhone 17 Pro Max.\n\nThe RF Safe team' });
  const g = await h.bots.review(h.bots.db.installed.checker, KAREN, draft, { store_lookup: { products: [P16, TURQ] }, kb_gaps: [] });
  assert.strictEqual(g.verdict, 'fail', g.notes);
  assert.match(g.notes, /do not carry the iphone 17 pro max/i);
  const e = (g.edits || []).find(x => /do not carry/i.test(x.text));
  assert.ok(e, JSON.stringify(g.edits)); assert.match(e.fact, /apple-iphone-17-pro-max/); assert.match(e.fact, /Turquoise/); assert.match(e.fact, /\$69/);
  const g2 = await h.bots.review(h.bots.db.installed.checker, KAREN, draft, { store_lookup: { products: [P16], verified_missing: ['iphone 17 pro max'] }, kb_gaps: [] });
  assert.strictEqual(g2.verdict, 'pass', g2.notes);
});

test('Mike/Karen: a "team will follow up" deferral fails when KB Light answers the logged gap; it passes when nothing does', async () => {
  const h = harness(({ sys }) => /Independently review/.test(sys) ? passGrade('ok') : { folder: 'inbox' });
  let hits = [MAGSAFE_LIGHT];
  h.bots.tools.action = async (bot, tool) => (tool === 'kb' ? { hits } : { products: [] });
  const orig = { id: 'r.mike-test', subject: 'MagSafe', text: 'Does the case work with MagSafe and wireless charging?' };
  const draft = h.store.createDraft({ author: 'bot:replier', reply_to_id: orig.id, to: 'm@sample.example', subject: 'Re: MagSafe', body: 'Hi there,\n\nGreat question. The RF Safe team will follow up with you about MagSafe and wireless charging.\n\nThe RF Safe team' });
  const g = await h.bots.review(h.bots.db.installed.checker, orig, draft, { kb_gaps: ['Does the case work with MagSafe and wireless charging?'] });
  assert.strictEqual(g.verdict, 'fail', g.notes); assert.match(g.notes, /Defers to the team/);
  const add = (g.edits || []).find(x => x.action === 'add'); assert.ok(add); assert.match(add.text, /not MagSafe compatible/); assert.match(add.source, /MagSafe/);
  hits = [{ title: 'Unrelated', text: 'Brain tumors in rats exposed to 900 MHz.', layer: 'full' }];
  const g2 = await h.bots.review(h.bots.db.installed.checker, orig, draft, { kb_gaps: ['Does the case work with MagSafe and wireless charging?'] });
  assert.strictEqual(g2.verdict, 'pass', g2.notes);
});

test('checker/store lookup uses the phone productSearch path first, not mailbox Shopify', async () => {
  const queries = [];
  const h = harness(() => passGrade(), {
    productSearch: async (q) => {
      queries.push(q);
      if (/17/.test(q)) return [{ title: TURQ.title, url: 'https://quantacase.com/products/apple-iphone-17-pro-max', handle: 'apple-iphone-17-pro-max', price: '69.00', currency: 'USD', variants: TURQ.variants }];
      return [{ title: P16.title, url: P16.url, handle: P16.handle, price: '69.00', currency: 'USD', variants: P16.variants }];
    }
  });
  let mailboxUsed = false;
  h.bots.tools.action = async () => { mailboxUsed = true; throw new Error('mailbox shopify should not be used when the phone path is present'); };
  const sl = await h.bots.storeLookupAll(h.bots.db.installed.replier, KAREN, []);
  assert.strictEqual(mailboxUsed, false);
  assert.deepStrictEqual(queries, ['iPhone 16 Pro', 'iPhone 17 Pro Max']);
  assert.strictEqual(sl.source, 'phone_product_search');
  assert.deepStrictEqual(sl.products.map(p => p.handle), ['apple-iphone-16-pro', 'apple-iphone-17-pro-max']);
  assert.strictEqual(sl.products[1].price.amount, '69.00');
});

test('Karen pipeline: the "do not carry" draft goes through the revise loop and is sent only after the fix', async () => {
  const bad = 'Hi there,\n\nThe iPhone 16 Pro case is $69.\n\nWe do not carry a case for the iPhone 17 Pro Max.\n\nThe RF Safe team';
  const h = harness(({ sys, user }) => {
    if (/Classify/.test(sys)) return { folder: 'inbox', reason: 'customer question' };
    if (/Independently review/.test(sys)) return passGrade('model says fine');
    if (user.revise) { let b = user.previous_draft.body; for (const e of user.edits || []) if (e.action === 'change') b = b.replace(e.text, 'The iPhone 17 Pro Max case is $69 in Black, Brown and Turquoise: https://quantacase.com/products/apple-iphone-17-pro-max'); return { needs_reply: true, reason: 'fixed', body: b }; }
    return { needs_reply: true, reason: 'first', body: bad };
  });
  h.bots.tools.action = async (bot, tool, name, b) => (tool === 'shopify' ? { products: /17/.test(b.query) ? [TURQ] : [P16] } : { hits: [] });
  h.arrive({ id: KAREN.id, subject: KAREN.subject, text: KAREN.text });
  await h.run();
  const s = h.steps(KAREN.id);
  assert.ok(s.includes('check:revise_requested'), s.join(' | '));
  assert.ok(s.includes('reply:revised'), s.join(' | '));
  for (const m of h.sent) assert.doesNotMatch(m.body, /do not carry/i);
});

const SAM = { id: 'r.sam-magsafe-test', subject: 'MagSafe wallet with the QuantaCase?', text: 'Hi, I have an iPhone 17 Pro Max. Does the QuantaCase work with a MagSafe wallet, and can I charge it on a wireless pad?' };
const SAM_MAGSAFE_ONLY = 'Hi Sam,\n\nNo, the QuantaCase is not MagSafe compatible, so it will not work with a MagSafe wallet. As a design preference, RF Safe chose not to add metal plates or magnets to the back of the case.\n\nIt does not interfere with wireless charging, so it will work with a wireless charging pad.\n\nThe RF Safe team';
const DAVE = { id: 'r.dave-two-model-test', subject: 'Cases for my wife and me', text: 'Hi, I need a case for my iPhone 17 Pro Max and one for my wife\'s iPhone 16 Pro. What colors, price, and stock for each, and how long to ship to Oregon?' };
const DAVE_OK = 'Hi Dave,\n\nFor the iPhone 17 Pro Max, Black, Brown, and Turquoise are in stock at $69 each.\nhttps://quantacase.com/products/apple-iphone-17-pro-max\n\nFor the iPhone 16 Pro, Black is in stock at $69.\nhttps://quantacase.com/products/apple-iphone-16-pro\n\nOrders ship by USPS from Seminole, Florida. Most arrive in about 4 to 6 business days on the West Coast.\n\nThe RF Safe team';

test('Sam: a MagSafe KB Light answer that skips the named iPhone 17 Pro Max product fails; the edit supplies colors, price, stock and the link', async () => {
  const h = harness(({ sys }) => /Independently review/.test(sys) ? passGrade('MagSafe answer is correct') : { folder: 'inbox' });
  h.bots.tools.action = async () => ({ hits: [MAGSAFE_LIGHT] });
  const draft = h.store.createDraft({ author: 'bot:replier', reply_to_id: SAM.id, to: 's@sample.example', subject: 'Re: MagSafe wallet with the QuantaCase?', body: SAM_MAGSAFE_ONLY });
  const g = await h.bots.review(h.bots.db.installed.checker, SAM, draft, { store_lookup: { products: [TURQ] }, kb_gaps: [] });
  assert.strictEqual(g.verdict, 'fail', g.notes);
  assert.match(g.notes, /iphone 17 pro max/i);
  assert.match(g.notes, /apple-iphone-17-pro-max|Turquoise|\$69/i);
  const add = (g.edits || []).find(x => x.action === 'add');
  assert.ok(add, JSON.stringify(g.edits));
  assert.match(add.fact, /apple-iphone-17-pro-max/);
  assert.match(add.fact, /Turquoise/);
  assert.match(add.fact, /\$69/);
  assert.match(add.source, /store_lookup/);
});

test('Sam pipeline: MagSafe-only draft is revised to include the 17 Pro Max case and keeps the MagSafe answer and RF Safe team sign-off', async () => {
  const h = harness(({ sys, user }) => {
    if (/Classify/.test(sys)) return { folder: 'inbox', reason: 'customer question' };
    if (/Independently review/.test(sys)) return passGrade('magsafe ok');
    if (user.revise) {
      let b = user.previous_draft.body;
      for (const e of user.edits || []) if (e.action === 'add' && !b.includes(e.text)) b = b.replace(/\s*The RF Safe team\s*$/, '\n\n' + e.text + '\n\nThe RF Safe team');
      return { needs_reply: true, reason: 'added product', body: b };
    }
    return { needs_reply: true, reason: 'first', body: SAM_MAGSAFE_ONLY };
  });
  h.bots.productSearch = async () => [TURQ];
  h.bots.tools.action = async (bot, tool) => (tool === 'kb' ? { hits: [MAGSAFE_LIGHT] } : { products: [TURQ] });
  h.arrive({ id: SAM.id, subject: SAM.subject, text: SAM.text, from: 'Sam Sample <sam@sample.example>' });
  await h.run();
  const s = h.steps(SAM.id);
  assert.ok(s.includes('check:revise_requested'), s.join(' | '));
  assert.ok(s.includes('reply:revised'), s.join(' | '));
  assert.ok(h.sent.length, 'reply was sent after the revise');
  for (const m of h.sent) {
    assert.match(m.body, /not MagSafe compatible/i);
    assert.match(m.body, /apple-iphone-17-pro-max/);
    assert.match(m.body, /Turquoise/i);
    assert.match(m.body, /\$69/);
    assert.match(m.body, /The RF Safe team\s*$/);
  }
});

test("Dave: a two-model color, price, stock and link reply still passes (r.14ff0159 regression)", async () => {
  const h = harness(({ sys }) => /Independently review/.test(sys) ? passGrade('all product facts present') : { folder: 'inbox' });
  h.bots.tools.action = async () => ({ hits: [] });
  const draft = h.store.createDraft({ author: 'bot:replier', reply_to_id: DAVE.id, to: 'd@sample.example', subject: 'Re: Cases for my wife and me', body: DAVE_OK });
  const g = await h.bots.review(h.bots.db.installed.checker, DAVE, draft, { store_lookup: { products: [TURQ, P16] }, kb_gaps: [] });
  assert.strictEqual(g.verdict, 'pass', g.notes);
  assert.ok(!(g.edits || []).some(e => /product link|colors, price/i.test(e.reason || e.fact || '')), JSON.stringify(g.edits));
});
