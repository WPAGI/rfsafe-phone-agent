'use strict';
// Edge testing core (John, Nov 17, 2026, 10:36 PM ET, relayed by Jarvis; build-only). Mocks only: no network, no
// real email, no real keys. Fixture data is invented (test/fixtures/edge-tests).
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
// Host settings (this file is shared with WPAGI/rfsafe-phone-agent, where BASE is vendor/sitemail/src).
const BASE = path.join(__dirname, '../vendor/sitemail/src'); const SEED_SITE = 'callbots.org'; const SEED_COUNT = 22;
// The invented fixture is mostly rfsafe.app records (3) plus one callbots.org record.
const SITE = 'rfsafe.app'; const OTHER = 'callbots.org';
const SEED = path.join(__dirname, '../seeds/edge-tests', SEED_SITE + '.json');
const M = (p) => require(path.join(BASE, p));
const PII = M('edgetest/pii'); const I = M('edgetest/importer'); const R = M('edgetest/runner'); const G = M('edgetest/grade');
const { EdgeStore, runLabel } = M('edgetest/store'); const { createEdgeTesting, DAILY_CAP_USD } = M('edgetest');
const { MailBots } = M('mailbox/bots'); const { MailboxStore } = M('mailbox/store'); const { Sealer, newKey } = M('mailbox/crypto');
const FIX = path.join(__dirname, 'fixtures/edge-tests');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pa-t-edge-'));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const passGrade = () => ({ verdict: 'pass', main_question: 'q', answers_main_question: true, questions_asked: ['q'], unanswered: [], unasked_additions: [], notes: 'ok (mock)', improvements: [] });

// Mock xAI: sorter -> inbox, writer -> a reply, checker -> pass, grader -> worse. Records every URL it is asked for.
const BOTS = M('mailbox/bots');
const smartWriter = (user) => { const q = JSON.stringify(user.message || user.original || user); return 'Hi there,\n\n' + (/deal/i.test(q) ? BOTS.DEAL_ANSWER : /signal/i.test(q) ? BOTS.SIGNAL_HEDGE : 'Mock reply: please reply with the name, email and phone used on the order.') + '\n\nMock reply.\n\nThe RF Safe team'; };
function mockAi({ writer = smartWriter, grade = { grade: 'worse', reason: 'Mock: dropped the hedge.' }, ticks = 0, seen = [] } = {}) {
  const f = async (url, opt = {}) => {
    seen.push({ url: String(url), method: String(opt.method || 'GET').toUpperCase() });
    const u = String(url);
    if (u.includes('/v1/language-models') || u.includes('/v1/models')) return { ok: true, status: 200, json: async () => ({ models: [] }) };
    if (u.includes('/chat/completions')) {
      const b = JSON.parse(opt.body); const sys = b.messages[0].content; let user = {}; try { user = JSON.parse(b.messages[1].content); } catch { user = {}; }
      const out = /You compare two email replies/.test(sys) ? grade : /Independently review/.test(sys) ? passGrade() : /Classify/.test(sys) ? { folder: 'inbox', reason: 'customer question' } : { needs_reply: true, reason: 'mock', body: writer(user, sys) };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(out) } }], usage: { prompt_tokens: 50, completion_tokens: 20, ...(ticks ? { cost_in_usd_ticks: ticks } : {}) } }) };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  f.seen = seen; return f;
}
// A "live" Mailbox the edge runner must never touch: its own store file, send spy and draft spy.
function liveMailbox(dir) {
  const file = path.join(dir, 'live-mailbox.json');
  const store = new MailboxStore({ file, sealer: new Sealer(newKey()) });
  store.setSettings({ auto_send: true, daily_cap: 20 }, 'test');
  store.putCopy('r.real-thread', { id: 'r.real-thread', subject: 'Real thread', text: 'A live thread that must not change', from: 'pat@sample.example', created_at: new Date().toISOString(), folder: 'inbox' });
  const spies = { send: 0, draft: 0 };
  const bots = new MailBots({ store, env: { XAI_API_KEY: 'xai-test-not-real' }, fetchImpl: async () => { throw new Error('live fetch must not be used'); }, tools: { state: () => ({}), kbUrls: () => [], kbVersion: () => 'x', entryBySlug: () => null, connectedForOrders: () => true, action: async () => { throw new Error('live tools must not be used'); } },
    received: async () => [], original: async () => null, ownDomains: ['rfsafe.app'], createDraft: async () => { spies.draft++; return { code: 201, body: {} }; }, autoSend: async () => { spies.send++; return { auto: true }; }, hostOrderQuery: async () => { throw new Error('order lookup must not be used'); } });
  store.save();
  return { file, store, bots, spies };
}
const kbStub = { search: (q) => [{ title: 'Deal policy', text: "We don't offer coupon codes or other discounts; check back during holiday sales.", source: 'https://rfsafe.app/kb/deal' }], urls: () => ['https://rfsafe.app/kb/deal'], version: () => 'kb-test', entryBySlug: () => null };
function edgeFor(dir, over = {}) {
  const live = over.live || liveMailbox(dir);
  const fetchImpl = over.fetchImpl || mockAi();
  const edge = createEdgeTesting({ site: SITE, file: path.join(dir, 'edge.json'), productVersion: () => over.version || '1.0.0', env: { XAI_API_KEY: 'xai-test-not-real' }, fetchImpl, products: over.products || (async () => []), tmpRoot: dir, maxMsPerTest: 20000,
    dailyCapUsd: over.cap, seedFile: over.seedFile, live: { bots: () => live.bots, kb: () => ({ kb: kbStub, kbUrls: () => kbStub.urls(), kbVersion: () => kbStub.version(), entryBySlug: () => null }), ownDomains: ['rfsafe.app'] } });
  return { edge, live, fetchImpl };
}

test('product version: VERSION is the one source (semver 1.0.0), package.json matches, README documents the bump rules', () => {
  const V = require(path.join(__dirname, '../src/version'));
  assert.strictEqual(V.PRODUCT_VERSION, '1.0.0');
  assert.match(fs.readFileSync(V.FILE, 'utf8'), /^\d+\.\d+\.\d+\n?$/);
  assert.strictEqual(require('../package.json').version, V.PRODUCT_VERSION, 'package.json version mirrors VERSION');
  const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
  assert.match(readme, /## Product version/); assert.match(readme, /patch/i); assert.match(readme, /minor/i); assert.match(readme, /major stays 1/i); assert.match(readme, /prompt version/i);
  const d = tmp(); fs.writeFileSync(path.join(d, 'VERSION'), 'v1.0'); assert.throws(() => V.read(path.join(d, 'VERSION')), /semver/);
  assert.notStrictEqual(V.PRODUCT_VERSION, M('mailbox/bot-defaults').defaults.replier.version, 'the prompt version is not the product version');
  fs.rmSync(d, { recursive: true, force: true });
});

test('PII: emails, phones, street addresses, tracking and non-test order numbers are redacted; test/business values are kept', () => {
  const s = "Order #1042 for jane.fixture@madeup-mail.net, (727) 555-2368, 42 Maple Grove Drive. Track 9400100000000000000042. Test order #1173. bestdealon@mail.grokbot.com, info@rfsafe.app. RF Safe, 100 Main Street, Seminole, FL 33772. https://quantacase.com/products/x?variant=55123456789014 555-555-0123";
  const r = PII.redact(s);
  for (const bad of ['1042', 'jane.fixture', '555-2368', 'Maple Grove', '9400100000000000000042']) assert.ok(!r.text.includes(bad), bad);
  for (const keep of ['#1173', 'bestdealon@mail.grokbot.com', 'info@rfsafe.app', '100 Main Street, Seminole, FL 33772', 'variant=55123456789014', '555-555-0123']) assert.ok(r.text.includes(keep), keep);
  assert.deepStrictEqual(r.counts, { email: 1, phone: 1, address: 1, tracking: 1, order: 1 });
  assert.strictEqual(PII.scan(r.text).length, 0, 'nothing left after redaction');
  const f = PII.scan('call 727-555-2368'); assert.strictEqual(f[0].kind, 'phone'); assert.ok(!f[0].preview.includes('555-2368'), 'previews are masked');
});

test('importer: library format, site split, PII redaction, refuses non-test senders, unknown prompt version, idempotent', () => {
  const d = tmp(); const { records, errors } = I.loadDir(FIX);
  assert.strictEqual(errors.length, 0); assert.strictEqual(records.length, 5, 'index.json is the manifest, not a record');
  const s = new EdgeStore({ file: path.join(d, 'e.json') });
  const c = I.importRecords(s, records, { site: SITE });
  assert.strictEqual(c.added, 3); assert.strictEqual(c.skipped_other_site, 1); assert.strictEqual(c.refused.length, 1);
  assert.deepStrictEqual(c.refused[0], { id: 'r.fx-real-sender', reasons: ['sender_is_not_a_test_address'] });
  const pii = s.test('r.fx-pii'); const res = s.result(I.runId(SITE, '1.0.0', 1), 'r.fx-pii');
  for (const bad of ['1042', 'Maple Grove', '555-2368', 'jane.fixture', '9400100000000000000042']) { assert.ok(!JSON.stringify(pii).includes(bad), bad); assert.ok(!JSON.stringify(res).includes(bad), bad); }
  assert.ok(pii.question.includes('#1173'), 'the test order stays');
  assert.ok(res.reply.includes('variant=55123456789014'), 'store product links stay');
  const run = s.run(I.runId(SITE, '1.0.0', 1));
  assert.strictEqual(run.kind, 'import'); assert.ok(run.is_baseline); assert.strictEqual(run.total, 3);
  assert.strictEqual(s.result(run.id, 'r.fx-noprompt').prompt_version, 'unknown', 'missing prompt version is stored as unknown, not guessed');
  assert.strictEqual(s.result(run.id, 'r.fx-deal').prompt_version, '1.9.27');
  assert.strictEqual(run.prompt_version, 'mixed', 'run label does not claim one prompt version when some are unknown');
  const again = I.importRecords(new EdgeStore({ file: path.join(d, 'e.json') }), records, { site: SITE });
  assert.strictEqual(again.added + again.updated, 0); assert.strictEqual(again.unchanged, 3); assert.strictEqual(again.results_unchanged, 3); assert.strictEqual(again.runs_added, 0);
  const other = I.importRecords(new EdgeStore({ file: path.join(d, 'o.json') }), records, { site: OTHER });
  assert.strictEqual(other.added, 1); assert.strictEqual(other.skipped_other_site, 3);
  assert.strictEqual(I.normalize({ site: SITE, subject: 'x' }).reasons[0], 'missing_question');
  assert.strictEqual(I.normalize({ site: 'not a site', question: 'x' }).reasons[0], 'unknown_site');
  assert.strictEqual(I.siteOf('https://www.RFsafe.app/'), 'rfsafe.app');
  assert.ok(I.normalize({ site: SITE, question: 'q', runs: [{ run_number: 1, reply_text: 'r' }] }).runErrors.length === 1, 'a run without a product version is not invented');
  fs.rmSync(d, { recursive: true, force: true });
});

test(`shipped seed: ${SEED_COUNT} ${SEED_SITE} tests, PII-free on re-scan, tagged 1.0.0 run 1 baseline, imports idempotently`, () => {
  const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  assert.strictEqual(seed.length, SEED_COUNT); assert.ok(seed.every(r => r.site === SEED_SITE));
  const scan = require(path.join(__dirname, '../scripts/edge-seed')).scanRecords(seed); assert.deepStrictEqual(scan, [], 'no PII left in the shipped seed');
  assert.ok(seed.every(r => !r.from || /@(mail\.grokbot\.com|example\.com)$/.test(r.from)), 'test sender only (our test mailbox or reserved example.com)');
  const d = tmp(); const s = new EdgeStore({ file: path.join(d, 'e.json') });
  const c = I.importRecords(s, seed, { site: SEED_SITE }); assert.strictEqual(c.added, SEED_COUNT); assert.strictEqual(c.refused.length, 0);
  const run = s.baseline(SEED_SITE); assert.strictEqual(runLabel(run).startsWith('1.0.0 run 1, prompts '), true); assert.strictEqual(run.total, SEED_COUNT);
  assert.strictEqual(I.importRecords(s, seed, { site: SEED_SITE }).unchanged, SEED_COUNT);
  fs.rmSync(d, { recursive: true, force: true });
});

test('guardFetch: only xAI and public storefront GETs pass; mail APIs, Shopify Admin, store POSTs and tokens are refused', async () => {
  const calls = []; const real = async (u, o) => { calls.push(u); return { ok: true, status: 200, json: async () => ({}) }; };
  const blocked = []; const f = R.guardFetch(real, blocked);
  for (const [u, o] of [['https://api.resend.com/emails', { method: 'POST' }], ['https://api.resend.com/emails', {}], ['https://rf-safe.myshopify.com/admin/api/2025-01/graphql.json', { method: 'POST' }],
    ['https://quantacase.com/cart/add.js', { method: 'POST' }], ['https://quantacase.com/products/x.js', { method: 'POST' }], ['https://quantacase.com/products/x.js', { headers: { 'X-Shopify-Access-Token': 'shpat_fake' } }],
    ['https://quantacase.com/admin/orders.json', {}], ['http://api.x.ai/v1/chat/completions', { method: 'POST' }], ['https://evil.example/v1/chat/completions', { method: 'POST' }], ['https://api.twilio.com/2010-04-01/Accounts', { method: 'POST' }]]) {
    const r = await f(u, o); assert.strictEqual(r.ok, false, u); assert.strictEqual(r.status, 451, u);
  }
  assert.strictEqual(calls.length, 0, 'nothing refused reached the network'); assert.strictEqual(blocked.length, 10);
  for (const [u, o] of [['https://api.x.ai/v1/chat/completions', { method: 'POST' }], ['https://api.x.ai/v1/language-models', {}], ['https://quantacase.com/products/apple-iphone-17.js', {}], ['https://quantacase.com/search/suggest.json?q=s24', {}]]) assert.ok((await f(u, o)).ok, u);
  assert.strictEqual(calls.length, 4);
  const tools = R.edgeTools({ kb: kbStub, products: async () => [] });
  assert.strictEqual(tools.connectedForOrders(), false);
  for (const a of ['order_status', 'inventory']) await assert.rejects(tools.action('replier', 'shopify', a, { order: '1173', email: 'x@example.com' }), /blocked_by_edge_dry_run/);
});

test('dry run through the real pipeline: would-send recorded, zero real sends, live store and threads untouched, no mail or Shopify HTTP', async () => {
  const d = tmp(); const seen = []; const fetchImpl = mockAi({ seen });
  const { edge, live } = edgeFor(d, { fetchImpl });
  I.importRecords(edge.store, I.loadDir(FIX).records, { site: SITE });
  const before = sha(live.file); const liveDb = JSON.stringify(live.store.db);
  const r = edge.start({ who: 'test' }); assert.strictEqual(r.code, 202);
  assert.strictEqual(r.run.id, I.runId(SITE, '1.0.0', 2), 'the first rerun after the 1.0.0 run 1 baseline is 1.0.0 run 2');
  assert.strictEqual(edge.start().code, 409, 'a second start while running is refused');
  assert.strictEqual(edge.status().running, true);
  await edge.idle();
  const run = edge.store.run(r.run.id);
  assert.strictEqual(run.status, 'done'); assert.strictEqual(run.done, 3);
  assert.strictEqual(run.prompt_version, M('mailbox/bot-defaults').defaults.replier.version);
  assert.match(runLabel(run), /^1\.0\.0 run 2, prompts \d+\.\d+\.\d+$/);
  for (const id of ['r.fx-deal', 'r.fx-pii', 'r.fx-noprompt']) { const x = edge.store.result(run.id, id); assert.strictEqual(x.disposition, 'would_send', id + ' ' + JSON.stringify(x.steps)); assert.match(x.reply, /Mock reply/); assert.strictEqual(x.checker_verdict, 'pass'); }
  assert.strictEqual(live.spies.send, 0, 'the real send function was never called'); assert.strictEqual(live.spies.draft, 0, 'no real draft');
  assert.strictEqual(sha(live.file), before, 'live mailbox file unchanged'); assert.strictEqual(JSON.stringify(live.store.db), liveDb, 'live threads, drafts and sent log unchanged');
  assert.ok(seen.length > 0); assert.ok(seen.every(x => new URL(x.url).hostname === 'api.x.ai'), 'only the model API was called: ' + [...new Set(seen.map(x => new URL(x.url).hostname))]);
  assert.ok(!seen.some(x => /resend|myshopify|twilio/.test(x.url)));
  assert.ok(!fs.readdirSync(d).some(n => n.startsWith('edge-run-')), 'per-test temp stores are deleted');
  // Agent grade vs the baseline ran after the suite and is stored per comparison.
  const g = edge.store.grade('r.fx-deal', I.runId(SITE, '1.0.0', 1), run.id); assert.strictEqual(g.grade, 'worse'); assert.match(g.reason, /hedge/);
  const r3 = edge.start(); assert.strictEqual(r3.run.run_number, 3, 'run numbers tick on the same product version'); await edge.idle();
  fs.rmSync(d, { recursive: true, force: true });
});

test('dry run uses saved Custom prompt layers as they are, read-only, and labels the run with them', async () => {
  const d = tmp(); const live = liveMailbox(d);
  live.bots.copy('replier'); live.bots.db.installed.replier.custom.prompt += '\nEDGE-CUSTOM-MARKER'; live.store.save(); const before = sha(live.file);
  const seenSys = []; const f = mockAi({ writer: (u, sys) => { seenSys.push(sys); return 'Hi there,\n\nCustom reply.\n\nThe RF Safe team'; } });
  const { edge } = edgeFor(d, { live, fetchImpl: f });
  I.importRecords(edge.store, [JSON.parse(fs.readFileSync(path.join(FIX, SITE, 'r.fx-deal.json'), 'utf8'))], { site: SITE });
  const r = edge.start(); await edge.idle();
  assert.ok(seenSys.some(s => s.includes('EDGE-CUSTOM-MARKER')), 'the custom writer prompt was used');
  assert.match(edge.store.run(r.run.id).prompt_version, /\(custom replier\)$/);
  assert.strictEqual(sha(live.file), before, 'the saved custom prompt was not changed');
  fs.rmSync(d, { recursive: true, force: true });
});

test('cost cap: separate daily edge cap; refuses a run over the estimate; stops mid-run when spent', async () => {
  assert.ok(DAILY_CAP_USD > 0 && DAILY_CAP_USD <= 20);
  const d = tmp(); const { edge } = edgeFor(d, { cap: 0.01 });
  I.importRecords(edge.store, I.loadDir(FIX).records, { site: SITE });
  assert.strictEqual(edge.start().code, 409); assert.strictEqual(edge.start().error, 'daily_edge_cap');
  const d2 = tmp(); const { edge: e2 } = edgeFor(d2, { cap: 0.6, fetchImpl: mockAi({ ticks: 1e9 }) }); // $0.10 per model call
  I.importRecords(e2.store, I.loadDir(FIX).records, { site: SITE });
  const r = e2.start(); assert.strictEqual(r.code, 202); await e2.idle();
  const run = e2.store.run(r.run.id);
  assert.strictEqual(run.status, 'stopped_cost_cap');
  const disp = ['r.fx-deal', 'r.fx-noprompt', 'r.fx-pii'].map(id => e2.store.result(run.id, id).disposition);
  assert.ok(disp.includes('skipped_cost_cap'), disp.join());
  assert.ok(e2.store.spentToday() <= 0.6 + 1e-9, 'spend stays within the cap: ' + e2.store.spentToday());
  fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(d2, { recursive: true, force: true });
});

test('agent grade: comparison prompt, better/same/worse only, reason trimmed; unreadable output is an error', async () => {
  const t = { subject: 'Two cases', question: 'Is there a deal?', expected: 'Deal line only' };
  const a = { disposition: 'sent', reply: 'A', checker_verdict: 'pass' }, b = { disposition: 'would_send', reply: 'B', checker_verdict: 'pass' };
  let body = null; const f = async (u, o) => { body = JSON.parse(o.body); return { ok: true, json: async () => ({ choices: [{ message: { content: '{"grade":"Better","reason":"' + 'x'.repeat(400) + '"}' } }], usage: { prompt_tokens: 1000, completion_tokens: 50 } }) }; };
  const g = await G.gradePair({ fetchImpl: f, key: 'xai-test-not-real', model: 'grok-test', test: t, a, b, aLabel: '1.0.0 run 1', bLabel: '1.0.0 run 2' });
  assert.strictEqual(g.grade, 'better'); assert.ok(g.reason.length <= 240); assert.ok(g.cost_usd > 0);
  assert.match(body.messages[0].content, /You compare two email replies/); const u = JSON.parse(body.messages[1].content);
  assert.strictEqual(u.reply_a.run, '1.0.0 run 1'); assert.strictEqual(u.reply_b.reply, 'B'); assert.strictEqual(u.expected_behavior, 'Deal line only');
  await assert.rejects(G.gradePair({ fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"grade":"great"}' } }] }) }), key: 'k', model: 'm', test: t, a, b }), /grade_unreadable/);
});

test('human review persists (pass/fail + note) and a restart marks an unfinished run interrupted', () => {
  const d = tmp(); const file = path.join(d, 'e.json'); const s = new EdgeStore({ file });
  I.importRecords(s, I.loadDir(FIX).records, { site: SITE });
  const run = s.baseline(SITE).id;
  s.setReview('r.fx-deal', run, { verdict: 'fail', note: 'Too long', who: 'test' }); s.save();
  assert.throws(() => s.setReview('r.fx-deal', run, { verdict: 'maybe' }), /pass_or_fail/);
  const s2 = new EdgeStore({ file }); assert.strictEqual(s2.review('r.fx-deal', run).verdict, 'fail'); assert.strictEqual(s2.review('r.fx-deal', run).note, 'Too long');
  s2.putRun({ id: 'run.x', site: SITE, kind: 'dry_run', product_version: '1.0.0', run_number: 9, status: 'running' }); s2.save();
  const { edge } = edgeFor(d, {}); // same file? no: edgeFor uses edge.json; use the store directly
  const e = createEdgeTesting({ site: SITE, file, productVersion: () => '1.0.0', env: {}, live: {} });
  assert.strictEqual(e.store.run('run.x').status, 'interrupted'); assert.strictEqual(e.status().running, false); void edge;
  fs.rmSync(d, { recursive: true, force: true });
});
