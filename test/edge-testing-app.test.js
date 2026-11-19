'use strict';
// Edge testing page on callbots.org (/admin/edge-testing, unified admin): existing admin session only, CSRF, nav and
// tile, rendering, a dry-run rerun over HTTP with zero outbound mail, run tags, grades and review. Mocks only.
const test = require('node:test'); const assert = require('node:assert');
const path = require('path'); const fs = require('fs'); const os = require('os'); const http = require('http'); const crypto = require('crypto');
const { ENV } = require('./helpers');
const BOTS = require('../vendor/sitemail/src/mailbox/bots'); const I = require('../vendor/sitemail/src/edgetest/importer');
const FIX = path.join(__dirname, 'fixtures/edge-tests');
const P = '/admin/edge-testing';

function mockAi(seen) {
  return async (url, opt = {}) => {
    seen.push({ url: String(url), method: String(opt.method || 'GET').toUpperCase() });
    if (String(url).includes('/v1/language-models')) return { ok: true, status: 200, json: async () => ({ models: [] }) };
    const b = JSON.parse(opt.body); const sys = b.messages[0].content; const q = b.messages[1].content;
    const out = /You compare two email replies/.test(sys) ? { grade: 'better', reason: 'Mock: adds the exact MagSafe text.' } : /Independently review/.test(sys) ? { verdict: 'pass', main_question: 'q', answers_main_question: true, questions_asked: ['q'], unanswered: [], unasked_additions: [], notes: 'ok (mock)', improvements: [] }
      : /Classify/.test(sys) ? { folder: 'inbox', reason: 'customer' } : { needs_reply: true, reason: 'mock', body: 'Hi there,\n\n' + (/charging/i.test(q) ? BOTS.MAGSAFE_TEXT : 'Mock reply.') + '\n\nThe RF Safe team' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(out) } }], usage: { prompt_tokens: 50, completion_tokens: 20 } }) };
  };
}
async function start({ seedFile = null, extra = {} } = {}) {
  const { buildDeps } = require('../src/runtime'); const { createApp } = require('../src/app');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-t-edgecb-'));
  const env = { ...ENV, SITEMAIL_MOCK: '1', SITEMAIL_KB_WRITE_HASH: crypto.createHash('sha256').update('edge-kb-key-0123456789').digest('hex'), SITEMAIL_ENC_KEY: crypto.randomBytes(32).toString('base64'), SITEMAIL_SESSION_SECRET: crypto.randomBytes(24).toString('base64'), MAIL_DOMAINS: 'callbots.org', RESEND_MAIL_READ_KEY: 're_test_host_reader', XAI_API_KEY: 'xai-test-not-real', ...extra };
  const deps = buildDeps({ mode: 'demo', env, tenantsDir: path.join(__dirname, '../demo/tenants'), dataDir, log: () => {} });
  deps.tenants.save = () => {};
  const mailCalls = []; const mf = require('../src/mail/mock').mockFetch();
  deps.mailFetch = async (u, o) => { mailCalls.push({ url: String(u), method: (o && o.method) || 'GET' }); return mf(u, o); };
  const seen = []; deps.edgeFetch = mockAi(seen); deps.edgeProducts = async () => []; deps.edgeSeedFile = seedFile;
  const app = createApp(deps); const srv = http.createServer(app.handler); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port; deps.publicBaseUrl = base;
  const sess = deps.adminAuth.newSession(); const csrf = deps.adminAuth.csrfFor(sess.split('.')[0]);
  const get = (p, h = {}) => fetch(base + p, { redirect: 'manual', headers: { cookie: 'pa_admin=' + sess, accept: 'text/html', ...h } });
  const post = (p, form, h = {}) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { cookie: 'pa_admin=' + sess, 'content-type': 'application/x-www-form-urlencoded', ...h }, body: new URLSearchParams(form) });
  return { app, deps, base, dataDir, csrf, get, post, seen, mailCalls, close: () => new Promise((r) => srv.close(r)) };
}
async function waitIdle(a) { for (let i = 0; i < 200; i++) { const j = await (await a.get(P + '/status.json', { accept: 'application/json' })).json(); if (!j.running) return j; await new Promise(r => setTimeout(r, 100)); } throw new Error('run did not finish'); }

test('edge testing (callbots): 401/303 without a session; tile + left nav; seeded list; product version in /health and footer', async () => {
  const a = await start({ seedFile: path.join(__dirname, '../seeds/edge-tests/callbots.org.json') });
  try {
    assert.strictEqual((await fetch(a.base + P, { headers: { accept: 'application/json' } })).status, 401);
    assert.strictEqual((await fetch(a.base + P + '/status.json')).status, 401);
    assert.strictEqual((await fetch(a.base + P + '/run', { method: 'POST', body: 'csrf=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 401);
    const red = await fetch(a.base + P, { redirect: 'manual', headers: { accept: 'text/html' } }); assert.strictEqual(red.status, 303); assert.strictEqual(red.headers.get('location'), '/admin/login');
    const r = await a.get(P); assert.strictEqual(r.status, 200); const t = await r.text();
    assert.match(t, /<a class="nb on" href="\/admin\/edge-testing" aria-current="page">/); assert.match(t, /<h1>Edge testing<\/h1>/);
    assert.match(t, /callbots\.org · product version <b>1\.1\.0<\/b>/); assert.match(t, /22 saved tests/); assert.match(t, /1\.0\.0 run 1, prompts 1\.9\.27/);
    assert.match(t, /@media \(max-width:980px\)\{\.et-sbs\{grid-template-columns:1fr\}/); assert.match(t, /Product version 1\.1\.0/); assert.ok(!/<script/i.test(t));
    const home = await (await a.get('/admin')).text(); assert.match(home, /<a class="tile" href="\/admin\/edge-testing">[^]*?Edge testing<\/span><\/a>/); assert.match(home, /Product version 1\.1\.0/);
    assert.strictEqual((await (await fetch(a.base + '/health')).json()).product_version, '1.1.0');
  } finally { await a.close(); fs.rmSync(a.dataDir, { recursive: true, force: true }); }
});

test('edge testing (callbots): rerun dry run over HTTP, no mail writes, side by side, grade and review', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-t-edgecbseed-')); const seedFile = path.join(dir, 'seed.json');
  fs.writeFileSync(seedFile, JSON.stringify(I.loadDir(FIX).records.filter(r => r.site === 'callbots.org')));
  const a = await start({ seedFile });
  try {
    assert.strictEqual((await a.post(P + '/run', { csrf: 'wrong' })).status, 403);
    const before = a.mailCalls.filter(c => c.method !== 'GET').length;
    const r1 = await a.post(P + '/run', { csrf: a.csrf }); assert.match(decodeURIComponent(r1.headers.get('location')), /Rerun started: 1\.1\.0 run 1/);
    const r2 = await a.post(P + '/run', { csrf: a.csrf }); assert.match(decodeURIComponent(r2.headers.get('location')), /already in progress/);
    await waitIdle(a);
    const runId = I.runId('callbots.org', '1.1.0', 1); const run = a.app.edge.store.run(runId); assert.strictEqual(run.status, 'done'); assert.strictEqual(run.done, 1);
    assert.strictEqual(a.mailCalls.filter(c => c.method !== 'GET').length, before, 'no mail API writes');
    assert.ok(a.seen.length && a.seen.every(x => new URL(x.url).hostname === 'api.x.ai'));
    const d = await (await a.get(P + '?test=r.fx-cb')).text();
    assert.match(d, /Does the case work with wireless charging\?/); assert.match(d, /class="et-sbs"/); assert.match(d, /Agent: better/); assert.match(d, /Would send/);
    await a.post(P + '/review', { csrf: a.csrf, test: 'r.fx-cb', run: runId, verdict: 'pass', note: 'Exact text' });
    assert.match(await (await a.get(P + '?test=r.fx-cb')).text(), /Human pass/);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(a.dataDir, 'edge-testing', 'callbots.org.json'), 'utf8')).reviews['r.fx-cb|' + runId].note, 'Exact text');
  } finally { await a.close(); fs.rmSync(a.dataDir, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('edge testing (callbots): Mailbox package off -> page explains, no tile', async () => {
  const a = await start({ extra: { SITEMAIL_ENABLED: '0' } });
  try {
    const r = await a.get(P); assert.strictEqual(r.status, 404); assert.match(await r.text(), /Edge testing is off/);
    assert.doesNotMatch(await (await a.get('/admin')).text(), /href="\/admin\/edge-testing"/);
  } finally { await a.close(); fs.rmSync(a.dataDir, { recursive: true, force: true }); }
});
