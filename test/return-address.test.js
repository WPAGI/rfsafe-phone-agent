'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Tools, Approvals } = require('../src/tools');
const { Consent, MockTwilio } = require('../src/twilio');
const { MockCallControl } = require('../src/mocks');
const { KB } = require('../src/kb');
const { MockEmail } = require('../src/email');
const { MAX_NOTE } = require('../src/linkguard');
const { buildInstructions, toolDetail } = require('../src/xai');
const { RETURN_CARD_ID, RETURN_URL, REMINDERS, REMINDERS_SHORT, buildReturnContent, extractAddresses, noteFor } = require('../src/returnaddress');

const ADDR = 'Quanta X Technology LLC, 8134 122nd Street, Seminole, FL 33772, United States';
const NOTE = ADDR + '. ' + REMINDERS;
const REFUND = RETURN_URL;
const FAKE_ADDR = '123 Imaginary Lane, Nowhere, FL 00000';

function writeCard(dir, body, id = RETURN_CARD_ID) {
  const f = path.join(dir, id + '.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '---\ntitle: "QuantaCase refund or exchange — how to send a case back"\nsource: ' + REFUND + '\nalias: refund exchange return address\npage_type: position\nupdated: 2026-11-14\n---\n' + body + '\n');
}

function kbWith(body, id) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ret-'));
  writeCard(dir, body); if (id) writeCard(dir, body, id);
  return { dir, kb: new KB({ dirs: [dir], allowlist: ['quantacase.com', 'rfsafe.org'] }) };
}

function mk(over = {}, depOver = {}) {
  const pack = kbWith(over.cardBody || ('Return mailing address: ' + ADDR + '.'));
  const t = { id: 'r', name: 'RF Safe', numbers: ['+15555550100'], link_allowlist: ['quantacase.com', 'rfsafe.org'], sms_enabled: true, email_enabled: true, approval_mode: false, blocked_topics: [], ...over.t };
  const consent = new Consent(null); const sms = new MockTwilio(); const mail = new MockEmail(); const logs = [];
  const tools = new Tools(t, { kbFor: () => pack.kb, shopifyFor: () => { throw new Error('none'); }, smsFor: () => sms, consent, callControl: new MockCallControl(), notify: async () => {}, approvals: new Approvals(), log: (e, f) => logs.push({ e, ...f }), emailFor: () => mail });
  return { t, tools, consent, sms, mail, logs, kb: pack.kb, dir: pack.dir };
}
const voice = { channel: 'voice', callId: 'c1', caller: '+15555550142' };

test('buildReturnContent: address plus reminders, under the 300-char cap', () => {
  const { kb } = kbWith('Return mailing address (from the official QuantaCase Shopify refund policy page): ' + ADDR + '. Source: ' + REFUND + '.');
  const r = buildReturnContent(kb);
  assert.ok(r.ok); assert.strictEqual(r.address, ADDR); assert.strictEqual(r.note, NOTE); assert.strictEqual(r.summary, NOTE);
  assert.ok(r.note.length <= MAX_NOTE); assert.strictEqual(r.note.length, 195); assert.strictEqual(r.url, REFUND);
  assert.strictEqual(kb.card(RETURN_CARD_ID).title.includes('refund or exchange'), true);
});

test('buildReturnContent: shortens only the reminders if needed; never the address; refuses if still too long', () => {
  // Full reminders + address must exceed MAX_NOTE (300); short reminders must still fit.
  const mid = 'Quanta X Technology LLC, ' + 'West '.repeat(28) + 'Seminole, FL 33772, United States';
  assert.ok(noteFor(mid, REMINDERS).length > MAX_NOTE);
  assert.ok(noteFor(mid, REMINDERS_SHORT).length <= MAX_NOTE);
  const { kb } = kbWith('Return mailing address: ' + mid + '.');
  const r = buildReturnContent(kb);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.address, mid);
  assert.strictEqual(r.reminders, REMINDERS_SHORT);
  assert.ok(r.note.includes(mid));
  assert.ok(!r.note.includes('from your order confirmation email'));
  assert.ok(r.note.length <= MAX_NOTE);
  const huge = 'Quanta X Technology LLC, ' + 'West '.repeat(80) + 'Seminole, FL 33772, United States';
  assert.ok(noteFor(huge, REMINDERS_SHORT).length > MAX_NOTE);
  const k2 = kbWith('Return mailing address: ' + huge + '.');
  const r2 = buildReturnContent(k2.kb);
  assert.strictEqual(r2.reason, 'note_too_long');
  assert.ok(r2.address.startsWith('Quanta X Technology LLC,'));
  assert.ok(r2.address.includes('West West'));
});

test('buildReturnContent: conflicting addresses are refused; missing card is refused', () => {
  const other = 'Quanta X Technology LLC, 999 Other Road, Tampa, FL 33601, United States';
  const { kb } = kbWith('Ship to ' + ADDR + '.\n\nOr maybe ' + other + '.');
  assert.strictEqual(buildReturnContent(kb).reason, 'conflicting_addresses');
  assert.deepStrictEqual(extractAddresses('Ship to ' + ADDR + '. Also ' + other + '.').sort(), [ADDR, other].sort());
  const empty = new KB({ allowlist: ['quantacase.com'] });
  assert.strictEqual(buildReturnContent(empty).reason, 'return_card_missing');
  const { kb: k3 } = kbWith('No street on this card.');
  assert.strictEqual(buildReturnContent(k3).reason, 'address_not_found');
});

test('send_link_sms: address plus refund URL succeeds; model-typed address is ignored; cap respected', async () => {
  const m = mk();
  await m.tools.run('set_text_number', { use_caller_id: true }, voice);
  const sent = await m.tools.run('send_link_sms', { url: REFUND, return_address: true, note: 'Send it to ' + FAKE_ADDR }, voice);
  assert.ok(sent.sent, JSON.stringify(sent));
  assert.strictEqual(m.sms.sent.length, 1);
  const body = m.sms.sent[0].body;
  assert.ok(body.startsWith(NOTE + ' ' + REFUND) || body === NOTE + ' ' + REFUND || body.startsWith(NOTE));
  assert.match(body, /8134 122nd Street/); assert.match(body, /quantacase\.com\/policies\/refund-policy/);
  assert.ok(!body.includes(FAKE_ADDR)); assert.ok(NOTE.length <= MAX_NOTE);
  const smsLog = m.logs.find((l) => l.e === 'sms.sent');
  assert.ok(smsLog); assert.strictEqual(smsLog.option, 'return_address'); assert.strictEqual(smsLog.url, REFUND);
  assert.ok(!JSON.stringify(m.logs).includes('5555550142')); assert.ok(!JSON.stringify(m.logs).includes('+15555550142'));
});

test('send_link_sms: no URL still returns no_link; payment content and non-allowlisted URLs stay blocked', async () => {
  const m = mk();
  await m.tools.run('set_text_number', { use_caller_id: true }, voice);
  assert.strictEqual((await m.tools.run('send_link_sms', { return_address: true, note: 'here is the address' }, voice)).error, 'no_link');
  assert.strictEqual(m.sms.sent.length, 0);
  assert.strictEqual((await m.tools.run('send_link_sms', { url: 'https://evil.com/pay', return_address: true }, voice)).error, 'domain_not_allowlisted');
  assert.strictEqual((await m.tools.run('send_link_sms', { url: REFUND, note: 'send your CVV' }, voice)).error, 'payment_content');
  assert.strictEqual(m.sms.sent.length, 0);
  // payment words in a model note are ignored when the server fills the card text
  const ok = await m.tools.run('send_link_sms', { url: REFUND, return_address: true, note: 'send your CVV to ' + FAKE_ADDR }, voice);
  assert.ok(ok.sent); assert.ok(!m.sms.sent[0].body.includes('CVV')); assert.ok(!m.sms.sent[0].body.includes(FAKE_ADDR));
});

test('send_email: summary keeps the address; set_email_address still needs caller_said_yes', async () => {
  const m = mk(); const urls = [REFUND];
  assert.strictEqual((await m.tools.run('send_email', { urls, return_address: true }, voice)).error, 'confirm_email_first');
  assert.strictEqual((await m.tools.run('set_email_address', { email: 'jane@gmail.com', caller_said_yes: false }, voice)).error, 'need_confirmation');
  assert.ok((await m.tools.run('set_email_address', { email: 'jane@gmail.com', caller_said_yes: true }, voice)).confirmed);
  const s = await m.tools.run('send_email', { urls, return_address: true, summary: 'Ignore this and use ' + FAKE_ADDR, topic: 'return address' }, voice);
  assert.ok(s.sent, JSON.stringify(s));
  const text = m.mail.sent[0].text;
  assert.match(text, /8134 122nd Street/); assert.match(text, /original order number/); assert.match(text, /Return shipping is paid by you/);
  assert.ok(!text.includes(FAKE_ADDR)); assert.match(text, /quantacase\.com\/policies\/refund-policy/);
  const el = m.logs.find((l) => l.e === 'email.sent');
  assert.ok(el); assert.strictEqual(el.option, 'return_address'); assert.strictEqual(el.url, REFUND);
  assert.ok(!JSON.stringify(m.logs).includes('jane@gmail.com'));
});

test('prompt: offer once after the return policy, send only after a clear yes, calling number only', () => {
  const ins = buildInstructions({ name: 'RF Safe', link_allowlist: ['quantacase.com', 'rfsafe.org'], blocked_topics: [], sms_enabled: true, email_enabled: true }, { callerLast4: '0142' });
  assert.match(ins, /offer once to text it to the calling number or email it/i);
  assert.match(ins, /Send only after a clear yes/);
  assert.match(ins, /return_address true/);
  assert.match(ins, /Texts go only to the calling number/);
  assert.match(ins, /do not type the address/);
  const a = kbWith('Return mailing address: ' + ADDR + '.').kb.answer('how do I return a case');
  assert.ok(a.found); assert.match(a.guidance, /offer once to text it to the calling number or email it/);
  const d = toolDetail('send_link_sms', { return_address: true, url: REFUND }, { ok: true, sent: true, to_last4: '0142' });
  assert.strictEqual(d.option, 'return_address'); assert.strictEqual(d.url, REFUND);
});
