'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { startApp } = require('./helpers');

const cookieOf = (r, name) => { const m = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(name + '=')); return m ? m.slice(name.length + 1) : null; };
const csrfIn = (html) => (html.match(/name="csrf" value="([^"]*)"/) || [])[1];
const post = (base, p, form, cookie) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(form).toString() });
async function signIn(a) {
  const g0 = await fetch(a.base + '/admin/login'); const c0 = cookieOf(g0, 'pa_csrf');
  await post(a.base, '/admin/login', { csrf: csrfIn(await g0.text()) }, 'pa_csrf=' + c0);
  const sent = a.deps.emailFor(null).sent; const link = sent[sent.length - 1].text.match(/https?:\/\/\S+\/admin\/auth#t=\S+/)[0];
  const g = await fetch(link.replace(/^https?:\/\/[^/]+/, a.base)); const html = await g.text(); const c = cookieOf(g, 'pa_csrf');
  const p = await post(a.base, '/admin/auth', { csrf: csrfIn(html), t: new URL(link).hash.slice(3) }, 'pa_csrf=' + c);
  return 'pa_admin=' + cookieOf(p, 'pa_admin');
}
const KATIE = '+17276101188';
async function setup() {
  const a = await startApp(); const t = a.deps.tenants.list()[0];
  t.known_callers = { ...(t.known_callers || {}), [KATIE]: { name: 'Katie', role: 'administrator' } };
  t.owner_briefing = { enabled: true, owner_numbers: [KATIE] };
  const cookie = await signIn(a);
  const page = async (q = '') => { const r = await fetch(a.base + '/admin/outbound?t=' + t.id + q, { headers: { cookie } }); return { r, html: await r.text() }; };
  return { a, t, cookie, page };
}

test('outbound page requires an admin session (no bearer, no anonymous)', async () => {
  const a = await startApp();
  try {
    assert.strictEqual((await fetch(a.base + '/admin/outbound')).status, 401);
    assert.strictEqual((await fetch(a.base + '/admin/outbound', { headers: { accept: 'text/html' }, redirect: 'manual' })).status, 303);
    assert.strictEqual((await fetch(a.base + '/admin/outbound', { headers: { authorization: 'Bearer demo-admin-token-EXAMPLE' } })).status, 401);
    assert.strictEqual((await post(a.base, '/admin/outbound/pin', { pin: '1234', pin_confirm: '1234' })).status, 401);
    const dash = await (await fetch(a.base + '/admin', { headers: { cookie: await signIn(a) } })).text(); assert.match(dash, /href="\/admin\/outbound"/);
  } finally { await a.close(); }
});

test('PIN: confirm must match, is never echoed (nor its hash), change is audited; CSRF required', async () => {
  const { a, t, cookie, page } = await setup();
  try {
    let { html } = await page(); const csrf = csrfIn(html); assert.match(html, /PIN <b>not set<\/b>/);
    assert.strictEqual((await post(a.base, '/admin/outbound/pin', { t: t.id, pin: '8317', pin_confirm: '8317' }, cookie)).status, 403);
    let r = await post(a.base, '/admin/outbound/pin', { csrf, t: t.id, pin: '8317', pin_confirm: '8318' }, cookie); assert.match(r.headers.get('location'), /did%20not%20match/);
    assert.ok(!a.app.owner.pins.has(t.id));
    r = await post(a.base, '/admin/outbound/pin', { csrf, t: t.id, pin: '8317', pin_confirm: '8317' }, cookie); assert.strictEqual(r.status, 303);
    assert.ok(a.app.owner.pins.verify(t.id, '8317', '2026-10-29').ok);
    r = await post(a.base, '/admin/outbound/pin', { csrf, t: t.id, pin: '4455', pin_confirm: '4455' }, cookie);
    ({ html } = await page('&' + r.headers.get('location').split('&').slice(1).join('&')));
    assert.match(html, /PIN saved/); assert.match(html, /pin_changed/); assert.match(html, /pin_set/);
    assert.doesNotMatch(html, /8317|4455|scrypt|\$s/);
    const pinFile = fs.readFileSync(a.app.owner.files.pins, 'utf8'); const hashish = (pinFile.match(/[A-Za-z0-9+/=]{20,}/g) || []);
    for (const h of hashish) assert.ok(!html.includes(h), 'hash material must not be rendered');
    const auditRaw = fs.readFileSync(a.app.owner.files.audit, 'utf8'); assert.doesNotMatch(auditRaw, /8317|4455/);
    assert.ok(!a.logs.some((l) => JSON.stringify(l).includes('4455')));
  } finally { await a.close(); }
});

test('shows unanswered questions (with date picker), preview, saves settings, test call needs confirm', async () => {
  const { a, t, cookie, page } = await setup();
  try {
    fs.appendFileSync(a.deps.kbGapFile, JSON.stringify({ at: '2026-10-29T13:10:00Z', tenant: t.id, question: 'Do you ship to Canada', reason: 'model_unanswered', channel: 'sms', call: 'x1' }) + '\n' + JSON.stringify({ at: '2026-10-28T13:10:00Z', tenant: t.id, question: 'Old one', reason: 'model_unanswered', channel: 'voice' }) + '\n');
    let { html } = await page(); const csrf = csrfIn(html);
    assert.match(html, /Do you ship to Canada<\/td><td>text<\/td><td>9:10 AM EDT/); assert.doesNotMatch(html, /Old one/);
    assert.match(html, /One question we couldn&#39;t answer: Do you ship to Canada/);
    ({ html } = await page('&date=2026-10-28')); assert.match(html, /Old one/);
    let r = await post(a.base, '/admin/outbound/settings', { csrf, t: t.id, enabled: 'on', daily_call: 'on', daily_time: '17:30', owner_numbers: '7276101188', voice: 'twilio', quiet_start: '22:00', quiet_end: '07:00', copy_email: 'on' }, cookie);
    assert.strictEqual(r.status, 303); assert.strictEqual(t.owner_briefing.daily_time, '17:30'); assert.deepStrictEqual(t.owner_briefing.owner_numbers, [KATIE]); assert.strictEqual(t.owner_briefing.voice, 'twilio'); assert.strictEqual(t.owner_briefing.emergency_alerts, false); assert.strictEqual(t.owner_briefing.copy_email, true);
    r = await post(a.base, '/admin/outbound/settings', { csrf, t: t.id, enabled: 'on', daily_time: '25:00', owner_numbers: KATIE, quiet_start: '22:00', quiet_end: '07:00' }, cookie); assert.match(r.headers.get('location'), /err=/); assert.strictEqual(t.owner_briefing.daily_time, '17:30');
    a.app.owner.pins.set(t.id, '9999');
    const before = a.app.owner.mockVoice.calls.length;
    r = await post(a.base, '/admin/outbound/test-call', { csrf, t: t.id, to: KATIE }, cookie); assert.strictEqual(r.status, 200); assert.match(await r.text(), /Yes, call now/);
    assert.strictEqual(a.app.owner.mockVoice.calls.length, before, 'no call before confirm');
    r = await post(a.base, '/admin/outbound/test-call', { csrf, t: t.id, to: '+17275550142', confirm: 'yes' }, cookie); assert.match(r.headers.get('location'), /owner%20number/);
    r = await post(a.base, '/admin/outbound/test-call', { csrf, t: t.id, to: KATIE, confirm: 'yes' }, cookie); assert.match(r.headers.get('location'), /Test%20call%20placed/);
    assert.strictEqual(a.app.owner.mockVoice.calls.length, before + 1);
    ({ html } = await page()); assert.match(html, /<td>test<\/td><td>…1188<\/td><td>queued/); assert.match(html, /test_call/);
  } finally { await a.close(); }
});
