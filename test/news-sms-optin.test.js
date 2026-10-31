'use strict';
const test = require('node:test'); const assert = require('node:assert');
const path = require('path'); const fs = require('fs'); const os = require('os');
const { Tools, Approvals } = require('../src/tools');
const { Consent, MockTwilio } = require('../src/twilio');
const { MockCallControl } = require('../src/mocks');
const { KB } = require('../src/kb');
const { MockEmail } = require('../src/email');
const { Newsletter } = require('../src/newsletter');
const { handleInboundSms } = require('../src/sms');
const { newsletterRows, NL_COLS, toCsv } = require('../src/admin');
const { renderPrivacy } = require('../src/legal');
const PH = '+17275550142';
function mk() {
  const t = { id: 'r', name: 'RF Safe', numbers: [], link_allowlist: ['rfsafe.org', 'quantacase.com'], support_email: 'support@rfsafe.com', sms_enabled: true, instant_link_reply: true, email_enabled: true, blocked_topics: [] };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nls-')), 'newsletter.jsonl');
  const nl = new Newsletter({ secret: 'x'.repeat(32), file }); const sms = new MockTwilio(); const consent = new Consent(null); const mail = new MockEmail();
  const tools = new Tools(t, { kbFor: () => new KB({ allowlist: t.link_allowlist }), smsFor: () => sms, consent, callControl: new MockCallControl(), notify: async () => {}, approvals: new Approvals(), log: () => {}, emailFor: () => mail, newsletter: nl });
  const inbound = (body) => handleInboundSms({ tenant: t, from: PH, body, consent, toolsFor: () => tools, brain: { reply: async () => 'ok' }, instructions: '', log: () => {}, newsletter: nl });
  return { t, nl, sms, tools, inbound, file, consent };
}
const voice = (id = 'c1') => ({ channel: 'voice', callId: id, caller: PH });
const sentBodies = (sms) => JSON.stringify(sms);
test('news opt-in: invite with disclosures, pending until YES, YES confirms, STOP cancels', async () => {
  const m = mk();
  await m.tools.run('set_text_number', { use_caller_id: true }, voice());
  const r = await m.tools.run('send_link_sms', { url: 'https://rfsafe.org/a', news_optin: true }, voice());
  assert.strictEqual(r.ok, true); assert.strictEqual(r.news_invite, true);
  const body = sentBodies(m.sms);
  for (const re of [/Reply YES/, /About once a month, plus breaking news\./, /up to 4 msgs\/mo/, /Msg & data rates may apply/, /STOP/, /HELP/, /Consent not required/]) assert.match(body, re);
  assert.strictEqual(m.nl.smsState('r', PH).status, 'pending'); assert.strictEqual(m.nl.isSmsSubscriber('r', PH), false);
  const y = await m.inbound('Yes'); assert.match(y, /subscribed to RF Safe news texts/); assert.match(y, /Msg & data rates may apply/);
  assert.strictEqual(m.nl.isSmsSubscriber('r', PH), true);
  const row = newsletterRows(m.file)[0]; assert.strictEqual(row.sms_optin, 'subscribed'); assert.strictEqual(row.sms_call, 'c1'); assert.match(row.sms_consent_wording, /reply YES/i); assert.ok(row.sms_confirmed_at); assert.strictEqual(row.sms_confirm_reply, 'Yes');
  // existing subscriber recognized on next call; no invite added
  const s2 = await m.tools.run('set_text_number', { use_caller_id: true }, voice('c2')); assert.strictEqual(s2.already_news_subscriber, true);
  await m.inbound('STOP'); assert.strictEqual(m.nl.smsState('r', PH).status, 'unsubscribed'); assert.strictEqual(newsletterRows(m.file)[0].sms_optin, 'unsubscribed');
});
test('no invite without spoken yes; plain YES without pending request is just START', async () => {
  const m = mk(); await m.tools.run('set_text_number', { use_caller_id: true }, voice());
  await m.tools.run('send_link_sms', { url: 'https://rfsafe.org/a' }, voice());
  assert.ok(!/Reply YES/.test(sentBodies(m.sms))); assert.strictEqual(m.nl.smsState('r', PH).status, 'none');
  assert.match(await m.inbound('YES'), /resubscribed/); assert.strictEqual(m.nl.isSmsSubscriber('r', PH), false);
});
test('one record ties email + phone with separate consents; CSV has both channels', async () => {
  const m = mk(); const v = voice();
  await m.tools.run('set_email_address', { email: 'jo@example.com', caller_said_yes: true }, v);
  await m.tools.run('send_email', { urls: ['https://rfsafe.org/a'], newsletter_optin: true }, v);
  m.nl.record({ e: 'jo@example.com', t: 'r' }, 'confirmed');
  await m.tools.run('set_text_number', { use_caller_id: true }, v);
  await m.tools.run('send_link_sms', { url: 'https://rfsafe.org/a', news_optin: true }, v);
  const rows = newsletterRows(m.file); assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].email, 'jo@example.com'); assert.strictEqual(rows[0].phone, PH); assert.strictEqual(rows[0].email_optin, 'subscribed'); assert.strictEqual(rows[0].sms_optin, 'pending');
  const csv = toCsv(NL_COLS, rows); assert.match(csv.split('\r\n')[0], /phone,email_optin,sms_optin/);
});
test('privacy page describes news texts double opt-in', () => { const h = renderPrivacy(); assert.match(h, /news texts/); assert.match(h, /up to 4 messages a month/); assert.match(h, /reply YES/); });

test('confirmed consent record stores wording, timestamps, number and source', async () => {
  const { newsSmsInvite } = require('../src/newsletter');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-')); let t = Date.parse('2026-10-30T12:00:00Z');
  const nl = new Newsletter({ file: path.join(dir, 'nl.jsonl'), secret: 'x', now: () => t });
  const inv = newsSmsInvite('RF Safe'); nl.requestSms({ tenant: 'r', phone: '+15550001111', call: 'c1', wording: { spoken: 's', text: inv } });
  t += 60000; assert.ok(nl.confirmSms('r', '+15550001111', 'YES'));
  const rec = nl.events().find((e) => e.kind === 'sms_confirmed');
  assert.strictEqual(rec.phone, '+15550001111'); assert.strictEqual(rec.wording.text, inv); assert.strictEqual(rec.invited_at, '2026-10-30T12:00:00.000Z');
  assert.strictEqual(rec.at, '2026-10-30T12:01:00.000Z'); assert.strictEqual(rec.source, 'phone_call+sms_yes'); assert.strictEqual(rec.call, 'c1');
});
