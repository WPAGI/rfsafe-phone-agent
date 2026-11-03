'use strict';
// Owner API (/api/owner/v1/*) for the Best Deal On Bot extension: one business per token, read-only, no secrets.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { startApp, ENV } = require('./helpers');
const TOK = 'bdo_7_' + 'a'.repeat(48); const OTHER = 'bdo_8_' + 'b'.repeat(48); const NOTOWNER = 'bdo_9_' + 'c'.repeat(48);
const EXT = 'chrome-extension://hheielialecldbibdenjkepdhdbnbmig';
function fakeBizinator(calls) {
  const toks = { [TOK]: '4155550123', [OTHER]: '7275550100', [NOTOWNER]: '4155550123' };
  return async (url, o) => { calls.push(url); const t = (o.headers.authorization || '').slice(7); const ph = toks[t];
    const r = (status, j) => ({ status, json: async () => j });
    if (!ph) return r(401, {});
    if (url.endsWith('/api/v1/me')) return r(200, { user_id: 1, token: { id: 7, kind: 'device', scopes: ['modules:read', 'modules:write'], phone: ph } });
    if (url.endsWith('/businesses/' + ph)) return t === NOTOWNER ? r(403, {}) : r(200, {});
    return r(404, {}); };
}
async function setup() {
  const a = await startApp(); const calls = [];
  a.deps.bizinatorFetch = fakeBizinator(calls);
  const [acme, rf] = a.deps.tenants.list().sort((x, y) => x.id.localeCompare(y.id));
  acme.bizinator_phone = '4155550123'; rf.bizinator_phone = '7275550100';
  const dir = path.dirname(a.deps.kbGapFile);
  a.deps.callRecords.add({ at: '2026-11-03T15:00:00Z', tenant: acme.id, caller: '+14155550199', seconds: 60, summary: 'hours', newsletter_optin: true, emails: [{ to_masked: 'j***@example.com', ok: true }] });
  a.deps.callRecords.add({ at: '2026-11-03T15:01:00Z', tenant: rf.id, caller: '+17275550111', seconds: 30, summary: 'RF secret call' });
  fs.appendFileSync(a.deps.kbGapFile, JSON.stringify({ at: '2026-11-03T15:00:00Z', tenant: acme.id, channel: 'voice', reason: 'no_answer', question: 'Do you sell cupcakes?' }) + '\n' + JSON.stringify({ at: '2026-11-03T15:00:00Z', tenant: rf.id, channel: 'voice', reason: 'no_answer', question: 'RF only' }) + '\n');
  a.deps.sentMessages.add({ channel: 'email', tenant: acme.id, to: 'owner@example.com', subject: 'New message for Acme', text: 'call me' });
  a.deps.sentMessages.add({ channel: 'email', tenant: rf.id, to: 'rf@example.com', subject: 'RF mail', text: 'x' });
  fs.appendFileSync(a.deps.newsletterFile, [
    { kind: 'link', tenant: acme.id, email: 'jane@example.com', phone: '+14155550199', at: '2026-11-03T15:00:00Z' },
    { kind: 'confirmed', tenant: acme.id, email: 'bob@example.com', name: 'Bob', at: '2026-11-03T15:02:00Z', ip: '1.2.3.4' },
    { kind: 'confirmed', tenant: rf.id, email: 'rfsub@example.com', at: '2026-11-03T15:02:00Z' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const get = async (p, tok = TOK, h = {}) => { const r = await fetch(a.base + '/api/owner/v1' + p, { headers: { ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...h } }); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {} return { r, j, text }; };
  return { ...a, acme, rf, get, calls };
}

test('stage 1: sign-in needs a Bizinator token that owns the mapped business', async () => {
  const s = await setup();
  try {
    assert.equal((await s.get('/status', null)).r.status, 401);
    assert.equal((await s.get('/status', 'bdo_1_zz')).r.status, 401);
    assert.equal((await s.get('/status', 'bdo_5_' + 'd'.repeat(48))).r.status, 401, 'unknown token');
    assert.equal((await s.get('/status', NOTOWNER)).r.status, 401, 'token phone matches but Bizinator says not owner');
    const { r, j } = await s.get('/status');
    assert.equal(r.status, 200); assert.equal(j.business.tenant, s.acme.id); assert.equal(j.channels.sms, false); assert.ok(Array.isArray(j.onboarding));
    const body = JSON.stringify(j);
    for (const k of ['twilio', 'xai', 'secrets', 'owner_pin', 'shopify', 'kb']) assert.ok(!(k in j.config), 'config leaked ' + k);
    for (const v of Object.values(ENV)) assert.ok(!body.includes(v), 'leaked a secret value');
    assert.ok(!/pin_hash|auth_token|whsec_/i.test(body));
    s.acme.bizinator_phone = null;
    s.deps.bizinatorFetch = fakeBizinator([]); assert.equal((await s.get('/status')).r.status, 404, 'no mapped tenant');
  } finally { await s.close(); }
});

test('stage 1: read-only, CORS only for the extension, results cached', async () => {
  const s = await setup();
  try {
    const p = await fetch(s.base + '/api/owner/v1/status', { method: 'POST', headers: { authorization: 'Bearer ' + TOK } });
    assert.equal(p.status, 405);
    const ok = await s.get('/status', TOK, { origin: EXT }); assert.equal(ok.r.headers.get('access-control-allow-origin'), EXT);
    const evil = await s.get('/status', TOK, { origin: 'https://evil.example' }); assert.equal(evil.r.headers.get('access-control-allow-origin'), null);
    const n = s.calls.length; await s.get('/status'); assert.equal(s.calls.length, n, 'second call uses cache');
    assert.ok(!JSON.stringify(s.logs).includes('a'.repeat(48)), 'token never logged');
  } finally { await s.close(); }
});

test('stage 2: subscribers and consent, scoped to one business, pending signups shown', async () => {
  const s = await setup();
  try {
    const { j } = await s.get('/subscribers');
    const emails = j.items.map((r) => r.email).sort(); assert.deepEqual(emails, ['bob@example.com', 'jane@example.com']);
    assert.equal(j.items.find((r) => r.email === 'jane@example.com').email_optin, 'pending');
    assert.equal(j.asked_on_calls.length, 1);
    assert.equal((await s.get('/subscribers?q=bob')).j.total, 1);
    const c = await s.get('/subscribers.csv'); assert.match(c.r.headers.get('content-type'), /text\/csv/); assert.ok(!c.text.includes('rfsub'));
    assert.ok(!(await s.get('/subscribers', OTHER)).text.includes('bob@'), 'other business cannot see it');
  } finally { await s.close(); }
});

test('stage 2: call log scoped and filterable', async () => {
  const s = await setup();
  try {
    const { j } = await s.get('/calls'); assert.equal(j.total, 1); assert.ok(!JSON.stringify(j).includes('RF secret'));
    assert.equal((await s.get('/calls?from=2026-11-04')).j.total, 0);
    assert.ok(!(await s.get('/calls.csv')).text.includes('RF secret'));
    assert.equal((await s.get('/calls', OTHER)).j.items[0].summary, 'RF secret call');
  } finally { await s.close(); }
});

test('stage 3+4: unanswered questions and sent emails scoped', async () => {
  const s = await setup();
  try {
    const g = await s.get('/kb-gaps'); assert.deepEqual(g.j.items.map((x) => x.question), ['Do you sell cupcakes?']); assert.equal(g.j.items[0].tenant, undefined);
    const m = await s.get('/messages?type=email'); assert.equal(m.j.total, 1); assert.equal(m.j.items[0].subject, 'New message for Acme');
    assert.equal((await s.get('/messages?type=email&id=' + m.j.items[0].id)).r.status, 200);
    const rfId = (await s.get('/messages?type=email', OTHER)).j.items[0].id;
    assert.equal((await s.get('/messages?type=email&id=' + rfId)).r.status, 404, 'cannot open another business message by id');
    assert.ok(!(await s.get('/messages.csv?type=email')).text.includes('RF mail'));
  } finally { await s.close(); }
});
