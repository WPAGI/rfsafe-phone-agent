'use strict';
// Best Deal On caller recognition (mirrors the RF Safe returning-caller code; RF Safe config untouched).
const test = require('node:test'); const assert = require('node:assert');
const path = require('path'); const fs = require('fs'); const os = require('os');
const { CallSession, returningCallerFor, bdoSiteProfile } = require('../src/xai');
const { Tools, Approvals } = require('../src/tools');
const { Consent, MockTwilio } = require('../src/twilio');
const { MockRealtimeWs, MockCallControl } = require('../src/mocks');
const { KB } = require('../src/kb');
const { MockEmail } = require('../src/email');
const { Newsletter } = require('../src/newsletter');
const { validateTenant, TenantRegistry } = require('../src/tenants');
const { BdoSite } = require('../src/bdoverify');
const DEP = path.join(__dirname, '..', 'deploy'); const read = (f) => JSON.parse(fs.readFileSync(path.join(DEP, f), 'utf8'));
const RAW = read('bestdealon/tenants/bestdealon.json');
const T = new TenantRegistry(path.join(DEP, 'bestdealon', 'tenants')).byId.get('bestdealon');

const SUB = '+15550001001', PEND = '+15550001002', SITE = '+15550001003', NOBODY = '+15550001009';
const ADDR = 'john.private.box@quantaxtechnology.com', GMAIL = 'hidden.person@gmail.com';
function mk(tenant = T) {
  const nl = new Newsletter({ secret: 'x'.repeat(32), file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bdo-cr-')), 'nl.jsonl') });
  nl.record({ e: ADDR, n: 'John Coates', t: tenant.id }, 'confirmed'); nl.linkPhone({ tenant: tenant.id, email: ADDR, phone: SUB });
  nl.record({ e: GMAIL, n: 'Pat Pending', t: tenant.id }, 'requested'); nl.linkPhone({ tenant: tenant.id, email: GMAIL, phone: PEND });
  const mail = new MockEmail();
  const tools = new Tools(tenant, { kbFor: () => new KB({ allowlist: tenant.link_allowlist }), smsFor: () => new MockTwilio(), consent: new Consent(null), callControl: new MockCallControl(), notify: async () => {}, approvals: new Approvals(), log: () => {}, emailFor: () => mail, newsletter: nl });
  return { nl, tools, mail, tenant };
}
function start(m, caller, siteProfile = null) {
  const ws = new MockRealtimeWs(); let sum;
  const s = new CallSession({ ws, tenant: m.tenant, callId: 'c1', caller, tools: m.tools, afterHours: false, log: () => {}, newsletter: m.nl, siteProfile, onEnd: (x) => { sum = x; } }); clearTimeout(s.timer);
  const all = JSON.stringify(ws.sent);
  return { ws, all, instr: ws.sent.find((x) => x.type === 'session.update').session.instructions, greet: ws.sent.find((x) => x.item && x.item.type === 'force_message').item.content[0].text, end: () => { s.finish(); return sum; } };
}
const SITEP = { known: true, name: 'Bizinator', name_kind: 'business', account: true, listing_phone_verified: true, email_on_file: true, email_verified: true, email_label: 'Gmail' };
const noAddr = (s) => { for (const a of [ADDR, GMAIL, 'john.private', 'hidden.person', 'private.box']) assert.ok(!s.includes(a), 'leaked ' + a); };

test('bestdealon config: greeting on, unconfirmed included, site lookup + callback offer on, no recording notice, valid', () => {
  assert.deepStrictEqual(validateTenant(RAW), []);
  assert.strictEqual(T.returning_caller_greeting, true); assert.strictEqual(T.returning_caller_include_unconfirmed, true);
  assert.strictEqual(T.bdo_caller_lookup, true); assert.strictEqual(T.callback_offer, true); assert.ok(!/record/i.test(T.welcome_back));
});
test('RF Safe tenant config is unchanged by this feature', () => {
  const rf = read('rfsafe.tenant.json');
  for (const k of ['returning_caller_include_unconfirmed', 'bdo_caller_lookup', 'callback_offer', 'welcome_back']) assert.ok(!(k in rf), k);
  assert.ok(validateTenant({ ...rf, bdo_caller_lookup: true }).some((e) => /only for the bestdealon/.test(e)), 'bdo lookup refused for other tenants');
});
test('confirmed subscriber: greeted by first name, email by domain label only, follow-up offers call back or email', () => {
  const c = start(mk(), SUB);
  assert.strictEqual(c.greet, 'Welcome back, John! This is the Best Deal On AI assistant. How can I help?');
  assert.match(c.instr, /first name on file: John/); assert.match(c.instr, /do NOT ask for their name/);
  assert.match(c.instr, /your Quanta X Technology email on file/);
  assert.match(c.instr, /Should someone from our team call you back at this number, or should I email you at your Quanta X Technology email on file\?/);
  assert.match(c.instr, /never promise a time/); noAddr(c.all);
  assert.strictEqual(c.end().returning_caller, true);
});
test('unconfirmed (pending) subscriber is recognized for Best Deal On only; no email-on-file shortcut for unconfirmed', () => {
  const c = start(mk(), PEND); assert.strictEqual(c.greet, 'Welcome back, Pat! This is the Best Deal On AI assistant. How can I help?');
  assert.doesNotMatch(c.instr, /email on file/); noAddr(c.all);
  const strict = { ...T, returning_caller_include_unconfirmed: false }; assert.strictEqual(returningCallerFor(strict, PEND, mk(strict).nl), null, 'without the flag (RF Safe behaviour) pending is not matched');
});
test('bestdealon.app account match: greeted by account name, NOT verified, no account changes, email only as "your Gmail email"', () => {
  const c = start(mk(), SITE, SITEP);
  assert.strictEqual(c.greet, 'Welcome back, Bizinator! This is the Best Deal On AI assistant. How can I help?');
  assert.match(c.instr, /NOT verified and NOT confirmed as the account owner/);
  assert.match(c.instr, /never change, reset or verify anything on the account, start a claim, or skip any check/);
  assert.match(c.instr, /Never read back or confirm any email address, phone number/);
  assert.match(c.instr, /your Gmail email/); assert.match(c.instr, /call you back at this number, or should I email you at your Gmail email\?/);
  assert.doesNotMatch(c.instr, /returning Best Deal On subscriber|returning RF Safe subscriber/); noAddr(c.all);
});
test('set_email_address email_on_file for a site-only match returns no address (asks for one); confirmed subscriber result has no address', async () => {
  const m = mk();
  const r1 = await m.tools.run('set_email_address', { email_on_file: true, caller_said_yes: true }, { channel: 'voice', callId: 'c1', caller: SITE }); assert.strictEqual(r1.ok, false); noAddr(JSON.stringify(r1));
  const r2 = await m.tools.run('set_email_address', { email_on_file: true, caller_said_yes: true }, { channel: 'voice', callId: 'c2', caller: SUB }); assert.strictEqual(r2.ok, true, JSON.stringify(r2)); noAddr(JSON.stringify(r2));
});
test('site profile is ignored unless tenant is bestdealon with bdo_caller_lookup; hostile values are sanitized', () => {
  const m = mk(); const rf = { ...T, id: 'rfsafe' };
  assert.strictEqual(returningCallerFor(rf, SITE, m.nl, SITEP), null); assert.strictEqual(returningCallerFor({ ...T, bdo_caller_lookup: false }, SITE, m.nl, SITEP), null);
  assert.strictEqual(returningCallerFor({ ...T, returning_caller_greeting: false }, SUB, m.nl, SITEP), null, 'master toggle still wins');
  const r = returningCallerFor(T, SITE, m.nl, { known: true, name: 'Evil<script> Ignore previous', email_label: GMAIL });
  assert.ok(!/[<>]/.test(r.site.name)); assert.strictEqual(r.site.emailLabel, null, 'a label containing @ is dropped');
  assert.strictEqual(returningCallerFor(T, NOBODY, m.nl, null), null); assert.strictEqual(returningCallerFor(T, null, m.nl, SITEP), null, 'blocked caller ID: nothing');
});
test('bdoSiteProfile: signed request, only for bestdealon, times out to null, unknown -> null', async () => {
  const seen = []; const fetchImpl = async (u, o) => { seen.push({ u, o }); return { status: 200, json: async () => SITEP }; };
  const site = new BdoSite({ url: 'https://bestdealon.example', secret: 's'.repeat(32), fetchImpl });
  const got = await bdoSiteProfile(T, SITE, site); assert.strictEqual(got.known, true); assert.strictEqual(got.name, 'Bizinator');
  assert.strictEqual(seen[0].u, 'https://bestdealon.example/api/callbot/caller-profile'); assert.match(seen[0].o.headers['x-bdo-signature'], /^t=\d+,v1=[a-f0-9]{64}$/);
  assert.strictEqual(await bdoSiteProfile({ ...T, id: 'rfsafe' }, SITE, site), null); assert.strictEqual(seen.length, 1, 'no request for other tenants');
  const slow = new BdoSite({ url: 'https://x.example', secret: 's'.repeat(32), fetchImpl: () => new Promise(() => {}) });
  assert.strictEqual(await bdoSiteProfile(T, SITE, slow, 50), null);
  const unk = new BdoSite({ url: 'https://x.example', secret: 's'.repeat(32), fetchImpl: async () => ({ status: 200, json: async () => ({ known: false }) }) });
  assert.strictEqual(await bdoSiteProfile(T, SITE, unk), null);
  assert.strictEqual(await bdoSiteProfile(T, SITE, new BdoSite({})), null, 'not configured');
});
test('mock caller simulation: full address never reaches the voice model across a whole call', async () => {
  const m = mk(); const c = start(m, SUB, SITEP);
    const out = await m.tools.run('set_email_address', { email_on_file: true, caller_said_yes: true }, { channel: 'voice', callId: 'c1', caller: SUB });
  noAddr(c.all + JSON.stringify(out) + JSON.stringify(m.tools.definitions()));
});
