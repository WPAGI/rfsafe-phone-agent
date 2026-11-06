'use strict';
// Local end-to-end run of /preferences on the callbots app (demo mode: mock Resend + mock Twilio; nothing leaves the box).
// Usage: node scripts/e2e-prefs.js [outDir]   -> writes HTML snapshots for screenshots and prints a step log.
const fs = require('fs'); const path = require('path'); const assert = require('assert');
const { startApp, ENV } = require('../test/helpers'); const { twilioSignature } = require('../src/twilio');
const rfsafe = require('../src/prefs/sites/rfsafe');
const out = process.argv[2] || path.join(__dirname, '../screens/html'); fs.mkdirSync(out, { recursive: true });
const steps = []; const ok = (m) => { steps.push('PASS ' + m); console.log('PASS ' + m); };
async function run(label, cfg, fn) {
  const a = await startApp({ now: () => new Date() }); // real clock so tokens/sessions behave as live
  const t = a.deps.tenants.list().find((x) => x.id === 'rfsafe-demo'); t.sms_enabled = true; // in memory only
  const dd = { ...a.deps, prefsSiteConfig: cfg }; const app = require('../src/app').createApp(dd);
  const http = require('http'); const srv = http.createServer(app.handler); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port; dd.publicBaseUrl = base;
  const mail = a.deps.emailFor(); const tw = a.deps.smsFor(t);
  const post = (p, body, cookie) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(body) });
  const get = (p, cookie) => fetch(base + p, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  const snap = async (name, p, cookie) => { const html = await (await get(p, cookie)).text(); fs.writeFileSync(path.join(out, name + '.html'), html); return html; };
  const sms = (from, Body) => { const params = { From: from, To: t.numbers[0], Body }; return fetch(base + '/twilio/sms', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(ENV.DEMO_TWILIO_AUTH_TOKEN, base + '/twilio/sms', params) }, body: new URLSearchParams(params) }); };
  try { console.log('== ' + label); await fn({ a, t, mail, tw, post, get, snap, sms, base }); } finally { await new Promise((r) => srv.close(r)); await a.close(); }
}
const csrfOf = (html) => html.match(/name=csrf value="([^"]+)"/)[1];
(async () => {
  // A: open mode (email web sign-up + SMS web opt-in with YES)
  await run('open mode: email sign-up + SMS web opt-in', { ...rfsafe, tenant: 'rfsafe-demo', smsWebOptIn: true }, async ({ a, mail, tw, post, get, snap, sms }) => {
    await snap('01-entry', '/preferences');
    let r = await post('/preferences/start', { email: 'tester@example.com' }); assert.match(await r.text(), /If that address is on file/); ok('email entry -> generic answer');
    const link = mail.sent.at(-1).text.match(/https?:\S+\/preferences\/verify\?t=[\w-]+/)[0]; ok('magic link "sent" via mock Resend, greeting ' + mail.sent.at(-1).text.split('\n')[0]);
    assert.match(await (await get(link.replace(/^https?:\/\/[^/]+/, ''))).text(), /Continue/); ok('GET link shows Continue (not consumed)');
    r = await post('/preferences/verify', { t: new URL(link).searchParams.get('t') }); let cookie = r.headers.get('set-cookie').split(';')[0]; assert.strictEqual(r.status, 303); ok('Continue -> signed in');
    let html = await snap('02-manage-email', '/preferences/manage', cookie);
    r = await post('/preferences/save', { csrf: csrfOf(html), newsletter: 'on', name: 'Test Person' }, cookie); assert.ok(a.deps.newsletter.isSubscriber('rfsafe-demo', 'tester@example.com')); ok('newsletter joined from web with Name');
    const ph = '+17275550142'; r = await post('/preferences/start', { phone: '(727) 555-0142' }); assert.match(await r.text(), /Enter your code/);
    const code = tw.sent.at(-1).body.match(/code is (\d{6})/)[1]; ok('phone entry -> mock code text: "' + tw.sent.at(-1).body + '"');
    r = await post('/preferences/code', { phone: ph, code }); cookie = r.headers.get('set-cookie').split(';')[0]; ok('code accepted -> signed in by phone');
    html = await snap('03-manage-text-consent', '/preferences/manage', cookie); assert.match(html, /id=sms-consent/); ok('text consent wording shown in full');
    r = await post('/preferences/save', { csrf: csrfOf(html), support_sms: 'on', news_sms: 'on', news_freq: 'monthly', consent: 'yes' }, cookie);
    assert.strictEqual(tw.sent.at(-1).body, rfsafe.smsConfirmText); assert.strictEqual(a.deps.newsletter.smsState('rfsafe-demo', ph).status, 'pending'); ok('opt-in -> mock confirmation text, status pending (not enrolled yet)');
    await snap('04-manage-pending', '/preferences/manage', cookie);
    r = await sms(ph, 'YES'); assert.strictEqual(r.status, 200, 'signed webhook accepted'); const reply = await r.text(); assert.strictEqual(a.deps.newsletter.smsState('rfsafe-demo', ph).status, 'subscribed'); ok('simulated YES via signed /twilio/sms -> enrolled; reply: ' + reply.replace(/<[^>]+>/g, '').trim());
    html = await (await get('/preferences/manage', cookie)).text();
    await post('/preferences/save', { csrf: csrfOf(html), support_sms: 'on', news_sms: 'on', news_freq: 'up4' }, cookie); ok('frequency changed to up to 4/mo');
    html = await snap('05-manage-enrolled', '/preferences/manage', cookie);
    r = await post('/preferences/unsubscribe', { csrf: csrfOf(html), scope: 'texts' }, cookie); assert.ok(a.deps.consent.isOptedOut('rfsafe-demo', ph)); ok('dropdown "Unsubscribe from all texts" -> number on STOP list');
    await sms(ph, 'START'); assert.ok(!a.deps.consent.isOptedOut('rfsafe-demo', ph)); const stop = await (await sms(ph, 'STOP')).text(); assert.ok(a.deps.consent.isOptedOut('rfsafe-demo', ph)); ok('STOP reply still works unchanged: ' + stop.replace(/<[^>]+>/g, '').trim());
  });
  // B: rfsafe beta config (manage-only texts)
  await run('manage-only texts (smsWebOptIn false)', { ...rfsafe, tenant: 'rfsafe-demo', smsWebOptIn: false }, async ({ a, tw, post, snap }) => {
    const n0 = tw.sent.length; const r1 = await (await post('/preferences/start', { phone: '7275550199' })).text(); assert.strictEqual(tw.sent.length, n0); ok('unknown number: no code sent');
    a.deps.consent.record('rfsafe-demo', '+17275550142', 'verbal_call');
    const r2 = await (await post('/preferences/start', { phone: '7275550142' })).text(); assert.strictEqual(tw.sent.length, n0 + 1); assert.strictEqual(r1.replace(/value="[^"]*"/g, ''), r2.replace(/value="[^"]*"/g, '')); ok('call-consent number: code sent; identical page for both');
    const code = tw.sent.at(-1).body.match(/code is (\d{6})/)[1]; const v = await post('/preferences/code', { phone: '+17275550142', code }); const cookie = v.headers.get('set-cookie').split(';')[0];
    const html = await snap('06-manage-only-texts', '/preferences/manage', cookie); assert.match(html, /call <a href="tel:\+17276775572">/); assert.doesNotMatch(html, /id=sms-consent/); ok('manage-only page: no consent form, call note shown');
    const r = await post('/preferences/save', { csrf: csrfOf(html), support_sms: 'on', news_sms: 'on', consent: 'yes' }, cookie); assert.match(r.headers.get('location'), /err=sms_signup_by_phone/); assert.strictEqual(tw.sent.length, n0 + 1); ok('turning news texts on refused, nothing sent');
  });
  fs.writeFileSync(path.join(out, 'e2e-log.txt'), steps.join('\n') + '\n'); console.log('ALL ' + steps.length + ' STEPS PASSED');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
