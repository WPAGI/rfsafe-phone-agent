'use strict';
// Mailbox-only QuantaCase catalog (John, Nov 16 4:11–4:21 AM ET). Mocks only: no network, no real email, no keys.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const B = require('../vendor/sitemail/src/mailbox/bots');
const { MailBots } = B;
const { MailboxStore } = require('../vendor/sitemail/src/mailbox/store');
const { Sealer, newKey } = require('../vendor/sitemail/src/mailbox/crypto');
const PC = require('../vendor/sitemail/src/mailbox/phone-catalog');

const TURQ = {
  title: 'RF Safe QuantaCase for Apple iPhone 17 Pro Max',
  handle: 'apple-iphone-17-pro-max',
  url: 'https://quantacase.com/products/apple-iphone-17-pro-max',
  price: { amount: '69.00', currency: 'USD' },
  variants: [
    { id: '1', title: 'Black', price: '69.00', available: true, url: 'https://quantacase.com/products/apple-iphone-17-pro-max?variant=1' },
    { id: '2', title: 'Brown', price: '69.00', available: true, url: 'https://quantacase.com/products/apple-iphone-17-pro-max?variant=2' },
    { id: '3', title: 'Turquoise', price: '69.00', available: true, url: 'https://quantacase.com/products/apple-iphone-17-pro-max?variant=3' }
  ]
};
const P16 = {
  title: 'RF Safe QuantaCase for Apple iPhone 16 Pro',
  handle: 'apple-iphone-16-pro',
  url: 'https://quantacase.com/products/apple-iphone-16-pro',
  price: { amount: '69.00', currency: 'USD' },
  variants: [{ id: '10', title: 'Default Title', price: '69.00', available: true }]
};
const S26 = {
  title: 'RF Safe QuantaCase for Samsung Galaxy S26 Ultra',
  handle: 'samsung-galaxy-s26-ultra',
  url: 'https://quantacase.com/products/samsung-galaxy-s26-ultra',
  price: { amount: '69.00', currency: 'USD' },
  variants: [{ id: '20', title: 'Black', price: '69.00', available: true }]
};
const KAREN = { subject: 'Two cases before Christmas, MagSafe question', text: "Hi, I need one case for my iPhone 16 Pro and one for my wife's 17 Pro Max. What colors and price for the 17 Pro Max, and is it in stock? Also, does it work with MagSafe?" };
const SAM = { subject: 'MagSafe wallet with the QuantaCase?', text: 'Hi, I have an iPhone 17 Pro Max. Does the QuantaCase work with a MagSafe wallet, and can I charge it on a wireless pad?' };
const DAVE = { subject: 'Cases for my wife and me', text: "Hi, I need a case for my iPhone 17 Pro Max and one for my wife's iPhone 16 Pro. What colors, price, and stock for each, and how long to ship to Oregon?" };
const MODELS = { models: [
  { id: 'grok-4.7', aliases: [], prompt_text_token_price: 20000, cached_prompt_text_token_price: 5000, completion_text_token_price: 60000, output_modalities: ['text'] },
  { id: 'grok-4.20-0309-non-reasoning', aliases: [], prompt_text_token_price: 12500, cached_prompt_text_token_price: 2000, completion_text_token_price: 25000, output_modalities: ['text'] }
] };

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pa-catalog-')); }

function catalog(opts = {}) {
  const dir = opts.dir || tmp();
  const api = PC.createPhoneCatalog({
    dataDir: dir,
    listCatalog: opts.listCatalog || (async () => [TURQ, P16, S26]),
    search: opts.search,
    extractPhoneModels: B.extractPhoneModels,
    phoneKeys: B.phoneKeys,
    handleGuesses: B.handleGuesses,
    fetchImpl: opts.fetchImpl,
    storeDomain: 'quantacase.com',
    now: opts.now || (() => new Date('2026-11-16T09:00:00Z')),
    refreshMs: opts.refreshMs || PC.DEFAULT_REFRESH_MS,
    liveStockMs: opts.liveStockMs || 80,
    log: opts.log || (() => {})
  });
  if (opts.seed !== false) api.setProducts(opts.seed || [TURQ, P16, S26], 'seed');
  return { api, dir };
}

test('DEFAULT_REFRESH_MS is one day', () => {
  assert.strictEqual(PC.DEFAULT_REFRESH_MS, 24 * 60 * 60 * 1000);
  assert.strictEqual(PC.BLOCK_TITLE, 'QuantaCases available for phones mentioned in this email');
});

test("aliases: 17 Pro Max, wife's 17 Pro Max, S26 Ultra; not Galaxy S17; Karen/Sam/Dave", () => {
  assert.deepStrictEqual(B.extractPhoneModels(KAREN.subject, KAREN.text), ['iPhone 16 Pro', 'iPhone 17 Pro Max']);
  assert.deepStrictEqual(B.extractPhoneModels(SAM.subject, SAM.text), ['iPhone 17 Pro Max']);
  assert.deepStrictEqual(B.extractPhoneModels(DAVE.subject, DAVE.text), ['iPhone 17 Pro Max', 'iPhone 16 Pro']);
  assert.deepStrictEqual(B.extractPhoneModels('Case', 'Need a case for a 17 Pro Max'), ['iPhone 17 Pro Max']);
  assert.deepStrictEqual(B.extractPhoneModels('', 'Do you have a case for the S26 Ultra?'), ['Samsung Galaxy S26 Ultra']);
  assert.ok(!B.extractPhoneModels(KAREN.subject, KAREN.text).some(m => /s17|galaxy s17/i.test(m)));
  const { api } = catalog();
  const k = api.match(KAREN.subject, KAREN.text);
  assert.deepStrictEqual(k.found.map(x => x.model), ['iPhone 16 Pro', 'iPhone 17 Pro Max']);
  assert.strictEqual(k.missing.length, 0);
  assert.match(k.block, new RegExp('^' + PC.BLOCK_TITLE));
  assert.match(k.block, /apple-iphone-17-pro-max/);
  assert.match(k.block, /apple-iphone-16-pro/);
  const s26 = api.match('', 'Need a case for the S26 Ultra');
  assert.strictEqual(s26.found[0].product.handle, 'samsung-galaxy-s26-ultra');
});

test('a single Default Title variant is Black, one color', () => {
  const line = PC.formatProductLine(P16);
  assert.match(line, /Black \(one color\)/);
  assert.doesNotMatch(line, /Default Title/);
  assert.match(line, /\$69/);
  const { api } = catalog();
  const hit = api.match('', 'iPhone 16 Pro');
  assert.match(hit.block, /Black \(one color\)/);
});

test('daily refresh is single-flight and keeps the last good cache on failure', async () => {
  let n = 0; let fail = false; const logs = [];
  const listCatalog = async () => {
    n += 1;
    if (fail) throw new Error('store down');
    return [TURQ, P16, S26];
  };
  const { api } = catalog({ listCatalog, seed: false, log: (e) => logs.push(e) });
  const a = api.refresh();
  const b = api.refresh();
  assert.strictEqual(a, b);
  await a;
  assert.strictEqual(n, 1);
  assert.strictEqual(api.status().ok, true);
  assert.strictEqual(api.status().models, 3);
  assert.ok(api.status().variants >= 5);
  const before = api.status();
  fail = true;
  const kept = await api.refresh();
  assert.ok(logs.includes('refresh_failed'));
  assert.strictEqual(kept.models, before.models);
  assert.strictEqual(api.products().length, 3);
  assert.strictEqual(api.status().refreshed_at, before.refreshed_at);
});

test('start refreshes when the cache is older than a day, not sooner', async () => {
  const dir = tmp();
  let n = 0;
  const listCatalog = async () => { n += 1; return [TURQ]; };
  const t0 = Date.parse('2026-11-15T09:00:00Z');
  const first = PC.createPhoneCatalog({ dataDir: dir, listCatalog, now: () => new Date(t0), refreshMs: PC.DEFAULT_REFRESH_MS, extractPhoneModels: B.extractPhoneModels, phoneKeys: B.phoneKeys });
  first.setProducts([TURQ, P16], 'seed');
  first.stop();
  n = 0;
  const laterSameDay = PC.createPhoneCatalog({ dataDir: dir, listCatalog, now: () => new Date(t0 + 12 * 60 * 60 * 1000), refreshMs: PC.DEFAULT_REFRESH_MS, extractPhoneModels: B.extractPhoneModels, phoneKeys: B.phoneKeys });
  laterSameDay.start();
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(n, 0, 'should not refresh a cache that is 12 hours old');
  laterSameDay.stop();
  const nextDay = PC.createPhoneCatalog({ dataDir: dir, listCatalog, now: () => new Date(t0 + 25 * 60 * 60 * 1000), refreshMs: PC.DEFAULT_REFRESH_MS, extractPhoneModels: B.extractPhoneModels, phoneKeys: B.phoneKeys });
  nextDay.start();
  await new Promise(r => setTimeout(r, 40));
  assert.ok(n >= 1, 'should refresh a cache older than a day');
  nextDay.stop();
});

test('live stock overrides cached availability; a timeout keeps cached stock', async () => {
  const liveJs = {
    handle: 'apple-iphone-17-pro-max',
    title: TURQ.title,
    price: 6900,
    variants: [
      { id: 1, title: 'Black', available: true, price: 6900 },
      { id: 2, title: 'Brown', available: false, price: 6900 },
      { id: 3, title: 'Turquoise', available: true, price: 6900 }
    ]
  };
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (String(url).includes('apple-iphone-17-pro-max.js')) return { ok: true, status: 200, json: async () => liveJs };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const { api } = catalog({ fetchImpl });
  const hit = await api.resolve(SAM.subject, SAM.text);
  assert.strictEqual(hit.found[0].live, true);
  const colors = hit.found[0].product.variants.filter(v => v.available !== false).map(v => v.title);
  assert.deepStrictEqual(colors, ['Black', 'Turquoise']);
  assert.ok(!hit.block.includes('Brown'));
  assert.match(hit.block, /Turquoise/);

  const hang = (url, opt = {}) => new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (opt.signal && opt.signal.aborted) return onAbort();
    if (opt.signal) opt.signal.addEventListener('abort', onAbort, { once: true });
  });
  const { api: api2 } = catalog({ fetchImpl: hang, liveStockMs: 30 });
  const cached = await api2.resolve(SAM.subject, SAM.text);
  assert.strictEqual(cached.found[0].live, false);
  assert.match(cached.block, /Brown/);
  assert.match(cached.block, /Turquoise/);
});

test('on a catalog miss, a handle probe fills the product and the next match uses it', async () => {
  const js = { handle: 'apple-iphone-17-pro-max', title: TURQ.title, price: 6900, variants: TURQ.variants.map(v => ({ id: Number(v.id), title: v.title, available: true, price: 6900 })) };
  const fetchImpl = async (url) => String(url).includes('apple-iphone-17-pro-max.js') ? { ok: true, status: 200, json: async () => js } : { ok: false, status: 404, json: async () => ({}) };
  const { api } = catalog({ seed: [P16, S26], fetchImpl });
  const hit = await api.resolve(SAM.subject, SAM.text);
  assert.strictEqual(hit.found[0].product.handle, 'apple-iphone-17-pro-max');
  assert.match(hit.block, /\$69/);
});

function passGrade(notes) { return { verdict: 'pass', main_question: 'customer question', answers_main_question: true, questions_asked: ['q'], unanswered: [], unasked_additions: [], notes: notes || 'ok', improvements: [] }; }

function harness(script, extra = {}) {
  const dir = tmp();
  const store = new MailboxStore({ file: path.join(dir, 'mailbox.json'), sealer: new Sealer(newKey()) });
  store.setSettings({ auto_send: true, daily_cap: 20 }, 'test');
  const messages = new Map();
  const captured = [];
  const tools = {
    state: () => ({ shopify: { connected: true } }),
    kbUrls: () => [], kbVersion: () => 'test', entryBySlug: () => null, connectedForOrders: () => false,
    action: async () => ({ hits: [] })
  };
  const fetchImpl = async (url, opt = {}) => {
    const u = String(url);
    if (u.includes('/v1/language-models')) return { ok: true, status: 200, json: async () => MODELS };
    if (u.includes('/chat/completions')) {
      const b = JSON.parse(opt.body);
      const sys = b.messages[0].content;
      let user = {}; try { user = JSON.parse(b.messages[1].content); } catch { user = {}; }
      captured.push({ sys, user });
      const out = script({ sys, user });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(out) } }], usage: { prompt_tokens: 20, completion_tokens: 20 } }) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  const { api: phoneCatalog } = catalog({ dir });
  const bots = new MailBots({
    store, env: { XAI_API_KEY: 'xai-test-not-real' }, fetchImpl, tools, phoneCatalog,
    ownDomains: ['callbots.org'],
    received: async () => [...messages.values()].map(m => ({ id: m.id, created_at: m.created_at })),
    original: async (id) => messages.get(id) || null,
    createDraft: async (who, b) => {
      const orig = messages.get(b.reply_to_id) || {};
      const d = store.createDraft({ author: who, reply_to_id: b.reply_to_id, to: orig.from, subject: 'Re: ' + (orig.subject || ''), body: b.body, reason: b.reason });
      return { code: 201, body: { draft: { id: d.id } } };
    },
    autoSend: async () => ({ auto: false, reason: 'auto_send_off' })
  });
  bots.db.cap = 100;
  for (const id of ['sorter', 'replier', 'checker']) bots.toggle(id, true);
  for (const r of Object.values(bots.db.installed)) if (r.enabled) r.enabled_at = 0;
  function arrive(m) { const x = { from: 'Pat Sample <pat@sample.example>', created_at: new Date().toISOString(), folder: 'inbox', ...m }; messages.set(x.id, x); store.putCopy(x.id, x); }
  async function run() {
    await bots.wake('owner');
    for (let i = 0; i < 12; i++) {
      if (bots.pending) await bots.pending;
      await new Promise(r => setTimeout(r, 40));
      if (bots.pending) await bots.pending;
      if (!bots.running && !bots.again) break;
    }
  }
  return { bots, store, captured, arrive, run, dir, phoneCatalog };
}

test('writer and checker inputs both include the titled QuantaCases block', async () => {
  const h = harness(({ sys, user }) => {
    if (/Classify/.test(sys)) return { folder: 'inbox', reason: 'customer question' };
    if (/Independently review/.test(sys)) return passGrade('ok');
    return { needs_reply: true, reason: 'draft', body: 'Hi Sam,\n\nThe QuantaCase is not MagSafe compatible. The iPhone 17 Pro Max case is $69 in Black, Brown and Turquoise: https://quantacase.com/products/apple-iphone-17-pro-max\n\nThe RF Safe team' };
  });
  h.arrive({ id: 'r.sam-cat', subject: SAM.subject, text: SAM.text, from: 'Sam Sample <sam@sample.example>' });
  await h.run();
  const writer = h.captured.find(c => c.user && c.user.quanta_cases_block && !/Independently review/.test(c.sys));
  const checker = h.captured.find(c => /Independently review/.test(c.sys));
  assert.ok(writer, 'writer saw the catalog block');
  assert.ok(checker, 'checker ran');
  assert.strictEqual(writer.user.phone_catalog.title, PC.BLOCK_TITLE);
  assert.match(writer.user.quanta_cases_block, new RegExp('^' + PC.BLOCK_TITLE));
  assert.match(writer.user.quanta_cases_block, /apple-iphone-17-pro-max/);
  const extra = checker.user.extra || checker.user;
  const block = extra.quanta_cases_block || (checker.user.quanta_cases_block);
  assert.match(String(block || JSON.stringify(checker.user)), new RegExp(PC.BLOCK_TITLE));
  assert.match(JSON.stringify(checker.user), /apple-iphone-17-pro-max/);
});

test('checker fails a reply that contradicts the catalog price', async () => {
  const h = harness(({ sys }) => /Independently review/.test(sys) ? passGrade('looks fine') : { folder: 'inbox' });
  const orig = { id: 'r.price-bad', subject: SAM.subject, text: SAM.text };
  const draft = h.store.createDraft({ author: 'bot:replier', reply_to_id: orig.id, to: 's@sample.example', subject: 'Re: MagSafe', body: 'Hi Sam,\n\nThe iPhone 17 Pro Max case is $49 in Black, Brown and Turquoise: https://quantacase.com/products/apple-iphone-17-pro-max\n\nThe RF Safe team' });
  const g = await h.bots.review(h.bots.db.installed.checker, orig, draft, { store_lookup: { products: [TURQ] }, kb_gaps: [], ...PC.catalogFields({ block: PC.formatBlock([{ model: 'iPhone 17 Pro Max', product: TURQ }]), models: ['iPhone 17 Pro Max'], found: [{ model: 'iPhone 17 Pro Max', product: TURQ }] }) });
  assert.strictEqual(g.verdict, 'fail', g.notes);
  assert.match(g.notes, /\$49/);
  assert.match(g.notes, /catalog/i);
  const change = (g.edits || []).find(e => e.source === 'phone_catalog' && e.action === 'change');
  assert.ok(change, JSON.stringify(g.edits));
  assert.match(change.fact, /\$69/);
});

test("Dave: two-model catalog facts still pass; Sam MagSafe-only still fails from the catalog block", async () => {
  const h = harness(({ sys }) => /Independently review/.test(sys) ? passGrade('ok') : { folder: 'inbox' });
  const daveDraft = h.store.createDraft({ author: 'bot:replier', reply_to_id: 'r.dave', to: 'd@sample.example', subject: 'Re: cases', body: 'Hi Dave,\n\nFor the iPhone 17 Pro Max, Black, Brown, and Turquoise are in stock at $69 each.\nhttps://quantacase.com/products/apple-iphone-17-pro-max\n\nFor the iPhone 16 Pro, Black is in stock at $69.\nhttps://quantacase.com/products/apple-iphone-16-pro\n\nThe RF Safe team' });
  const fields = PC.catalogFields({ block: PC.formatBlock([{ model: 'iPhone 17 Pro Max', product: TURQ }, { model: 'iPhone 16 Pro', product: P16 }]), models: ['iPhone 17 Pro Max', 'iPhone 16 Pro'], found: [{ model: 'iPhone 17 Pro Max', product: TURQ }, { model: 'iPhone 16 Pro', product: P16 }] });
  const g = await h.bots.review(h.bots.db.installed.checker, DAVE, daveDraft, { store_lookup: { products: [TURQ, P16] }, kb_gaps: [], ...fields });
  assert.strictEqual(g.verdict, 'pass', g.notes);
  const samDraft = h.store.createDraft({ author: 'bot:replier', reply_to_id: 'r.sam', to: 's@sample.example', subject: 'Re: MagSafe', body: 'Hi Sam,\n\nThe QuantaCase is not MagSafe compatible. It does not interfere with wireless charging.\n\nThe RF Safe team' });
  const g2 = await h.bots.review(h.bots.db.installed.checker, SAM, samDraft, { store_lookup: { products: [] }, kb_gaps: [], ...PC.catalogFields({ block: PC.formatBlock([{ model: 'iPhone 17 Pro Max', product: TURQ }]), models: ['iPhone 17 Pro Max'], found: [{ model: 'iPhone 17 Pro Max', product: TURQ }] }) });
  assert.strictEqual(g2.verdict, 'fail', g2.notes);
  assert.match(g2.notes, /iphone 17 pro max/i);
  const add = (g2.edits || []).find(e => e.source === 'phone_catalog');
  assert.ok(add); assert.match(add.fact, /apple-iphone-17-pro-max/);
});

test('listPublicCatalog pages products.json and normalizes variants', async () => {
  const page1 = { products: [{ title: TURQ.title, handle: TURQ.handle, variants: [{ id: 1, title: 'Black', price: '69.00', available: true }, { id: 2, title: 'Brown', price: '69.00', available: true }] }] };
  const page2 = { products: [{ title: P16.title, handle: P16.handle, variants: [{ id: 10, title: 'Default Title', price: '69.00', available: true }] }] };
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes('page=1')) return { ok: true, json: async () => page1 };
    if (String(url).includes('page=2')) return { ok: true, json: async () => page2 };
    return { ok: true, json: async () => ({ products: [] }) };
  };
  const list = await PC.listPublicCatalog(fetchImpl, 'quantacase.com', { pageSize: 1 });
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].handle, 'apple-iphone-17-pro-max');
  assert.strictEqual(list[0].price.amount, '69.00');
  assert.strictEqual(list[1].variants[0].title, 'Default Title');
  assert.ok(urls.some(u => u.includes('/products.json?limit=1&page=1')));
});
