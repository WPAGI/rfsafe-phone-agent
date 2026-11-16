'use strict';
// Checker link + model fixes (John, Nov 16, 2026, 4:23 PM ET; r.cb45d453 "promax case swap?"). Mock data only: no network,
// no real orders, no real email, no keys. Mock scenario: order #1173 (processing, Black iPhone 17 Pro Max QuantaCase);
// the customer asks to swap to Turquoise. The draft offers the switch and links the Turquoise variant.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const B = require('../vendor/sitemail/src/mailbox/bots');
const { MailBots } = B;
const { MailboxStore } = require('../vendor/sitemail/src/mailbox/store');
const { Sealer, newKey } = require('../vendor/sitemail/src/mailbox/crypto');
const PC = require('../vendor/sitemail/src/mailbox/phone-catalog');

const TURQ_ID = '55171787817239';
const PM_URL = 'https://quantacase.com/products/apple-iphone-17-pro-max';
const PM = { title: 'RF Safe QuantaCase for Apple iPhone 17 Pro Max', handle: 'apple-iphone-17-pro-max', url: PM_URL, price: { amount: '69.00', currency: 'USD' }, variants: [
  { id: '55171787751703', title: 'Black', price: '69.00', available: true, url: PM_URL + '?variant=55171787751703' },
  { id: '55171787784471', title: 'Brown', price: '69.00', available: true, url: PM_URL + '?variant=55171787784471' },
  { id: TURQ_ID, title: 'Turquoise', price: '69.00', available: true, url: PM_URL + '?variant=' + TURQ_ID }] };
const AIR_URL = 'https://quantacase.com/products/apple-iphone-17-air';
const AIR = { title: 'RF Safe QuantaCase for Apple iPhone 17 Air', handle: 'apple-iphone-17-air', url: AIR_URL, price: { amount: '69.99', currency: 'USD' }, variants: [{ id: '777001', title: 'Black', price: '69.99', available: true, url: AIR_URL + '?variant=777001' }] };
const P17 = { title: 'RF Safe QuantaCase for Apple iPhone 17', handle: 'apple-iphone-17', url: 'https://quantacase.com/products/apple-iphone-17', price: { amount: '69.00', currency: 'USD' }, variants: [{ id: '888001', title: 'Black', price: '69.00', available: true }] };
const PRO = { title: 'RF Safe QuantaCase for Apple iPhone 17 Pro', handle: 'apple-iphone-17-pro', url: 'https://quantacase.com/products/apple-iphone-17-pro', price: { amount: '69.00', currency: 'USD' }, variants: [{ id: '999001', title: 'Black', price: '69.00', available: true }] };
const SWAP = { id: 'r.mock-promax-swap', subject: 'promax case swap?', text: 'Hi, I just ordered the black case for my iphone 17 promax, order #1173. Can I swap it for turqouise before it ships? Also does it work with MagSafe?' };
const ASKED = SWAP.subject + '\n' + SWAP.text;
const DRAFT = 'Hi there,\n\nYour order #1173 has not shipped yet, so we can switch it from Black to Turquoise before it ships. Just reply with the color you want.\n\n'
  + 'The iPhone 17 Pro Max QuantaCase is $69 and in stock in Black, Brown and Turquoise:\nBlack: ' + PM_URL + '?variant=55171787751703\nBrown: ' + PM_URL + '?variant=55171787784471\nTurquoise: ' + PM_URL + '?variant=' + TURQ_ID + '\n\n'
  + 'The QuantaCase is not MagSafe compatible. It does not interfere with wireless charging.\n\nThe RF Safe team';
const MODELS = { models: [
  { id: 'grok-4.7', aliases: [], prompt_text_token_price: 20000, cached_prompt_text_token_price: 5000, completion_text_token_price: 60000, output_modalities: ['text'] },
  { id: 'grok-4.20-0309-non-reasoning', aliases: [], prompt_text_token_price: 12500, cached_prompt_text_token_price: 2000, completion_text_token_price: 25000, output_modalities: ['text'] }
] };
const catalogFields = (products) => PC.catalogFields({ block: PC.formatBlock(products.map(p => ({ model: p.title, product: p }))), models: products.map(p => p.title), found: products.map(p => ({ model: p.title, product: p })) });
function passGrade() { return { verdict: 'pass', main_question: 'switch color', answers_main_question: true, questions_asked: ['q'], unanswered: [], unasked_additions: [], notes: 'ok', improvements: [] }; }

const dirs = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-promax-')); dirs.push(d); return d; }
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function catalog(dir) {
  const api = PC.createPhoneCatalog({ dataDir: dir, listCatalog: async () => [P17, AIR, PRO, PM], extractPhoneModels: B.extractPhoneModels, phoneKeys: B.phoneKeys, handleGuesses: B.handleGuesses, storeDomain: 'quantacase.com', now: () => new Date('2026-11-16T20:35:00Z'), liveStockMs: 80, log: () => {} });
  api.setProducts([P17, AIR, PRO, PM], 'seed');
  return api;
}

function harness(script, opts = {}) {
  const dir = tmp();
  const store = new MailboxStore({ file: path.join(dir, 'mailbox.json'), sealer: new Sealer(newKey()) });
  store.setSettings({ auto_send: true, daily_cap: 20 }, 'test');
  const messages = new Map();
  const tools = { state: () => ({ shopify: { connected: true } }), kbUrls: () => [], kbVersion: () => 'test', entryBySlug: () => null, connectedForOrders: () => false,
    action: async (bot, tool) => (tool === 'shopify' ? { products: opts.storeProducts || [] } : { hits: [] }) };
  const fetchImpl = async (url, opt = {}) => {
    const u = String(url);
    if (u.includes('/v1/language-models')) return { ok: true, status: 200, json: async () => MODELS };
    if (u.includes('/chat/completions')) {
      const b = JSON.parse(opt.body); const sys = b.messages[0].content; let user = {}; try { user = JSON.parse(b.messages[1].content); } catch {}
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(script({ sys, user })) } }], usage: { prompt_tokens: 20, completion_tokens: 20 } }) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  const bots = new MailBots({ store, env: { XAI_API_KEY: 'xai-test-not-real' }, fetchImpl, tools, phoneCatalog: catalog(dir), ownDomains: ['callbots.org'],
    received: async () => [...messages.values()].map(m => ({ id: m.id, created_at: m.created_at })), original: async (id) => messages.get(id) || null,
    createDraft: async (who, b) => { const o = messages.get(b.reply_to_id) || {}; const d = store.createDraft({ author: who, reply_to_id: b.reply_to_id, to: o.from, subject: 'Re: ' + (o.subject || ''), body: b.body, reason: b.reason }); return { code: 201, body: { draft: { id: d.id } } }; },
    autoSend: async () => ({ auto: false, reason: 'auto_send_off' }) });
  bots.db.cap = 100;
  for (const id of ['sorter', 'replier', 'checker']) bots.toggle(id, true);
  for (const r of Object.values(bots.db.installed)) if (r.enabled) r.enabled_at = 0;
  function arrive(m) { const x = { from: 'Pat Mock <pat@mock.example>', created_at: new Date().toISOString(), folder: 'inbox', ...m }; messages.set(x.id, x); store.putCopy(x.id, x); }
  async function run() { await bots.wake('owner'); for (let i = 0; i < 12; i++) { if (bots.pending) await bots.pending; await new Promise(r => setTimeout(r, 40)); if (bots.pending) await bots.pending; if (!bots.running && !bots.again) break; } }
  return { bots, store, arrive, run };
}

test('typos: "17 promax" is the iPhone 17 Pro Max and "turqouise" is Turquoise; the 17 Air is its own model', () => {
  assert.deepStrictEqual(B.extractPhoneModels(SWAP.subject, SWAP.text).map(m => m.toLowerCase()), ['iphone 17 pro max']);
  assert.deepStrictEqual(B.phoneKeys(ASKED), ['iphone 17 pro max']);
  assert.deepStrictEqual(B.phoneKeys('iphone 17 pro-max'), ['iphone 17 pro max']);
  assert.match(B.fixTypos('can I get turqouise'), /\bturquoise\b/);
  for (const t of ['turquiose', 'turqoise', 'turquise', 'torquoise', 'Turquoise']) assert.match(B.fixTypos(t), /^turquoise$/i, t);
  assert.deepStrictEqual(B.phoneKeys(AIR.title + ' ' + AIR.url), ['iphone 17 air']);
  assert.deepStrictEqual(B.extractPhoneModels('', 'my iphone 17 promax, the iphone 17 one').map(m => m.toLowerCase()), ['iphone 17 pro max'], 'most specific model wins');
  assert.deepStrictEqual(B.extractPhoneModels('', 'iPhone 16 Pro and 17 Pro Max'), ['iPhone 16 Pro', 'iPhone 17 Pro Max'], 'two different phones are both kept');
  assert.deepStrictEqual(B.specificKeys(['iphone 17', 'iphone 17 pro max', 'iphone 16 pro']), ['iphone 17 pro max', 'iphone 16 pro']);
  const PM_COLORED = B.withColorLinks({ products: [PM] }, 'can I get turqouise for my 17 promax?').products[0];
  assert.strictEqual(PM_COLORED.requested_color && PM_COLORED.requested_color.value, 'Turquoise');
});

test('catalog pre-lookup for the email finds only the 17 Pro Max (no iPhone 17, 17 Air or 17 Pro)', async () => {
  const hit = await catalog(tmp()).resolve(SWAP.subject, SWAP.text);
  assert.deepStrictEqual(hit.found.map(x => x.product.handle), ['apple-iphone-17-pro-max']);
});

test('link check: the 17 Pro Max Turquoise variant link from the catalog passes; a wrong-phone or unknown variant link fails', () => {
  const ok = B.checkLinks(DRAFT, { asked: ASKED, storeLookup: { products: [] }, catalog: [PM] });
  assert.deepStrictEqual(ok.problems, []); assert.ok(ok.ok.includes(PM_URL + '?variant=' + TURQ_ID));
  // The writer's store search pulled in the 17 Air; the catalog still has the right phone.
  assert.deepStrictEqual(B.checkLinks(DRAFT, { asked: ASKED, storeLookup: { products: [AIR] }, catalog: [PM] }).problems, []);
  const air = B.checkLinks('Here: ' + AIR_URL + '?variant=777001', { asked: ASKED, storeLookup: { products: [AIR] }, catalog: [PM] });
  assert.strictEqual(air.problems.length, 1); assert.match(air.problems[0].problem, /does not match the phone asked about/);
  const bad = B.checkLinks('Here: ' + PM_URL + '?variant=123', { asked: ASKED, storeLookup: { products: [] }, catalog: [PM] });
  assert.match(bad.problems[0].problem, /variant 123 is not a variant of/);
  const invented = B.checkLinks('Here: https://quantacase.com/products/apple-iphone-17-pro-max-turquoise', { asked: ASKED, storeLookup: { products: [] }, catalog: [PM] });
  assert.match(invented.problems[0].problem, /not found in the store/);
});

test('checker passes the correct #1173 swap draft and does not demand the 17 Air', async () => {
  const h = harness(({ sys }) => /Independently review/.test(sys) ? passGrade() : { folder: 'inbox' });
  const draft = h.store.createDraft({ author: 'bot:replier', reply_to_id: SWAP.id, to: 'pat@mock.example', subject: 'Re: ' + SWAP.subject, body: DRAFT });
  const g = await h.bots.review(h.bots.db.installed.checker, SWAP, draft, { store_lookup: { products: [AIR] }, kb_gaps: [], switch_orders: ['#1173'], system_notes: 'System notes for this email (mock)', ...catalogFields([PM]) });
  assert.strictEqual(g.verdict, 'pass', g.notes);
  assert.doesNotMatch(JSON.stringify(g), /17 air|69\.99/i);
  // The same draft with the 17 Air link instead still fails as the wrong phone.
  const wrong = h.store.createDraft({ author: 'bot:replier', reply_to_id: SWAP.id, to: 'pat@mock.example', subject: 'Re: ' + SWAP.subject, body: DRAFT.replace(PM_URL + '?variant=' + TURQ_ID, AIR_URL + '?variant=777001') });
  const g2 = await h.bots.review(h.bots.db.installed.checker, SWAP, wrong, { store_lookup: { products: [AIR] }, kb_gaps: [], switch_orders: ['#1173'], ...catalogFields([PM]) });
  assert.strictEqual(g2.verdict, 'fail'); assert.match(g2.notes, /Wrong or unknown link: .*apple-iphone-17-air.*does not match the phone asked about/);
});

test('checker time limit: 240 s with System notes, a large input, or the automatic retry; small checks keep the default', () => {
  assert.strictEqual(B.checkerMs('grok-4.7', false, 'short'), 0);
  assert.strictEqual(B.checkerMs('grok-4.7', false, 'short', { systemNotes: true }), 240000);
  assert.strictEqual(B.checkerMs('grok-4.7', false, 'short', { inputChars: B.LARGE_CHECK_INPUT_CHARS }), 240000);
  assert.strictEqual(B.checkerMs('grok-4.7', false, 'short', { retry: true }), 240000);
  assert.strictEqual(B.checkerMs('grok-4.20-0309-non-reasoning', false, 'short', { systemNotes: true, retry: true }), 0, 'non-reasoning keeps its default');
});

test('a checker timeout is retried once on the saved draft with the longer limit, and the draft is checked, not given up', async () => {
  const h = harness(({ sys }) => {
    if (/Classify/.test(sys)) return { folder: 'inbox', reason: 'customer question' };
    if (/Independently review/.test(sys)) return passGrade();
    return { needs_reply: true, reason: 'draft', body: DRAFT };
  });
  const call = h.bots.call.bind(h.bots); const checks = [];
  h.bots.call = async (r, input, opts = {}) => {
    if (input && input.draft && input.original) {
      checks.push({ timeoutMs: opts.timeoutMs, system_notes: !!input.system_notes });
      if (checks.length === 1) throw Object.assign(new Error('provider_timeout'), { status: 504 });
    }
    return call(r, input, opts);
  };
  h.arrive(SWAP); h.bots.enqueue(SWAP.id); // a queued run (like the 3:46 PM ET rerun) gets one automatic retry
  await h.run();
  for (let i = 0; i < 50 && !h.bots.timeline(SWAP.id).some(x => x.step === 'check' && x.status === 'pass' || x.status === 'gave_up'); i++) { await new Promise(r => setTimeout(r, 40)); if (h.bots.pending) await h.bots.pending; }
  while (h.bots.running) await new Promise(r => setTimeout(r, 20));
  const tl = h.bots.timeline(SWAP.id).map(x => x.step + ':' + x.status);
  assert.strictEqual(checks.length, 2, JSON.stringify(tl));
  assert.ok(checks.every(c => c.timeoutMs === 240000 && c.system_notes), JSON.stringify(checks));
  assert.ok(tl.includes('check:resumed'), JSON.stringify(tl));
  assert.ok(tl.includes('check:pass'), JSON.stringify(tl));
  assert.ok(!tl.includes('pipeline:gave_up'), JSON.stringify(tl));
});
