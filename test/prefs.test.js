'use strict';
// Public /preferences: magic links, codes, rate limits, non-enumeration, toggles, audit, unsubscribe-all,
// List-Unsubscribe headers, SMS controls hidden when the flag is off, consent + YES path when it is on.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const { createPrefs, GENERIC_EMAIL } = require('../src/prefs');
const { PrefsCore, TOKEN_TTL_MS } = require('../src/prefs/core');
const rfsafe = require('../src/prefs/sites/rfsafe');
// Generic core tests run the shared module in open mode (how QuantaDose uses it); manage-only rules for rfsafe are tested below.
const site = { ...rfsafe, smsWebOptIn: true };
const rfsafeMO = { ...rfsafe, smsWebOptIn: false }; // manage-only mode, still supported by config
const { Newsletter } = require('../src/newsletter');
const { Consent, MockTwilio } = require('../src/twilio');
const { MockEmail, listUnsubscribeHeaders } = require('../src/email');

async function mk({ sms = false, cfg = site } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-')); let t = Date.parse('2026-11-06T10:00:00Z');
  const tenant = { id: 'rfsafe', name: 'RF Safe', numbers: ['+17276775572'], sms_enabled: sms, twilio: { messaging_service_sid: 'MG' + '0'.repeat(32) } };
  const mail = new MockEmail(); const tw = new MockTwilio(); const consent = new Consent(null);
  const nl = new Newsletter({ secret: 'x'.repeat(32), file: path.join(dir, 'newsletter.jsonl'), now: () => t });
  const d = { dataDir: dir, env: sms ? { PREFS_SMS_ENABLED: '1' } : {}, tenants: { list: () => [tenant] }, newsletter: nl, consent, emailFor: () => mail, smsFor: () => tw, publicBaseUrl: 'https://callbots.org', now: () => t };
  const p = createPrefs(d, cfg); const srv = http.createServer(async (req, res) => { const u = new URL(req.url, 'http://x'); if (!(await p.route(req, res, u))) { res.writeHead(404); res.end(); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + srv.address().port;
  const post = (pth, body, cookie, ip = '1.1.1.1') => fetch(base + pth, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(body).toString() });
  const get = (pth, cookie) => fetch(base + pth, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  const tokOf = (i = -1) => mail.sent.at(i).text.match(/verify\?t=([A-Za-z0-9_-]+)/)[1];
  async function login(email = 'jane@example.com') {
    await post('/preferences/start', { email }); const r = await post('/preferences/verify', { t: tokOf() });
    assert.strictEqual(r.status, 303); const cookie = r.headers.get('set-cookie').split(';')[0];
    const csrf = (await (await get('/preferences/manage', cookie)).text()).match(/name=csrf value="([^"]+)"/)[1]; return { cookie, csrf };
  }
  return { d, p, dir, mail, tw, nl, consent, tenant, post, get, tokOf, login, adv: (ms) => { t += ms; }, close: () => new Promise((r) => srv.close(r)) };
}

test('tokens: stored only as hashes, single use, expire after ~15 minutes', async () => {
  const m = await mk();
  try {
    await m.post('/preferences/start', { email: 'jane@example.com' }); const tok = m.tokOf();
    const state = fs.readFileSync(path.join(m.dir, 'prefs', 'rfsafe', 'state.json'), 'utf8');
    assert.ok(!state.includes(tok), 'raw token must not be stored'); assert.ok(!state.includes(tok.slice(0, 16)));
    assert.match((await (await m.get('/preferences/verify?t=' + tok)).text()), /Continue/); // GET never consumes
    assert.strictEqual((await m.post('/preferences/verify', { t: tok })).status, 303);
    assert.strictEqual((await m.post('/preferences/verify', { t: tok })).status, 400, 'second use fails');
    await m.post('/preferences/start', { email: 'jane@example.com' }); const t2 = m.tokOf(); m.adv(TOKEN_TTL_MS + 1000);
    assert.strictEqual((await m.post('/preferences/verify', { t: t2 })).status, 400, 'expired');
  } finally { await m.close(); }
});

test('codes: hashed, single use, 5 tries, expiry', () => {
  let t = 0; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefc-')); const c = new PrefsCore({ dir, site, env: {}, now: () => t });
  const code = c.issueCode('+17275550142'); assert.ok(!fs.readFileSync(path.join(dir, 'prefs', 'rfsafe', 'state.json'), 'utf8').includes(code));
  assert.ok(c.consumeCode('+17275550142', code)); assert.ok(!c.consumeCode('+17275550142', code));
  const c2 = c.issueCode('+17275550142'); for (let i = 0; i < 5; i++) assert.ok(!c.consumeCode('+17275550142', '000000' === c2 ? '111111' : '000000'));
  assert.ok(!c.consumeCode('+17275550142', c2), 'locked after 5 wrong tries');
  const c3 = c.issueCode('+17275550142'); t += TOKEN_TTL_MS + 1; assert.ok(!c.consumeCode('+17275550142', c3));
});

test('signing key: generated on the data disk (0600) unless PREFS_SECRET is set; never the same twice', () => {
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'prefk-')); const a = new PrefsCore({ dir: d1, site, env: {} });
  const f = path.join(d1, 'prefs', 'rfsafe', 'prefs-secret.key'); assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  assert.strictEqual(new PrefsCore({ dir: d1, site, env: {} }).secret, a.secret);
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'prefk-')); assert.notStrictEqual(new PrefsCore({ dir: d2, site, env: {} }).secret, a.secret);
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'prefk-')); const s = 'y'.repeat(40); assert.strictEqual(new PrefsCore({ dir: d3, site, env: { PREFS_SECRET: s } }).secret, s);
  assert.ok(!fs.existsSync(path.join(d3, 'prefs', 'rfsafe', 'prefs-secret.key')));
});

test('non-enumeration + rate limits: identical answers for known, unknown and limited; 3 per address, 10 per IP', async () => {
  const m = await mk();
  try {
    m.nl.append({ kind: 'confirmed', tenant: 'rfsafe', email: 'known@example.com' });
    const bodies = []; for (const e of ['known@example.com', 'nobody@example.com']) { const r = await m.post('/preferences/start', { email: e }); assert.strictEqual(r.status, 200); bodies.push(await r.text()); }
    assert.strictEqual(bodies[0], bodies[1]); assert.ok(bodies[0].includes(GENERIC_EMAIL.replace(/'/g, '&#39;')));
    for (let i = 0; i < 3; i++) await m.post('/preferences/start', { email: 'x@example.com' }, null, '2.2.2.2');
    const before = m.mail.sent.length; const lim = await m.post('/preferences/start', { email: 'x@example.com' }, null, '2.2.2.3');
    assert.strictEqual(m.mail.sent.length, before, '4th request for one address sends nothing'); assert.strictEqual(await lim.text(), bodies[0]);
    for (let i = 0; i < 10; i++) await m.post('/preferences/start', { email: `ip${i}@example.com` }, null, '3.3.3.3');
    const b2 = m.mail.sent.length; assert.strictEqual(await (await m.post('/preferences/start', { email: 'ip99@example.com' }, null, '3.3.3.3')).text(), bodies[0]);
    assert.strictEqual(m.mail.sent.length, b2, '11th from one IP sends nothing');
  } finally { await m.close(); }
});

test('flag off: entry and manage pages show text options coming soon; SMS fields are ignored; phone-only sends nothing', async () => {
  const m = await mk({ sms: false });
  try {
    const entry = await (await m.get('/preferences')).text(); assert.match(entry, /Text options are not available right now/); assert.match(entry, /name=phone disabled/);
    const r = await m.post('/preferences/start', { phone: '7275550142' }); assert.strictEqual(r.status, 400); assert.strictEqual(m.tw.sent.length, 0);
    const { cookie, csrf } = await m.login(); const page = await (await m.get('/preferences/manage', cookie)).text();
    assert.match(page, /id=sms-soon/); assert.match(page, /<fieldset disabled>/); assert.doesNotMatch(page, /name=support_sms/); assert.doesNotMatch(page, /id=sms-consent/);
    await m.post('/preferences/save', { csrf, news_sms: 'on', support_sms: 'on', consent: 'yes' }, cookie); assert.strictEqual(m.tw.sent.length, 0);
  } finally { await m.close(); }
});

test('toggles + audit: newsletter on/off over web, CSRF required, every change logged with time, method, source', async () => {
  const m = await mk();
  try {
    const { cookie, csrf } = await m.login();
    assert.strictEqual((await m.post('/preferences/save', { csrf: 'bad', newsletter: 'on' }, cookie)).status, 403);
    assert.strictEqual(m.nl.isSubscriber('rfsafe', 'jane@example.com'), false);
    await m.post('/preferences/save', { csrf, newsletter: 'on', name: 'Jane' }, cookie); assert.strictEqual(m.nl.isSubscriber('rfsafe', 'jane@example.com'), true);
    await m.post('/preferences/save', { csrf }, cookie); assert.strictEqual(m.nl.isSubscriber('rfsafe', 'jane@example.com'), false);
    const log = m.p.core.auditLog().filter((x) => x.channel === 'email_newsletter');
    assert.deepStrictEqual(log.map((x) => x.to), ['on', 'off']);
    for (const x of log) { assert.ok(x.at); assert.strictEqual(x.method, 'web'); assert.strictEqual(x.source, 'web:/preferences'); assert.ok(!('ip' in x)); }
    assert.ok(m.p.core.auditLog().some((x) => x.channel === 'session' && x.method === 'email-link'));
    assert.strictEqual((await m.get('/preferences/manage')).status, 303, 'no session -> back to entry');
  } finally { await m.close(); }
});

test('unsubscribe from everything turns every channel off and is logged', async () => {
  const m = await mk({ sms: true });
  try {
    m.nl.append({ kind: 'confirmed', tenant: 'rfsafe', email: 'jane@example.com' });
    const { cookie, csrf } = await m.login(); const r = await m.post('/preferences/unsubscribe-all', { csrf }, cookie); assert.strictEqual(r.headers.get('location'), '/preferences/manage?saved=all');
    assert.strictEqual(m.nl.isSubscriber('rfsafe', 'jane@example.com'), false);
    assert.ok(m.p.core.auditLog().some((x) => x.channel === 'all' && x.to === 'off'));
    assert.match(await (await m.get('/preferences/manage?saved=all', cookie)).text(), /unsubscribed from everything/);
  } finally { await m.close(); }
});

test('flag on (tests only): phone code sign-in, full consent wording, opt-in needs I agree + YES reply; frequency capped', async () => {
  const m = await mk({ sms: true });
  try {
    assert.match(await (await m.get('/preferences')).text(), /name=phone autocomplete=tel/);
    const r = await m.post('/preferences/start', { phone: '(727) 555-0142' }); assert.match(await r.text(), /Enter your code/);
    const code = m.tw.sent[0].body.match(/code is (\d{6})/)[1]; assert.ok(m.tw.sent[0].body.startsWith('RF Safe:'));
    const v = await m.post('/preferences/code', { phone: '7275550142', code }); assert.strictEqual(v.status, 303); const cookie = v.headers.get('set-cookie').split(';')[0];
    const page = await (await m.get('/preferences/manage', cookie)).text(); const csrf = page.match(/name=csrf value="([^"]+)"/)[1];
    assert.ok(page.includes(require('../src/prefs/page').h(site.smsConsentText)), 'full consent wording shown'); assert.doesNotMatch(page, /id=sms-soon/);
    assert.deepStrictEqual([...page.matchAll(/name=news_freq value="(\w+)"/g)].map((x) => x[1]), ['sales', 'monthly', 'up4']);
    const noAgree = await m.post('/preferences/save', { csrf, news_sms: 'on' }, cookie); assert.match(noAgree.headers.get('location'), /err=consent_required/); assert.strictEqual(m.tw.sent.length, 1);
    await m.post('/preferences/save', { csrf, news_sms: 'on', support_sms: 'on', consent: 'yes', news_freq: 'up4' }, cookie);
    assert.strictEqual(m.tw.sent.length, 2); assert.match(m.tw.sent[1].body, /Reply YES/); assert.strictEqual(m.nl.smsState('rfsafe', '+17275550142').status, 'pending');
    assert.ok(m.nl.confirmSms('rfsafe', '+17275550142', 'YES')); assert.ok(m.p.confirmSupportYes('+17275550142'));
    const st = m.p.stateFor({ phone: '+17275550142' }); assert.strictEqual(st.news_sms, 'subscribed'); assert.strictEqual(st.support_sms, true); assert.strictEqual(st.news_freq, 'up4');
    await m.post('/preferences/save', { csrf, news_freq: 'daily' }, cookie); assert.strictEqual(m.p.stateFor({ phone: '+17275550142' }).news_freq, 'up4', 'unknown frequency rejected');
    await m.post('/preferences/save', { csrf }, cookie); assert.ok(m.consent.isOptedOut('rfsafe', '+17275550142'), 'both off -> stop');
    assert.ok(m.p.core.auditLog().some((x) => x.channel === 'support_sms' && x.method === 'sms' && x.to === 'on'));
  } finally { await m.close(); }
});

test('RFC 8058: List-Unsubscribe + List-Unsubscribe-Post on newsletter emails, none on one-time link emails', async () => {
  const h = listUnsubscribeHeaders('https://callbots.org/newsletter/unsubscribe?t=abc');
  assert.deepStrictEqual(h, { 'List-Unsubscribe': '<https://callbots.org/newsletter/unsubscribe?t=abc>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  const { Tools, Approvals } = require('../src/tools'); const { KB } = require('../src/kb'); const { MockCallControl } = require('../src/mocks');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lu-')); const mail = new MockEmail();
  const t = { id: 'rfsafe', name: 'RF Safe', numbers: [], link_allowlist: ['rfsafe.org'], email_enabled: true, blocked_topics: [] };
  const nl = new Newsletter({ secret: 'x'.repeat(32), file: path.join(dir, 'n.jsonl'), baseUrl: 'https://callbots.org' });
  const tools = new Tools(t, { kbFor: () => new KB({ allowlist: t.link_allowlist }), emailFor: () => mail, consent: new Consent(null), callControl: new MockCallControl(), notify: async () => {}, approvals: new Approvals(), log: () => {}, newsletter: nl, emailLogFile: path.join(dir, 'e.jsonl') });
  const v = { channel: 'voice', callId: 'c1', caller: '+17275550142' };
  await tools.run('set_email_address', { email: 'jane@example.com', caller_said_yes: true }, v);
  await tools.run('send_email', { urls: ['https://rfsafe.org/'], recipient_name: 'Jane', newsletter_optin: true }, v);
  const hdr = mail.sent.at(-1).headers; assert.ok(hdr, 'newsletter email has headers'); assert.match(hdr['List-Unsubscribe'], /^<https:\/\/callbots\.org\/newsletter\/unsubscribe\?t=/); assert.strictEqual(hdr['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  await tools.run('set_email_address', { email: 'sam@example.com', caller_said_yes: true }, { ...v, callId: 'c2' });
  await tools.run('send_email', { urls: ['https://rfsafe.org/'], recipient_name: 'Sam' }, { ...v, callId: 'c2' }); assert.strictEqual(mail.sent.length, 2);
  assert.ok(!mail.sent.at(-1).headers, 'one-time link email has no list headers');
  const m = await mk(); try { await m.post('/preferences/start', { email: 'a@example.com' }); assert.ok(!m.mail.sent[0].headers); } finally { await m.close(); }
});

test('full app: GET /preferences is served on callbots.org (tenant texting off in the test app -> text options hidden)', async () => {
  const { startApp } = require('./helpers'); const a = await startApp();
  try { const r = await fetch(a.base + '/preferences'); assert.strictEqual(r.status, 200); const b = await r.text(); assert.match(b, /Text options are not available right now/); assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex'); }
  finally { await a.close(); }
});

test('unsubscribe dropdown: texts/emails/all, CSRF, audit, STOP list, works with flag off, no texts, typed number is opt-out only', async () => {
  const m = await mk({ sms: false });
  try {
    const PH = '+17275550142';
    m.nl.append({ kind: 'confirmed', tenant: 'rfsafe', email: 'jane@example.com' });
    m.consent.record('rfsafe', PH, 'inbound'); assert.ok(m.consent.canText('rfsafe', PH));
    const { cookie, csrf } = await m.login(); const page = await (await m.get('/preferences/manage', cookie)).text();
    for (const o of ['Unsubscribe from all texts', 'Unsubscribe from all emails', 'Unsubscribe from everything (texts and email)']) assert.ok(page.includes(o), o);
    assert.match(page, /id=unsubscribe/); assert.match(page, /name=phone autocomplete=tel/); assert.match(page, /never used to sign you up/);
    // CSRF
    assert.strictEqual((await m.post('/preferences/unsubscribe', { csrf: 'bad', scope: 'emails' }, cookie)).status, 403);
    assert.ok(m.nl.isSubscriber('rfsafe', 'jane@example.com'));
    // texts with a typed number while text controls are off: STOP list, no text sent, START works again
    let r = await m.post('/preferences/unsubscribe', { csrf, scope: 'texts', phone: '(727) 555-0142' }, cookie);
    assert.strictEqual(r.headers.get('location'), '/preferences/manage?saved=texts'); assert.ok(m.consent.isOptedOut('rfsafe', PH)); assert.strictEqual(m.tw.sent.length, 0);
    assert.ok(m.nl.isSubscriber('rfsafe', 'jane@example.com'), 'texts option leaves email alone');
    const { handleInboundSms } = require('../src/sms'); const T = { ...m.tenant, link_allowlist: ['quantadose.cards'], support_email: 'support@quantaxtechnology.com' };
    const sms = (body) => handleInboundSms({ tenant: T, from: PH, body, consent: m.consent, toolsFor: () => ({}), brain: { reply: async () => 'x' }, instructions: '', log: () => {} });
    assert.match(await sms('START'), /resubscribed/); assert.ok(m.consent.canText('rfsafe', PH)); assert.match(await sms('STOP'), /unsubscribed/); assert.ok(m.consent.isOptedOut('rfsafe', PH));
    // typed number never opts in: save with SMS fields does nothing, session still has no phone
    await m.post('/preferences/save', { csrf, news_sms: 'on', support_sms: 'on', consent: 'yes', phone: PH }, cookie);
    assert.strictEqual(m.nl.smsState('rfsafe', PH).status, 'none'); assert.strictEqual(m.tw.sent.length, 0);
    assert.strictEqual((await m.post('/preferences/unsubscribe', { csrf, scope: 'texts' }, cookie)).headers.get('location'), '/preferences/manage?err=phone');
    assert.strictEqual((await m.post('/preferences/unsubscribe', { csrf, scope: 'texts', phone: 'abc' }, cookie)).headers.get('location'), '/preferences/manage?err=phone');
    // emails
    r = await m.post('/preferences/unsubscribe', { csrf, scope: 'emails' }, cookie); assert.strictEqual(r.headers.get('location'), '/preferences/manage?saved=emails');
    assert.ok(!m.nl.isSubscriber('rfsafe', 'jane@example.com'));
    // all without a number: emails only, honest message; all with a number: both
    assert.strictEqual((await m.post('/preferences/unsubscribe', { csrf, scope: 'all' }, cookie)).headers.get('location'), '/preferences/manage?saved=all-email');
    m.consent.record('rfsafe', '+17275550199', 'inbound');
    assert.strictEqual((await m.post('/preferences/unsubscribe', { csrf, scope: 'all', phone: '+17275550199' }, cookie)).headers.get('location'), '/preferences/manage?saved=all');
    assert.ok(m.consent.isOptedOut('rfsafe', '+17275550199')); assert.strictEqual(m.tw.sent.length, 0);
    const a = m.p.core.auditLog();
    assert.ok(a.some((x) => x.channel === 'all_texts' && x.phone === PH && x.to === 'off' && x.method === 'web' && /typed-number,opt-out-only/.test(x.source)));
    assert.ok(a.some((x) => x.channel === 'email_newsletter' && x.to === 'off')); assert.ok(a.some((x) => x.channel === 'all' && x.to === 'off'));
    for (const x of a) assert.ok(x.at && x.method && x.source);
    // rate limit on the typed-number path (3 per number per 15 min)
    for (let i = 0; i < 3; i++) await m.post('/preferences/unsubscribe', { csrf, scope: 'texts', phone: '+17275550188' }, cookie, '9.9.9.9');
    assert.strictEqual((await m.post('/preferences/unsubscribe', { csrf, scope: 'texts', phone: '+17275550188' }, cookie, '9.9.9.8')).headers.get('location'), '/preferences/manage?err=limit');
  } finally { await m.close(); }
});

test('name: one Name field expands server-side when email is on, required, cleaned (80 max), escaped, prefilled, audit has no values', async () => {
  const m = await mk();
  try {
    const { cookie, csrf } = await m.login();
    let page = await (await m.get('/preferences/manage', cookie)).text();
    assert.match(page, /<div id=nl-names hidden><label for=nl-name>Name \(required\)<\/label><input type=text name=name id=nl-name maxlength=80 autocomplete=name/, 'one field, collapsed while email is off');
    assert.doesNotMatch(page, /first_name|last_name|Last name|First name/); assert.match(page, /n\.hidden=!b\.checked/, 'JS expands on check');
    let r = await m.post('/preferences/save', { csrf, newsletter: 'on', name: '  \u0007 ' }, cookie);
    assert.strictEqual(r.headers.get('location'), '/preferences/manage?err=name'); assert.ok(!m.nl.isSubscriber('rfsafe', 'jane@example.com'));
    page = await (await m.get('/preferences/manage?err=name', cookie)).text();
    assert.match(page, /<div id=nl-names>/, 'no-JS: field shown with the error'); assert.match(page, /enter your name/);
    r = await m.post('/preferences/save', { csrf, newsletter: 'on', name: '  <b>Jane</b>\r\nBcc: x@evil.com ' + 'a'.repeat(120) }, cookie);
    assert.strictEqual(r.headers.get('location'), '/preferences/manage?saved=1'); assert.ok(m.nl.isSubscriber('rfsafe', 'jane@example.com'));
    const pn = m.nl.profileName('rfsafe', 'jane@example.com'); assert.ok(pn.name.length <= 80); assert.doesNotMatch(pn.name, /[\r\n]/);
    page = await (await m.get('/preferences/manage', cookie)).text();
    assert.match(page, /<div id=nl-names>/); assert.ok(page.includes('value="&lt;b&gt;Jane&lt;/b&gt; Bcc: x@evil.com'), 'escaped + prefilled'); assert.ok(!page.includes('<b>Jane</b>'));
    await m.post('/preferences/save', { csrf, newsletter: 'on', name: "Janet O'Neil" }, cookie);
    assert.deepStrictEqual(m.nl.profileName('rfsafe', 'jane@example.com'), { name: "Janet O'Neil", first: 'Janet', last: null });
    assert.strictEqual(m.nl.subscribers().find((x) => x.email === 'jane@example.com').name, "Janet O'Neil");
    page = await (await m.get('/preferences/manage', cookie)).text(); assert.ok(page.includes('value="Janet O&#39;Neil"'));
    const names = m.p.core.auditLog().filter((x) => x.channel === 'name'); assert.strictEqual(names.length, 2);
    const raw = fs.readFileSync(path.join(m.dir, 'prefs', 'rfsafe', 'audit.jsonl'), 'utf8'); assert.ok(!raw.includes('Janet') && !raw.includes('Neil') && !raw.includes('<b>'));
    await m.post('/preferences/start', { email: 'jane@example.com' }); const e = m.mail.sent.at(-1);
    assert.match(e.text, /^Hi Janet,/); assert.match(e.html, /<p>Hi Janet,<\/p>/); assert.strictEqual(e.subject, site.emailSubject);
    await m.post('/preferences/start', { email: 'new@example.com' }); assert.match(m.mail.sent.at(-1).text, /^Hi there,/);
  } finally { await m.close(); }
});

test('name migration: legacy first + last records read as one joined name (no data lost), greeting uses the first word', async () => {
  const m = await mk();
  try {
    m.nl.append({ kind: 'confirmed', tenant: 'rfsafe', email: 'jane@example.com', name: 'John', last_name: 'Coates', source: 'web-preferences' });
    assert.deepStrictEqual(m.nl.profileName('rfsafe', 'jane@example.com'), { name: 'John Coates', first: 'John', last: null });
    assert.strictEqual(m.nl.subscribers().find((x) => x.email === 'jane@example.com').name, 'John Coates');
    const { cookie } = await m.login(); const page = await (await m.get('/preferences/manage', cookie)).text(); assert.ok(page.includes('value="John Coates"'), 'prefilled joined');
    await m.post('/preferences/start', { email: 'jane@example.com' }); assert.match(m.mail.sent.at(-1).text, /^Hi John,/);
    assert.match(require('../src/email').buildEmail({ links: [{ url: 'https://callbots.org/' }], name: 'John Coates' }).text, /^Hi John,/);
  } finally { await m.close(); }
});

test('newsletter greeting uses the stored first name (sanitized), safe fallback otherwise; never in headers or subject', async () => {
  const { Tools, Approvals } = require('../src/tools'); const { KB } = require('../src/kb'); const { MockCallControl } = require('../src/mocks');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-')); const mail = new MockEmail();
  const t = { id: 'rfsafe', name: 'RF Safe', numbers: [], link_allowlist: ['rfsafe.org'], email_enabled: true, blocked_topics: [] };
  const nl = new Newsletter({ secret: 'x'.repeat(32), file: path.join(dir, 'n.jsonl'), baseUrl: 'https://callbots.org' });
  nl.append({ kind: 'confirmed', tenant: 'rfsafe', email: 'jane@example.com', name: '<script>Jane', source: 'web-preferences' });
  const tools = new Tools(t, { kbFor: () => new KB({ allowlist: t.link_allowlist }), emailFor: () => mail, consent: new Consent(null), callControl: new MockCallControl(), notify: async () => {}, approvals: new Approvals(), log: () => {}, newsletter: nl, emailLogFile: path.join(dir, 'e.jsonl') });
  const v = { channel: 'voice', callId: 'c1', caller: '+17275550142' };
  await tools.run('set_email_address', { email: 'jane@example.com', caller_said_yes: true }, v); await tools.run('send_email', { urls: ['https://rfsafe.org/'] }, v);
  const e = mail.sent.at(-1); assert.match(e.text, /^Hi scriptJane,|^Hi Jane,/); assert.doesNotMatch(e.html, /<script>/); assert.doesNotMatch(e.subject, /Jane/);
  assert.ok(!JSON.stringify(e.headers || {}).includes('Jane'));
  const v2 = { ...v, callId: 'c2' }; await tools.run('set_email_address', { email: 'sam@example.com', caller_said_yes: true }, v2); await tools.run('send_email', { urls: ['https://rfsafe.org/'] }, v2);
  assert.match(mail.sent.at(-1).text, /^Hi there,/);
});

test('unsubscribe select: own label (for/id), placeholder disabled+selected, styled (appearance none, chevron, 16px, focus ring); empty choice still rejected', async () => {
  const m = await mk();
  try {
    const { cookie, csrf } = await m.login(); const page = await (await m.get('/preferences/manage', cookie)).text();
    assert.match(page, /<label for=unsub-scope class=sel-label>What would you like to stop\?<\/label><select id=unsub-scope name=scope class=pref-select required><option value="" disabled selected>Select an option<\/option>/);
    for (const re of [/appearance:none/, /font-size:16px/, /width:100%/, /data:image\/svg\+xml/, /:focus-visible\{outline:3px solid/, /option\{background-color:var\(--pf-in-bg\);color:var\(--pf-in-ink\)\}/]) assert.match(page, re);
    assert.strictEqual((await m.post('/preferences/unsubscribe', { csrf, scope: '' }, cookie)).headers.get('location'), '/preferences/manage?err=pick');
  } finally { await m.close(); }
});

test('callbots footer + shell: one shared footer on every page links /preferences; prefs page uses the callbots header, CSS and footer', () => {
  const { siteFooter } = require('../src/page'); const f = siteFooter();
  assert.match(f, /<li><a href="\/privacy">Privacy Policy<\/a><\/li>\s*<li><a href="\/terms">Terms of Service<\/a><\/li>\s*<li><a href="\/preferences">Email &amp; text preferences<\/a><\/li>/);
  assert.match(f, /CallBots<\/strong> is a product of Quanta X Technology LLC/); assert.match(f, /8134 122nd St N, Seminole, FL 33772/);
  const page = require('../src/prefs/page').pageHtml(site, '<p>x</p>');
  assert.match(page, /<header class="site-header">/); assert.match(page, /<span>CallBots<\/span>/); assert.ok(page.includes(f), 'same footer as the rest of callbots.org');
  assert.match(page, /<title>Email &amp; text preferences · RF Safe<\/title>/); assert.match(page, /name="robots" content="noindex"/);
  assert.doesNotMatch(page, /QuantaDose|quantadose/i, 'no QuantaDose branding leaks into RF Safe');
});

test('preferences inputs match the dark dropdown (bg, radius, 16px, focus ring, autofill, distinct disabled), themed for callbots', () => {
  const html = require('../src/prefs/page').pageHtml(site, '');
  assert.match(html, /:root\{--pf-in-bg:#10241e;--pf-in-ink:#f6f3ec;--pf-in-ph:#d5e6df;--pf-focus:#2a9d84;/);
  assert.match(html, /input\[type=text\]\{[^}]*border-radius:8px;border:1px solid #888;background-color:var\(--pf-in-bg\);color:var\(--pf-in-ink\)/);
  assert.match(html, /font-size:16px/); assert.match(html, /input\[type=text\]:focus-visible\{outline:3px solid var\(--pf-focus\)/);
  assert.match(html, /-webkit-autofill[^{]*\{[^}]*box-shadow:0 0 0 1000px var\(--pf-in-bg\) inset/);
  assert.match(html, /::placeholder\{color:var\(--pf-in-ph\);opacity:1\}/);
  assert.match(html, /:disabled\{background-color:var\(--pf-dis-bg\);[^}]*cursor:not-allowed/);
  assert.match(html, /stroke=%27%23f6f3ec%27/, 'chevron uses the input text colour'); assert.doesNotMatch(html, /CHEV/);
  // theme values are hex-only (no CSS injection from config)
  assert.match(require('../src/prefs/page').themedCss({ theme: { inBg: '#000;}body{x' } }), /--pf-in-bg:#120c2e;--/, 'invalid colour falls back to the default');
});

test('rfsafe: text controls on by default when the tenant has texting on; PREFS_SMS_ENABLED=0 hides them; never on while tenant sms_enabled is false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-')); const tenant = { id: 'rfsafe', numbers: ['+17276775572'], sms_enabled: true };
  const base = { dataDir: dir, tenants: { list: () => [tenant] }, newsletter: new Newsletter({ secret: 'x'.repeat(32), file: path.join(dir, 'n.jsonl') }), consent: new Consent(null), emailFor: () => new MockEmail(), smsFor: () => new MockTwilio() };
  assert.strictEqual(createPrefs({ ...base, env: {} }, site).smsOn(), true);
  assert.strictEqual(createPrefs({ ...base, env: { PREFS_SMS_ENABLED: '0' } }, site).smsOn(), false);
  tenant.sms_enabled = false; assert.strictEqual(createPrefs({ ...base, env: { PREFS_SMS_ENABLED: '1' } }, site).smsOn(), false);
  const qdLike = { ...site, id: 'other', smsDefaultOn: false }; tenant.sms_enabled = true; assert.strictEqual(createPrefs({ ...base, env: {} }, qdLike).smsOn(), false, 'sites without smsDefaultOn stay opt-in to the flag');
});

test('rfsafe wording: consent text reuses the callbots.org Privacy SMS wording; confirm text is the live news invite; no QuantaDose text', () => {
  const { renderPrivacy } = require('../src/legal'); const priv = renderPrivacy().replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
  for (const w of ['Consent to receive texts is not a condition of any purchase', 'about once a month, plus breaking news, up to 4 msgs/mo', 'Msg & data rates may apply', 'STOP', 'HELP']) { assert.ok(site.smsConsentText.includes(w), w); assert.ok(priv.includes(w), 'privacy has ' + w); }
  assert.match(site.smsConsentText, /https:\/\/callbots\.org\/privacy#sms/); assert.match(site.smsConsentText, /reply YES/);
  assert.strictEqual(site.smsConfirmText, 'RF Safe: Confirm texts from RF Safe preferences. ' + require('../src/newsletter').newsSmsInvite('RF Safe'));
  assert.ok(site.smsConfirmText.length <= 320); assert.match(site.smsCodeText('123456'), /^RF Safe: .*123456.*15 minutes/);
  for (const v of [site.smsConsentText, site.smsConfirmText, site.smsCodeText('1'), site.emailSubject]) assert.doesNotMatch(v, /QuantaDose|quantadose/i);
});

test('rfsafe STOP list: dropdown text opt-out writes to the callbots consent ledger (same as a STOP reply) and sends nothing', async () => {
  const m = await mk();
  try {
    const { cookie, csrf } = await m.login(); await m.post('/preferences/unsubscribe', { csrf, scope: 'texts', phone: '(727) 555-0199' }, cookie);
    assert.strictEqual(m.consent.isOptedOut('rfsafe', '+17275550199'), true); assert.strictEqual(m.tw.sent.length, 0);
  } finally { await m.close(); }
});

// ---- rfsafe manage-only texts (smsWebOptIn: false) and email sign-up switch ----
async function phoneLogin(m, phone = '+17275550142') {
  const n = m.tw.sent.length; await m.post('/preferences/start', { phone }); const code = m.tw.sent[n].body.match(/code is (\d{6})/)[1];
  const v = await m.post('/preferences/code', { phone, code }); const cookie = v.headers.get('set-cookie').split(';')[0];
  const page = await (await m.get('/preferences/manage', cookie)).text(); return { cookie, page, csrf: page.match(/name=csrf value="([^"]+)"/)[1] };
}
test('rfsafe live config: email web sign-up on, web text opt-in on, real call number', () => {
  assert.strictEqual(rfsafe.emailWebSignup, true); assert.strictEqual(rfsafe.smsWebOptIn, true); assert.strictEqual(rfsafe.callNumber, '(727) 677-5572'); assert.strictEqual(rfsafe.callNumberE164, '+17276775572');
});
test('manage-only texts: codes only to numbers with call consent; identical answer for known and unknown numbers', async () => {
  const m = await mk({ sms: true, cfg: rfsafeMO });
  try {
    m.consent.record('rfsafe', '+17275550142', 'verbal_call');
    const a = await (await m.post('/preferences/start', { phone: '(727) 555-0199' }, null, '2.2.2.2')).text(); assert.strictEqual(m.tw.sent.length, 0, 'no code to an unknown number');
    m.consent.record('rfsafe', '+17275550188', 'inbound'); await m.post('/preferences/start', { phone: '7275550188' }, null, '2.2.2.3'); assert.strictEqual(m.tw.sent.length, 0, 'inbound text alone is not call consent');
    const b = await (await m.post('/preferences/start', { phone: '(727) 555-0142' }, null, '2.2.2.4')).text(); assert.strictEqual(m.tw.sent.length, 1);
    assert.strictEqual(a.replace(/value="[^"]*"/g, ''), b.replace(/value="[^"]*"/g, ''), 'same page apart from the echoed number');
    assert.doesNotMatch(m.tw.sent[0].body, /YES/); assert.match(m.tw.sent[0].body, /^RF Safe: /);
  } finally { await m.close(); }
});
test('manage-only texts: only off + frequency; no turning on, no consent form, no confirmation text, call note shown', async () => {
  const m = await mk({ sms: true, cfg: rfsafeMO });
  try {
    const ph = '+17275550142'; m.consent.record('rfsafe', ph, 'verbal_call'); m.nl.requestSms({ tenant: 'rfsafe', phone: ph }); m.nl.confirmSms('rfsafe', ph, 'YES');
    const { cookie, page, csrf } = await phoneLogin(m); const sent0 = m.tw.sent.length;
    assert.match(page, /name=support_sms checked/); assert.match(page, /name=news_sms checked/); assert.match(page, /name=news_freq value="up4"/);
    assert.match(page, /To sign up for texts, call <a href="tel:\+17276775572">\(727\) 677-5572<\/a> and ask\./); assert.doesNotMatch(page, /id=sms-consent/);
    await m.post('/preferences/save', { csrf, support_sms: 'on', news_sms: 'on', news_freq: 'up4' }, cookie);
    assert.ok(m.p.core.auditLog().some((x) => x.channel === 'news_sms_frequency' && x.to === 'up4'));
    await m.post('/preferences/save', { csrf, support_sms: 'on', news_freq: 'daily' }, cookie); // news off; bogus frequency ignored
    assert.strictEqual(m.nl.smsState('rfsafe', ph).status, 'unsubscribed'); assert.strictEqual(m.consent.isOptedOut('rfsafe', ph), false);
    assert.ok(!m.p.core.auditLog().some((x) => x.to === 'daily'));
    let r = await m.post('/preferences/save', { csrf, support_sms: 'on', news_sms: 'on', consent: 'yes' }, cookie); // try to turn news back on
    assert.strictEqual(r.headers.get('location'), '/preferences/manage?err=sms_signup_by_phone'); assert.notStrictEqual(m.nl.smsState('rfsafe', ph).status, 'pending');
    await m.post('/preferences/save', { csrf }, cookie); assert.strictEqual(m.consent.isOptedOut('rfsafe', ph), true, 'link texts off = STOP');
    const after = await (await m.get('/preferences/manage', cookie)).text(); assert.match(after, /name=support_sms disabled/); assert.match(after, /name=news_sms disabled/);
    r = await m.post('/preferences/save', { csrf, support_sms: 'on', consent: 'yes' }, cookie); // re-enable from web is refused
    assert.strictEqual(r.headers.get('location'), '/preferences/manage?err=sms_signup_by_phone'); assert.strictEqual(m.consent.isOptedOut('rfsafe', ph), true);
    assert.match(await (await m.get('/preferences/manage?err=sms_signup_by_phone', cookie)).text(), /Texts can only be turned on by phone\. To sign up for texts, call \(727\) 677-5572 and ask\./);
    assert.strictEqual(m.tw.sent.length, sent0, 'no texts sent by any of this');
    assert.strictEqual(m.p.confirmSupportYes(ph), false, 'no web YES enrollment');
    await m.post('/preferences/unsubscribe', { csrf, scope: 'texts' }, cookie); assert.strictEqual(m.consent.isOptedOut('rfsafe', ph), true);
  } finally { await m.close(); }
});
test('manage-only texts: email-only session sees the call note, no text controls; posted text fields ignored', async () => {
  const m = await mk({ sms: true, cfg: rfsafeMO });
  try {
    const { cookie, csrf } = await m.login(); const page = await (await m.get('/preferences/manage', cookie)).text();
    assert.match(page, /Sign in with your mobile number to manage texts\./); assert.match(page, /call <a href="tel:\+17276775572">/); assert.doesNotMatch(page, /name=support_sms/);
    await m.post('/preferences/save', { csrf, support_sms: 'on', news_sms: 'on', consent: 'yes' }, cookie); assert.strictEqual(m.tw.sent.length, 0);
  } finally { await m.close(); }
});
test('smsWebOptIn: true on rfsafe = full web flow: number -> confirmation text -> YES -> enrolled', async () => {
  const m = await mk({ sms: true, cfg: { ...rfsafe, smsWebOptIn: true } });
  try {
    const n = 0; await m.post('/preferences/start', { phone: '7275550177' }); assert.strictEqual(m.tw.sent.length, n + 1, 'any number can get a code when web opt-in is on');
    const { cookie, csrf } = await phoneLogin(m, '+17275550177'); const sent = m.tw.sent.length;
    await m.post('/preferences/save', { csrf, news_sms: 'on', support_sms: 'on', consent: 'yes' }, cookie);
    assert.strictEqual(m.tw.sent.length, sent + 1); assert.strictEqual(m.tw.sent.at(-1).body, rfsafe.smsConfirmText);
    assert.strictEqual(m.nl.smsState('rfsafe', '+17275550177').status, 'pending'); assert.strictEqual(m.p.confirmSupportYes('+17275550177'), true);
    m.nl.confirmSms('rfsafe', '+17275550177', 'YES'); assert.strictEqual(m.nl.smsState('rfsafe', '+17275550177').status, 'subscribed');
  } finally { await m.close(); }
});
test('email: rfsafe lets new addresses join after the link; emailWebSignup:false sends links only to listed addresses, same answer', async () => {
  const m = await mk({ cfg: rfsafeMO });
  try { const { cookie, csrf } = await m.login('new@example.com'); await m.post('/preferences/save', { csrf, newsletter: 'on', name: 'Ann' }, cookie); assert.strictEqual(m.nl.isSubscriber('rfsafe', 'new@example.com'), true); } finally { await m.close(); }
  const c = await mk({ cfg: { ...rfsafe, emailWebSignup: false } });
  try {
    const a = await (await c.post('/preferences/start', { email: 'stranger@example.com' })).text(); assert.strictEqual(c.mail.sent.length, 0);
    c.nl.append({ kind: 'confirmed', tenant: 'rfsafe', email: 'old@example.com', name: 'Old' }); c.nl.append({ kind: 'unsubscribed', tenant: 'rfsafe', email: 'old@example.com' });
    const b = await (await c.post('/preferences/start', { email: 'old@example.com' })).text(); assert.strictEqual(c.mail.sent.length, 1); assert.strictEqual(a, b);
    const r = await c.post('/preferences/verify', { t: c.tokOf() }); const cookie = r.headers.get('set-cookie').split(';')[0]; const csrf = (await (await c.get('/preferences/manage', cookie)).text()).match(/name=csrf value="([^"]+)"/)[1];
    await c.post('/preferences/save', { csrf, newsletter: 'on', name: 'Old' }, cookie); assert.strictEqual(c.nl.isSubscriber('rfsafe', 'old@example.com'), true, 'listed address may turn it back on');
  } finally { await c.close(); }
});

test('email session picks up the number linked on a call; call-approved link + news texts show as on; thanks banner lists them', async () => {
  const m = await mk({ sms: true });
  try {
    const PH = '+17275550142';
    m.nl.append({ kind: 'confirmed', tenant: 'rfsafe', email: 'jane@example.com', name: 'Jane' });
    m.nl.linkPhone({ tenant: 'rfsafe', email: 'jane@example.com', phone: PH, call: 'c1' });
    m.consent.record('rfsafe', PH, 'verbal_call');
    m.nl.requestSms({ tenant: 'rfsafe', phone: PH, call: 'c1', wording: 'w' }); assert.ok(m.nl.confirmSms('rfsafe', PH, 'YES'));
    const { cookie } = await m.login(); const page = await (await m.get('/preferences/manage', cookie)).text();
    assert.doesNotMatch(page, /Text options are not available right now/);
    assert.match(page, /name=support_sms checked/); assert.match(page, /name=news_sms checked/); assert.match(page, /\+1•••0142/);
    assert.match(page, /id=thanks-banner/); assert.match(page, /Thanks for being subscribed to RF Safe!/); assert.match(page, /You&#39;re getting: monthly newsletter, link texts, RF Safe news texts\./);
    m.consent.record('rfsafe', PH, 'stop'); const p2 = await (await m.get('/preferences/manage', cookie)).text();
    assert.doesNotMatch(p2, /name=support_sms checked/, 'STOP list wins over call consent');
  } finally { await m.close(); }
});

test('email session with no linked number: texts offer an add-your-number code form, not "not available"; no banner when not subscribed', async () => {
  const m = await mk({ sms: true });
  try {
    const { cookie } = await m.login('new@example.com'); const page = await (await m.get('/preferences/manage', cookie)).text();
    assert.match(page, /id=sms-add-phone/); assert.match(page, /<form method=post action="\/preferences\/start" id=add-phone><\/form>/); assert.doesNotMatch(page, /Text options are not available/);
    assert.doesNotMatch(page, /id=thanks-banner/);
  } finally { await m.close(); }
});

test('thanks banner is per-site: a site without thanksBanner shows none', async () => {
  const cfg = { ...site }; delete cfg.thanksBanner; const m = await mk({ cfg });
  try { m.nl.append({ kind: 'confirmed', tenant: 'rfsafe', email: 'jane@example.com' }); const { cookie } = await m.login(); assert.doesNotMatch(await (await m.get('/preferences/manage', cookie)).text(), /thanks-banner/); }
  finally { await m.close(); }
});
