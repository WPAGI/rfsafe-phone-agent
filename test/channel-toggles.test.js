'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers');
const adm = require('../src/admin');

const MS = 'MG' + 'b'.repeat(32);
const cookieOf = (r, name) => { const m = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(name + '=')); return m ? m.slice(name.length + 1) : null; };
const csrfIn = (html) => (html.match(/name="csrf" value="([^"]*)"/) || [])[1];
const post = (base, path, form, cookie, extra = {}) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}), ...extra }, body: new URLSearchParams(form).toString() });
async function signIn(a) {
  const g0 = await fetch(a.base + '/admin/login'); const c0 = cookieOf(g0, 'pa_csrf');
  await post(a.base, '/admin/login', { csrf: csrfIn(await g0.text()) }, 'pa_csrf=' + c0);
  const sent = a.deps.emailFor(null).sent; const link = sent[sent.length - 1].text.match(/https?:\/\/\S+\/admin\/auth\?t=\S+/)[0];
  const g = await fetch(link.replace(/^https?:\/\/[^/]+/, a.base)); const c = cookieOf(g, 'pa_csrf');
  const p = await post(a.base, '/admin/auth', { csrf: csrfIn(await g.text()), t: new URL(link).searchParams.get('t') }, 'pa_csrf=' + c);
  const sess = 'pa_admin=' + cookieOf(p, 'pa_admin');
  const dash = await (await fetch(a.base + '/admin', { headers: { cookie: sess } })).text();
  return { sess, csrf: csrfIn(dash) };
}
const dash = async (a, s, qs = '') => (await fetch(a.base + '/admin' + qs, { headers: { cookie: s.sess } })).text();

test('dashboard toggles: show state, need session + CSRF, email sets email_enabled, logged with time', async () => {
  const a = await startApp();
  try {
    const t = a.deps.tenants.get('rfsafe-demo'); t.sms_enabled = false; t.email_enabled = true;
    const s = await signIn(a);
    let html = await dash(a, s);
    assert.match(html, /Texting and email/); assert.match(html, /data-ch="sms">OFF/); assert.match(html, /data-ch="email">ON/);
    const form = { tenant: 'rfsafe-demo', channel: 'email', enabled: 'off' };
    assert.strictEqual((await post(a.base, '/admin/channels', { ...form, csrf: s.csrf })).status, 403); // no session
    assert.strictEqual((await post(a.base, '/admin/channels', { ...form, csrf: 'bad' }, s.sess)).status, 403);
    assert.strictEqual((await post(a.base, '/admin/channels', { ...form, csrf: s.csrf }, s.sess, { origin: 'https://evil.example' })).status, 403);
    assert.strictEqual(t.email_enabled, true);
    const r = await post(a.base, '/admin/channels', { ...form, csrf: s.csrf }, s.sess);
    assert.strictEqual(r.status, 303); assert.strictEqual(t.email_enabled, false); assert.strictEqual(t.sms_enabled, false);
    html = await dash(a, s);
    assert.match(html, /both off, so callers cannot receive links/);
    assert.match(html, /\d{4}-\d{2}-\d{2}T[\d:.]+Z<\/td><td>rfsafe-demo<\/td><td>Email<\/td><td>off<\/td><td>done/);
    await post(a.base, '/admin/channels', { ...form, enabled: 'on', csrf: s.csrf }, s.sess);
    assert.strictEqual(t.email_enabled, true);
    assert.doesNotMatch(await dash(a, s), /value="rfsafe-demo"><input type="hidden" name="channel" value="email"><input type="hidden" name="enabled" value="on">Email: <strong data-ch="email">OFF[^]*?both off/);
  } finally { await a.close(); }
});

test('dashboard texting toggle reuses sender-pool check and existing Messaging Service; errors are shown', async () => {
  const a = await startApp();
  try {
    const t = a.deps.tenants.get('rfsafe-demo'); t.sms_enabled = false; t.email_enabled = true;
    const s = await signIn(a);
    const on = { tenant: 'rfsafe-demo', channel: 'sms', enabled: 'on', csrf: s.csrf };
    // no Messaging Service configured yet
    t.twilio = { ...(t.twilio || {}) }; delete t.twilio.messaging_service_sid;
    let r = await post(a.base, '/admin/channels', on, s.sess);
    assert.strictEqual(r.status, 303); assert.match(r.headers.get('location'), /err=/); assert.strictEqual(t.sms_enabled, false);
    t.twilio.messaging_service_sid = MS;
    const tr = a.deps.smsFor(t); tr.pool = ['+15550000000'];
    r = await post(a.base, '/admin/channels', on, s.sess);
    const loc = r.headers.get('location'); assert.strictEqual(t.sms_enabled, false);
    const html = await dash(a, s, loc.replace('/admin', ''));
    assert.match(html, /Could not change setting:<\/strong> Twilio says this number is not in the approved texting group/);
    assert.match(html, /Texting<\/td><td>on<\/td><td>failed: number_not_in_sender_pool/);
    tr.pool = [t.numbers[0]];
    r = await post(a.base, '/admin/channels', on, s.sess);
    assert.doesNotMatch(r.headers.get('location'), /err=/);
    assert.strictEqual(t.sms_enabled, true); assert.strictEqual(t.twilio.messaging_service_sid, MS); assert.strictEqual(t.email_enabled, true);
    assert.match(await dash(a, s), /data-ch="sms">ON/);
    // pool check failure
    tr.senderPool = async () => { throw new Error('boom'); };
    await post(a.base, '/admin/channels', { ...on, enabled: 'off' }, s.sess); assert.strictEqual(t.sms_enabled, false);
    r = await post(a.base, '/admin/channels', on, s.sess);
    assert.match(decodeURIComponent(r.headers.get('location')), /Could not reach Twilio/); assert.strictEqual(t.sms_enabled, false);
    // bad input
    r = await post(a.base, '/admin/channels', { ...on, channel: 'fax' }, s.sess); assert.match(r.headers.get('location'), /err=/);
  } finally { await a.close(); }
});

test('tenant creation still forces texting off; err text is escaped', async () => {
  const html = adm.channelsSection('x', [{ id: 'a', sms_enabled: false, email_enabled: false }], [], '<script>');
  assert.doesNotMatch(html, /<script>/); assert.match(html, /cannot receive links/);
  const a = await startApp();
  try {
    const r = await fetch(a.base + '/admin/tenants', { method: 'POST', headers: { authorization: 'Bearer ' + a.deps.adminToken, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'newco', name: 'N', sms_enabled: true, numbers: [] }) });
    const t = a.deps.tenants.get('newco'); if (t) assert.strictEqual(t.sms_enabled, false); else assert.ok(r.status >= 400);
  } finally { await a.close(); }
});

test('instant texts: PATCH accepts boolean instant_link_reply only; dashboard switch needs session + CSRF and is logged', async () => {
  const a = await startApp();
  try {
    const t = a.deps.tenants.get('rfsafe-demo'); t.approval_mode = true; t.instant_link_reply = false;
    const tok = a.deps.adminToken || process.env.ADMIN_TOKEN;
    const patch = (body) => fetch(a.base + '/admin/tenants/rfsafe-demo', { method: 'PATCH', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (tok) {
      assert.strictEqual((await patch({ instant_link_reply: 'yes' })).status, 400);
      assert.strictEqual((await patch({ approval_mode: false })).status, 400);
      assert.strictEqual((await patch({ instant_link_reply: true })).status, 200); assert.strictEqual(t.instant_link_reply, true);
      t.instant_link_reply = false;
    }
    const s = await signIn(a);
    assert.match(await dash(a, s), /data-ch="instant">HOLD FOR REVIEW/);
    const form = { tenant: 'rfsafe-demo', channel: 'instant', enabled: 'on' };
    assert.strictEqual((await post(a.base, '/admin/channels', { ...form, csrf: 'bad' }, s.sess)).status, 403);
    assert.strictEqual((await post(a.base, '/admin/channels', { ...form, csrf: s.csrf })).status, 403);
    assert.strictEqual(t.instant_link_reply, false);
    assert.strictEqual((await post(a.base, '/admin/channels', { ...form, csrf: s.csrf }, s.sess)).status, 303);
    assert.strictEqual(t.instant_link_reply, true); assert.strictEqual(t.approval_mode, true);
    const html = await dash(a, s);
    assert.match(html, /data-ch="instant">SEND INSTANTLY/);
    assert.match(html, /<td>rfsafe-demo<\/td><td>Texts: send instantly<\/td><td>on<\/td><td>done/);
    await post(a.base, '/admin/channels', { ...form, enabled: 'off', csrf: s.csrf }, s.sess);
    assert.strictEqual(t.instant_link_reply, false); assert.match(await dash(a, s), /HOLD FOR REVIEW/);
  } finally { await a.close(); }
});
