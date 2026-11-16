'use strict';
// Mailbox past-customer order index (John, Nov 16 4:31–4:34 AM ET). REVIEW ONLY. Mocks only: no network, no real orders, no keys printed.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const http = require('http');
const { Sealer, newKey } = require('../vendor/sitemail/src/mailbox/crypto');
const OI = require('../vendor/sitemail/src/mailbox/orderindex');
const { MailBots } = require('../vendor/sitemail/src/mailbox/bots');
const { MailboxStore } = require('../vendor/sitemail/src/mailbox/store');
const { buildDeps } = require('../src/runtime'); const { createApp } = require('../src/app'); const { ENV } = require('./helpers');

const ALICE = {
  id: 'gid://shopify/Order/101',
  name: '#1001',
  updatedAt: '2026-01-10T12:00:00Z',
  email: 'Alice.Smith@Example.COM',
  phone: '(727) 555-0101',
  customer: { firstName: 'Alice', lastName: 'Smith', defaultEmailAddress: { emailAddress: 'Alice.Smith@Example.COM' }, defaultPhoneNumber: { phoneNumber: '+1 727 555 0101' } },
  shippingAddress: { address1: '123 Secret St', city: 'Seminole', zip: '33772', phone: '727-555-0199' },
  totalPrice: '69.00',
  paymentGatewayNames: ['shopify_payments'],
  lineItems: { nodes: [{ title: 'QuantaCase', quantity: 1 }] }
};
const BOB = {
  id: 'gid://shopify/Order/202',
  name: '#2002',
  updatedAt: '2026-02-01T12:00:00Z',
  email: 'bob@example.com',
  phone: '813-555-0202',
  customer: { firstName: 'Bob', defaultEmailAddress: { emailAddress: 'bob@example.com' }, defaultPhoneNumber: { phoneNumber: '8135550202' } },
  shippingAddress: { address1: '9 Other Ave', city: 'Tampa' },
  lineItems: { nodes: [{ title: 'Case', quantity: 2 }] }
};
const BOB2 = { ...BOB, id: 'gid://shopify/Order/203', name: '#2003', updatedAt: '2026-03-01T12:00:00Z' };

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pa-oi-')); }

function index(opts = {}) {
  const dir = opts.dir || tmp();
  const logs = opts.logs || [];
  const sealer = opts.sealer || new Sealer(newKey());
  const api = OI.createOrderIndex({
    dataDir: dir,
    sealer,
    adminQuery: opts.adminQuery,
    env: { SITEMAIL_ORDER_INDEX: opts.flag === false ? '0' : '1', ...(opts.env || {}) },
    hmacSecret: opts.hmacSecret || 'test-hmac-secret',
    now: opts.now || (() => new Date('2026-11-16T10:00:00Z')),
    log: (ev, d) => { logs.push({ ev, ...(d || {}) }); },
    mock: opts.mock || false,
    syncMs: opts.syncMs || 60 * 60 * 1000
  });
  return { api, dir, logs, sealer };
}

// Render's build runs `npm test` without installing devDependencies, so the graphql parser is optional here.
// The bracket check below has no dependencies and catches the stray `}` that broke the first go-live.
function bracketsBalanced(q) {
  const pairs = { '}': '{', ')': '(', ']': '[' }; const stack = [];
  for (const ch of String(q)) {
    if (ch === '{' || ch === '(' || ch === '[') stack.push(ch);
    else if (pairs[ch]) { if (stack.pop() !== pairs[ch]) return false; }
  }
  return stack.length === 0;
}
test('LIST_QUERY, STATUS_QUERY, and COUNT_QUERY parse as valid GraphQL', () => {
  let parse = null; try { ({ parse } = require('graphql')); } catch {}
  for (const [name, q] of [['LIST_QUERY', OI.LIST_QUERY], ['STATUS_QUERY', OI.STATUS_QUERY], ['COUNT_QUERY', OI.COUNT_QUERY]]) {
    assert.ok(q && String(q).trim(), name + ' is missing');
    assert.ok(bracketsBalanced(q), name + ' must have balanced brackets');
    if (parse) assert.doesNotThrow(() => parse(q), name + ' must be valid GraphQL');
  }
  assert.strictEqual(bracketsBalanced('query{ a{ b } } }'), false);
});

test('importAll pages through every order until hasNextPage is false, with no date filter', async () => {
  const pages = [0, 1, 2].map(i => ({ nodes: [{ ...ALICE, id: 'gid://shopify/Order/9' + i, name: '#90' + i, email: 'p' + i + '@example.com', phone: null, customer: { firstName: 'P' } }], pageInfo: { hasNextPage: i < 2, endCursor: 'c' + i } }));
  const calls = [];
  const { api } = index({ adminQuery: async (q, v) => { calls.push(v); return { data: { orders: pages[calls.length - 1] } }; } });
  const r = await api.importAll();
  assert.strictEqual(r.imported, 3); assert.strictEqual(r.pages, 3);
  assert.deepStrictEqual(calls.map(v => v.cursor), [null, 'c0', 'c1']);
  assert.ok(calls.every(v => v.q === null), 'full import must not filter by date or status');
  assert.strictEqual(api.recordCount(), 3);
});

test('import filter keeps only first name, order number, email, phone, and unsubscribed flags', () => {
  const r = OI.keepRecord(ALICE);
  assert.deepStrictEqual(Object.keys(r).sort(), ['email', 'email_unsubscribed', 'first_name', 'order_number', 'phone', 'sms_unsubscribed']);
  assert.strictEqual(r.first_name, 'Alice');
  assert.strictEqual(r.order_number, '#1001');
  assert.strictEqual(r.email, 'alice.smith@example.com');
  assert.strictEqual(r.phone, '+17275550101');
  assert.strictEqual(r.email_unsubscribed, true);
  assert.strictEqual(r.sms_unsubscribed, true);
  const blob = JSON.stringify(r);
  assert.doesNotMatch(blob, /Secret St|33772|shopify_payments|QuantaCase|lastName|address1|totalPrice/i);
});

test('normalization: email lowercased, phone E.164, first name only', () => {
  assert.strictEqual(OI.normEmail('  Bob.O\'Neil@Example.COM '), "bob.o'neil@example.com".replace("'", "'"));
  assert.strictEqual(OI.toE164('(727) 555-0101'), '+17275550101');
  assert.strictEqual(OI.toE164('+1 727 555 0101'), '+17275550101');
  assert.strictEqual(OI.toE164('17275550101'), '+17275550101');
  assert.strictEqual(OI.firstNameOf('Alice Marie'), 'Alice');
  assert.strictEqual(OI.orderNumberOf('Order #1001'), '#1001');
});

test('stored file is mode 0600 and sealed; raw file has no customer fields', () => {
  const { api, dir } = index();
  api.upsert(ALICE); api.save();
  const file = path.join(dir, 'order-index.sealed');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /alice\.smith@example\.com/i);
  assert.doesNotMatch(raw, /17275550101/);
  assert.doesNotMatch(raw, /#1001/);
  assert.doesNotMatch(raw, /Alice/);
  api.load();
  assert.strictEqual(api.recordCount(), 1);
  assert.strictEqual(api.data().records[0].email, 'alice.smith@example.com');
});

test('logs never carry email, phone, name or order number', async () => {
  const { api, logs } = index({
    adminQuery: async () => ({ data: { orders: { nodes: [ALICE, BOB], pageInfo: { hasNextPage: false } } } })
  });
  await api.importAll();
  api.ingestWebhook(JSON.stringify(ALICE), { 'x-shopify-hmac-sha256': crypto.createHmac('sha256', 'test-hmac-secret').update(JSON.stringify(ALICE)).digest('base64'), 'x-shopify-topic': 'orders/create' });
  const blob = JSON.stringify(logs);
  assert.doesNotMatch(blob, /alice|bob@|555-0101|5550101|#1001|#2002|Secret St/i);
  assert.ok(logs.some(l => l.ev === 'order_index_import' && l.upserts === 2));
});

test('HMAC verify: good signature accepted, bad rejected', () => {
  const { api } = index();
  const body = JSON.stringify({ name: '#3003', email: 'pat@example.com', phone: '5551112222', customer: { firstName: 'Pat' } });
  const good = crypto.createHmac('sha256', 'test-hmac-secret').update(body).digest('base64');
  const ok = api.ingestWebhook(body, { 'x-shopify-hmac-sha256': good, 'x-shopify-topic': 'orders/create' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.action, 'upsert');
  const bad = api.ingestWebhook(body, { 'x-shopify-hmac-sha256': 'aaaa', 'x-shopify-topic': 'orders/create' });
  assert.strictEqual(bad.status, 401);
  assert.strictEqual(api.recordCount(), 1);
});

test('incremental sync upserts only newer orders and keeps the cursor', async () => {
  let nodes = [ALICE];
  const { api } = index({
    adminQuery: async (q, v) => ({ data: { orders: { nodes: v && v.q && /updated_at/.test(v.q) ? nodes.filter(n => n.updatedAt >= '2026-02-01') : nodes, pageInfo: { hasNextPage: false } } } })
  });
  await api.importAll();
  assert.strictEqual(api.recordCount(), 1);
  nodes = [ALICE, BOB];
  const inc = await api.incremental();
  assert.ok(inc.upserts >= 1);
  assert.strictEqual(api.recordCount(), 2);
  assert.strictEqual(api.data().cursor.last_updated_at, '2026-02-01T12:00:00Z');
});

test('email match note includes live status and tracking; no-match notes are generic', async () => {
  const { api } = index({
    adminQuery: async (q, v) => {
      if (String(q).includes('ordersCount')) return { data: { ordersCount: { count: 2 } } };
      if (v && v.q && /name:1001/.test(v.q)) return { data: { orders: { nodes: [{ name: '#1001', displayFulfillmentStatus: 'FULFILLED', fulfillments: [{ displayStatus: 'IN_TRANSIT', trackingInfo: [{ company: 'USPS', number: '9400111899220000000000', url: 'https://tools.usps.com/x/9400111899220000000000' }] }] }] } } };
      return { data: { orders: { nodes: [], pageInfo: { hasNextPage: false } } } };
    }
  });
  api.upsert(ALICE); api.upsert(BOB);
  const note = await api.noteFor({ from: 'Alice Smith <Alice.Smith@Example.COM>', subject: 'Where is my case?', text: 'Hi, just checking on my order.' });
  assert.match(note, new RegExp('^' + OI.NOTE_MATCH));
  assert.match(note, /#1001/);
  assert.match(note, /in transit/);
  assert.match(note, /9400111899220000000000/);
  assert.doesNotMatch(note, /#2002|Bob|813/);
  const none = await api.noteFor({ from: 'nobody@example.com', subject: 'Hi', text: 'Do you have a case?' });
  assert.strictEqual(none, OI.NOTE_NONE_EMAIL);
  const nonePhone = await api.noteFor({ from: 'nobody@example.com', subject: 'Hi', text: 'My number is 555-000-1111 in case you need it.' });
  assert.strictEqual(nonePhone, OI.NOTE_NONE_BOTH);
});

test('phone-only match is unverified: no order numbers, status or tracking (no cross-customer leak)', async () => {
  const { api } = index({
    adminQuery: async () => ({ data: { orders: { nodes: [{ name: '#2002', displayFulfillmentStatus: 'FULFILLED', fulfillments: [{ displayStatus: 'DELIVERED', trackingInfo: [{ company: 'UPS', number: '1Z999AA10123456784' }] }] }] } } })
  });
  api.upsert(ALICE); api.upsert(BOB);
  const note = await api.noteFor({ from: 'Eve Interloper <eve@example.com>', subject: 'Status?', text: 'Please look up 813-555-0202, that is a number I have.' });
  assert.strictEqual(note, OI.NOTE_UNVERIFIED_PHONE);
  assert.doesNotMatch(note, /#2002|1Z999|#1001|Bob|Alice|8135550202/);
  // Email match still wins and may include the sender's own phone in the body.
  const own = await api.noteFor({ from: 'bob@example.com', subject: 'Hi', text: 'This is Bob, 813-555-0202, where is order 2002?' });
  assert.match(own, /#2002/);
  assert.doesNotMatch(own, /#1001|Alice/);
});

test('flag off: no import, no webhook, no note, no behavior change', async () => {
  const { api } = index({ flag: false, adminQuery: async () => { throw new Error('should not query'); } });
  const imp = await api.importAll();
  assert.strictEqual(imp.skipped, true);
  const wh = api.ingestWebhook('{}', { 'x-shopify-hmac-sha256': 'x' });
  assert.strictEqual(wh.status, 404);
  const note = await api.noteFor({ from: 'alice.smith@example.com', subject: 'Hi', text: 'Where is my order?' });
  assert.strictEqual(note, null);
  assert.strictEqual(api.recordCount(), 0);
});

test('writer and checker receive the system note only when the flag is on', async () => {
  const MODELS = { models: [{ id: 'grok-4.7', aliases: [], prompt_text_token_price: 20000, cached_prompt_text_token_price: 5000, completion_text_token_price: 60000, output_modalities: ['text'] }] };
  function harness(flagOn) {
    const dir = tmp();
    const store = new MailboxStore({ file: path.join(dir, 'mailbox.json'), sealer: new Sealer(newKey()) });
    store.setSettings({ auto_send: false, daily_cap: 20 }, 'test');
    const messages = new Map(); const captured = [];
    const { api: orderIndex } = index({ dir, flag: flagOn });
    if (flagOn) { orderIndex.upsert(ALICE); orderIndex.save(); }
    const fetchImpl = async (url, opt = {}) => {
      if (String(url).includes('/v1/language-models')) return { ok: true, json: async () => MODELS };
      if (String(url).includes('/chat/completions')) {
        const b = JSON.parse(opt.body);
        let user = {}; try { user = JSON.parse(b.messages[1].content); } catch { user = {}; }
        captured.push({ sys: b.messages[0].content, user });
        const sys = b.messages[0].content;
        const out = /Classify/.test(sys) ? { folder: 'inbox', reason: 'q' } : /Independently review/.test(sys) ? { verdict: 'pass', main_question: 'q', answers_main_question: true, questions_asked: ['q'], unanswered: [], unasked_additions: [], notes: 'ok', improvements: [] } : { needs_reply: true, reason: 'ok', body: 'Hi Alice,\n\nThanks for writing.\n\nThe RF Safe team' };
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
  const on = harness(true);
  const m = { id: 'r.alice', subject: 'Order status', text: 'Where is my case?', from: 'Alice Smith <alice.smith@example.com>', created_at: new Date().toISOString(), folder: 'inbox' };
  on.messages.set(m.id, m); on.store.putCopy(m.id, m);
  await on.bots.wake('owner');
  for (let i = 0; i < 10; i++) { if (on.bots.pending) await on.bots.pending; await new Promise(r => setTimeout(r, 30)); if (!on.bots.running && !on.bots.again) break; }
  const writer = on.captured.find(c => c.user && c.user.message && !/Independently review/.test(c.sys) && !/Classify/.test(c.sys));
  const checker = on.captured.find(c => /Independently review/.test(c.sys));
  assert.ok(writer && writer.user.system_notes, JSON.stringify(on.captured.map(c => Object.keys(c.user || {}))));
  assert.match(writer.user.system_notes, /Orders on file for this sender\nThis email address matches these orders:\n- #1001/);
  assert.match(String(checker.user.system_notes || ''), /#1001/);

  const off = harness(false);
  off.messages.set(m.id, m); off.store.putCopy(m.id, m);
  await off.bots.wake('owner');
  for (let i = 0; i < 10; i++) { if (off.bots.pending) await off.bots.pending; await new Promise(r => setTimeout(r, 30)); if (!off.bots.running && !off.bots.again) break; }
  assert.ok(off.captured.length, 'flag-off pipeline still ran');
  assert.ok(off.captured.every(c => !c.user || !/Orders on file/.test(String(c.user.system_notes || ''))));
});

test('/health and public routes never expose the order index, even when the flag is on', async () => {
  const dataDir = tmp();
  const KB_KEY = 'test-sitemail-kb-key-0123456789';
  const deps = buildDeps({ mode: 'demo', env: { ...ENV, SITEMAIL_MOCK: '1', SITEMAIL_ORDER_INDEX: '1', SITEMAIL_KB_WRITE_HASH: crypto.createHash('sha256').update(KB_KEY).digest('hex'), SITEMAIL_ENC_KEY: crypto.randomBytes(32).toString('base64'), SITEMAIL_SESSION_SECRET: crypto.randomBytes(24).toString('base64'), MAIL_DOMAINS: 'callbots.org', RESEND_MAIL_READ_KEY: 're_test_host_reader', SITEMAIL_SHOPIFY_ORDERS_HMAC: 'test-hmac-secret' }, tenantsDir: path.join(__dirname, '../demo/tenants'), dataDir, log: () => {} });
  deps.tenants.save = () => {}; deps.mailFetch = require('../src/mail/mock').mockFetch();
  const app = createApp(deps); const srv = http.createServer(app.handler); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  try {
    const health = await (await fetch(base + '/health')).json();
    const blob = JSON.stringify(health);
    assert.equal(health.ok, true);
    assert.ok(!('order_index' in health));
    assert.ok(!health.sitemail || !('order_index' in health.sitemail));
    assert.ok(!health.sitemail || !health.sitemail.mailbox || !('order_index' in health.sitemail.mailbox));
    assert.doesNotMatch(blob, /alice|order-index|#1001|5550101/i);
    assert.equal((await fetch(base + '/kb')).status, 200);
    assert.equal((await fetch(base + '/api/mail/webhook/shopify/orders')).status, 404); // GET is not served
    const body = JSON.stringify({ name: '#1001', email: 'alice.smith@example.com', phone: '7275550101', customer: { firstName: 'Alice' } });
    const bad = await fetch(base + '/api/mail/webhook/shopify/orders', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Shopify-Hmac-Sha256': 'nope', 'X-Shopify-Topic': 'orders/create' }, body });
    assert.equal(bad.status, 401);
    const goodH = crypto.createHmac('sha256', 'test-hmac-secret').update(body).digest('base64');
    const good = await fetch(base + '/api/mail/webhook/shopify/orders', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Shopify-Hmac-Sha256': goodH, 'X-Shopify-Topic': 'orders/create' }, body });
    assert.equal(good.status, 200);
    const health2 = JSON.stringify(await (await fetch(base + '/health')).json());
    assert.doesNotMatch(health2, /alice\.smith@example\.com|#1001|7275550101/i);
  } finally { await new Promise(r => srv.close(r)); }
});

test('countOrders returns only a number from the count endpoint', async () => {
  const n = await OI.countOrders(async () => ({ data: { ordersCount: { count: 4242 } } }));
  assert.strictEqual(n, 4242);
});
