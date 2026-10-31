'use strict';
const test = require('node:test'); const assert = require('node:assert');
const path = require('path'); const fs = require('fs'); const os = require('os');
const { Subscribers } = require('../src/subscribers');
const { Newsletter } = require('../src/newsletter');
const { startApp } = require('./helpers');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-')); const file = path.join(dir, 'newsletter.jsonl');
  const nl = new Newsletter({ secret: 'x'.repeat(32), file });
  nl.record({ e: 'support@quantaxtechnology.com', n: 'John', t: 'r' }, 'confirmed');
  nl.record({ e: 'jane@example.com', n: 'Jane', t: 'r' }, 'confirmed'); nl.linkPhone({ tenant: 'r', email: 'jane@example.com', phone: '+15550001111' });
  nl.requestSms({ tenant: 'r', phone: '+15550002222', wording: { text: 'w' } }); nl.confirmSms('r', '+15550002222', 'YES');
  nl.requestSms({ tenant: 'r', phone: '+15550003333', wording: { text: 'w' } }); nl.confirmSms('r', '+15550003333', 'YES'); nl.stopSms('r', '+15550003333');
  const s = new Subscribers({ file, auditFile: path.join(dir, 'audit.jsonl'), suppressionFile: path.join(dir, 'supp.jsonl') });
  const find = (pred) => s.list().find(pred);
  return { dir, file, nl, s, find };
}
const audit = (m) => fs.readFileSync(path.join(m.dir, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('lists every entry, including phone links with texts off; search by name, email or phone digits', () => {
  const m = setup(); const all = m.s.list();
  assert.strictEqual(all.length, 4);
  const jane = m.find((r) => r.email === 'jane@example.com'); assert.strictEqual(jane.phone, '+15550001111'); assert.strictEqual(jane.sms_optin, ''); assert.strictEqual(jane.email_optin, 'subscribed');
  assert.strictEqual(m.s.list('jane').length, 1); assert.strictEqual(m.s.list('quantax').length, 1); assert.strictEqual(m.s.list('0002222').length, 1);
});
test('edit name/phone keeps consent; changed email or phone needs re-confirmation; audit has before/after', () => {
  const m = setup(); const jane = m.find((r) => r.email === 'jane@example.com');
  assert.strictEqual(m.s.edit(jane.key, { name: 'Janet', email: 'jane@example.com', phone: '+15550001111' }, 'tester').ok, true);
  let r = m.find((x) => x.email === 'jane@example.com'); assert.strictEqual(r.name, 'Janet'); assert.strictEqual(r.email_optin, 'subscribed');
  assert.strictEqual(m.s.edit(r.key, { email: 'janet@example.com' }, 'tester').ok, true);
  r = m.find((x) => x.email === 'janet@example.com'); assert.strictEqual(r.email_optin, 'unsubscribed', 'never turns consent on for a new address'); assert.strictEqual(r.phone, '+15550001111');
  assert.ok(!m.nl.isSubscriber('r', 'janet@example.com'));
  const a = audit(m).pop(); assert.strictEqual(a.action, 'edit'); assert.strictEqual(a.who, 'tester'); assert.strictEqual(a.before.email, 'jane@example.com'); assert.strictEqual(a.after.email, 'janet@example.com'); assert.ok(a.at);
  assert.strictEqual(m.s.edit(r.key, { email: 'bad' }).error, 'invalid_email'); assert.strictEqual(m.s.edit(r.key, { phone: '555' }).error, 'invalid_phone');
  assert.strictEqual(m.s.edit(r.key, { email: 'support@quantaxtechnology.com' }).error, 'already_exists_use_merge');
  const sms = m.find((x) => x.phone === '+15550002222'); m.s.edit(sms.key, { phone: '+15550004444' });
  assert.strictEqual(m.find((x) => x.phone === '+15550004444').sms_optin, 'unsubscribed'); assert.ok(!m.nl.isSmsSubscriber('r', '+15550004444'));
});
test('unsubscribe/stop per channel only turns consent off', () => {
  const m = setup(); const jane = m.find((r) => r.email === 'jane@example.com');
  assert.strictEqual(m.s.unsubscribe(jane.key, 'email').ok, true); assert.ok(!m.nl.isSubscriber('r', 'jane@example.com'));
  assert.strictEqual(m.s.unsubscribe(jane.key, 'email').error, 'not_subscribed');
  const sms = m.find((x) => x.phone === '+15550002222'); assert.strictEqual(m.s.unsubscribe(sms.key, 'sms').ok, true); assert.strictEqual(m.nl.smsState('r', '+15550002222').status, 'unsubscribed');
  assert.strictEqual(m.s.unsubscribe(sms.key, 'on').error, 'bad_channel');
});
test('merge phone-only row into email row: one entry, consent flags kept; refuses conflicting emails', () => {
  const m = setup(); const john = m.find((r) => r.email === 'support@quantaxtechnology.com'); const ph = m.find((r) => r.phone === '+15550002222');
  const r = m.s.merge(john.key, ph.key, 'tester'); assert.strictEqual(r.ok, true);
  const all = m.s.list(); assert.strictEqual(all.length, 3);
  const j = all.find((x) => x.email === 'support@quantaxtechnology.com'); assert.strictEqual(j.phone, '+15550002222'); assert.strictEqual(j.sms_optin, 'subscribed'); assert.strictEqual(j.email_optin, 'subscribed');
  assert.strictEqual(m.nl.emailOnFile('r', '+15550002222'), 'support@quantaxtechnology.com');
  assert.strictEqual(audit(m).pop().action, 'merge');
  const jane = m.find((x) => x.email === 'jane@example.com'); assert.strictEqual(m.s.merge(j.key, jane.key).error, 'two_different_emails');
});
test('delete removes the entry; opted-out entries keep a suppression and proof record so STOP is honored', () => {
  const m = setup(); const john = m.find((r) => r.email === 'support@quantaxtechnology.com');
  assert.strictEqual(m.s.remove(john.key, 'tester').ok, true); assert.ok(!m.s.list().some((r) => r.email === 'support@quantaxtechnology.com')); assert.ok(!m.nl.isSubscriber('r', 'support@quantaxtechnology.com'));
  assert.ok(!fs.existsSync(path.join(m.dir, 'supp.jsonl')));
  const stopped = m.find((r) => r.phone === '+15550003333'); const r = m.s.remove(stopped.key, 'tester'); assert.strictEqual(r.kept_opt_out_records, 1);
  const supp = fs.readFileSync(path.join(m.dir, 'supp.jsonl'), 'utf8'); assert.match(supp, /\+15550003333/); assert.match(supp, /"channel":"sms"/);
  assert.ok(!m.s.list().some((x) => x.phone === '+15550003333'));
  assert.ok(fs.readFileSync(m.file, 'utf8').includes('"kind":"sms_stopped"'));
  const d = audit(m).pop(); assert.strictEqual(d.action, 'delete'); assert.strictEqual(d.after, null); assert.strictEqual(d.before.phone, '+15550003333');
});

// ---- HTTP: auth, CSRF, confirm step ----
const cookieOf = (r, name) => { const m = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(name + '=')); return m ? m.slice(name.length + 1) : null; };
const csrfIn = (html) => (html.match(/name="csrf" value="([^"]*)"/) || [])[1];
const post = (base, p, f, cookie) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(f).toString() });
async function signIn(a) {
  const g0 = await fetch(a.base + '/admin/login'); const c0 = cookieOf(g0, 'pa_csrf');
  await post(a.base, '/admin/login', { csrf: csrfIn(await g0.text()) }, 'pa_csrf=' + c0);
  const sent = a.deps.emailFor(null).sent; const link = sent[sent.length - 1].text.match(/https?:\/\/\S+\/admin\/auth\?t=\S+/)[0];
  const g = await fetch(link.replace(/^https?:\/\/[^/]+/, a.base)); const c = cookieOf(g, 'pa_csrf');
  const p = await post(a.base, '/admin/auth', { csrf: csrfIn(await g.text()), t: new URL(link).searchParams.get('t') }, 'pa_csrf=' + c);
  return 'pa_admin=' + cookieOf(p, 'pa_admin');
}
test('HTTP: page needs sign-in; dashboard links to it; POSTs need CSRF; delete asks to confirm', async () => {
  const a = await startApp();
  try {
    a.deps.newsletter.record({ e: 'support@quantaxtechnology.com', n: 'John', t: 'rfsafe-demo' }, 'confirmed');
    assert.strictEqual((await fetch(a.base + '/admin/subscribers')).status, 401);
    const sess = await signIn(a);
    assert.match(await (await fetch(a.base + '/admin', { headers: { cookie: sess } })).text(), /href="\/admin\/subscribers"/);
    const pg = await fetch(a.base + '/admin/subscribers', { headers: { cookie: sess } }); const html = await pg.text();
    assert.strictEqual(pg.status, 200); assert.match(html, /support@quantaxtechnology\.com/); assert.match(pg.headers.get('content-security-policy'), /nonce-/);
    const csrf = csrfIn(html); const key = (html.match(/name="key" value="([^"]*)"/) || [])[1].replace(/&#39;|&amp;|&quot;/g, (x) => ({ '&#39;': "'", '&amp;': '&', '&quot;': '"' }[x]));
    assert.strictEqual((await post(a.base, '/admin/subscribers/delete', { key, confirm: 'yes' }, sess)).status, 403);
    assert.strictEqual((await post(a.base, '/admin/subscribers/delete', { key, confirm: 'yes', csrf: 'bad' }, sess)).status, 403);
    const conf = await post(a.base, '/admin/subscribers/delete', { key, csrf }, sess); assert.strictEqual(conf.status, 200); assert.match(await conf.text(), /Delete this entry\?/);
    assert.ok(a.deps.newsletter.isSubscriber('rfsafe-demo', 'support@quantaxtechnology.com'));
    const del = await post(a.base, '/admin/subscribers/delete', { key, csrf, confirm: 'yes' }, sess); assert.strictEqual(del.status, 303);
    assert.ok(!a.deps.newsletter.isSubscriber('rfsafe-demo', 'support@quantaxtechnology.com'));
    assert.match(await (await fetch(a.base + '/admin/subscribers', { headers: { cookie: sess } })).text(), /delete/);
    const x = await fetch(a.base + '/admin/subscribers', { headers: { authorization: 'Bearer ' + a.deps.adminToken } }); if (a.deps.adminToken) assert.strictEqual(x.status, 200);
  } finally { await a.close(); }
});
