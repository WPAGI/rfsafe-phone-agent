'use strict';
const test = require('node:test'); const assert = require('node:assert');
const path = require('path'); const fs = require('fs'); const os = require('os');
const { Tools, Approvals } = require('../src/tools');
const { Consent, MockTwilio } = require('../src/twilio');
const { MockCallControl } = require('../src/mocks');
const { KB } = require('../src/kb');
const { MockEmail, buildEmail, AI_NOTE } = require('../src/email');
const { Newsletter, cleanName, deriveSecret } = require('../src/newsletter');
const { buildInstructions } = require('../src/xai');
const { renderPrivacy } = require('../src/legal');
const { startApp } = require('./helpers');
const voice = { channel: 'voice', callId: 'c1', caller: '+15555550142' };
function mk() {
  const t = { id: 'r', name: 'RF Safe', numbers: [], link_allowlist: ['rfsafe.org', 'quantacase.com'], support_email: 'support@rfsafe.com', sms_enabled: false, email_enabled: true, blocked_topics: [] };
  const mail = new MockEmail(); const logs = [];
  const nl = new Newsletter({ secret: 'x'.repeat(32), file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nl-')), 'newsletter.jsonl') });
  const tools = new Tools(t, { kbFor: () => new KB({ allowlist: t.link_allowlist }), smsFor: () => new MockTwilio(), consent: new Consent(null), callControl: new MockCallControl(), notify: async () => {}, approvals: new Approvals(), log: (e, f) => logs.push({ e, ...f }), emailFor: () => mail, newsletter: nl });
  return { tools, mail, logs, nl };
}
test('AI disclaimer at the very bottom of text and html', () => {
  const { text, html } = buildEmail({ links: [{ url: 'https://rfsafe.org/a' }] });
  assert.ok(text.trimEnd().endsWith(AI_NOTE)); assert.match(AI_NOTE, /AI can make mistakes/);
  assert.match(html, /font-size:11px;color:#999">This reply was written by RF Safe&#39;s AI assistant\. AI can make mistakes\.<\/p>$/);
});
test('greeting: name sanitized, Hi there fallback, name not logged', async () => {
  assert.strictEqual(cleanName("  Mary-Jo O'Neil<script>1 "), "Mary-Jo O'Neilscript");
  assert.strictEqual(cleanName('a'.repeat(60)).length, 40);
  assert.match(buildEmail({ links: [{ url: 'https://rfsafe.org/a' }] }).text, /^Hi there, thank you for requesting information from RF Safe\./);
  const m = mk(); await m.tools.run('set_email_address', { email: 'jane@gmail.com', caller_said_yes: true }, voice);
  await m.tools.run('send_email', { urls: ['https://rfsafe.org/a'], recipient_name: 'Janeth<b>' }, voice);
  assert.match(m.mail.sent[0].text, /^Hi Janethb, thank you for requesting information from RF Safe\./);
  assert.ok(!m.mail.sent[0].text.includes('newsletter/confirm'));
  assert.ok(!JSON.stringify(m.logs).includes('Janeth'));
});
test('newsletter link only on opt-in; token sign/verify/expiry', async () => {
  const m = mk(); await m.tools.run('set_email_address', { email: 'jane@gmail.com', caller_said_yes: true }, voice);
  await m.tools.run('send_email', { urls: ['https://rfsafe.org/a'], recipient_name: 'Jane', newsletter_optin: true }, voice);
  const e = m.mail.sent[0]; assert.match(e.html, /Confirm my newsletter subscription/); assert.ok(e.text.trimEnd().endsWith(AI_NOTE));
  const tok = new URL(e.text.match(/https:\/\/callbots\.org\/newsletter\/confirm\?t=\S+/)[0]).searchParams.get('t');
  const o = m.nl.verify(tok, 'sub'); assert.strictEqual(o.e, 'jane@gmail.com'); assert.strictEqual(o.t, 'r');
  assert.strictEqual(m.nl.verify(tok, 'unsub'), null); assert.strictEqual(m.nl.verify(tok.slice(0, -2) + 'AA', 'sub'), null);
  const old = m.nl.token({ email: 'a@b.com', tenant: 'r', ts: Date.now() - 31 * 864e5 }); assert.strictEqual(m.nl.verify(old, 'sub'), null);
  assert.deepStrictEqual(m.nl.subscribers(), []); // not subscribed until click
  assert.strictEqual(deriveSecret({ NEWSLETTER_SECRET: 'z'.repeat(64) }), 'z'.repeat(64)); assert.strictEqual(deriveSecret({ PA_ADMIN_TOKEN: 'abc' }).length, 64);
});
test('instructions and privacy cover name, anything-else, newsletter, send', () => {
  const ins = buildInstructions({ id: 'r', name: 'RF Safe', link_allowlist: ['rfsafe.org'], email_enabled: true, sms_enabled: false, blocked_topics: [] }, { afterHours: false });
  const s = typeof ins === 'string' ? ins : JSON.stringify(ins);
  for (const re of [/who you should address the email to/, /anything else you would like me to include/, /Would you like to receive RF Safe's monthly newsletter\? If so, I'll include a confirmation link in the email\./, /If that's it, I'll send it right now\./]) assert.match(s, re);
  const p = renderPrivacy(); assert.match(p, /id="newsletter"/); assert.match(p, /double opt-in/); assert.match(p, /nsubscribe/);
});
test('HTTP: GET shows button only, POST confirms, unsubscribe, admin list', async () => {
  const a = await startApp();
  try {
    const nl = a.deps.newsletter; const tok = nl.token({ email: 'Jane@gmail.com', name: 'Jane', tenant: 'rfsafe' });
    let r = await fetch(a.base + '/newsletter/confirm?t=' + tok); assert.strictEqual(r.status, 200); assert.match(await r.text(), /<form method="post"/);
    const admin = { authorization: 'Bearer demo-admin-token-EXAMPLE' };
    assert.strictEqual((await (await fetch(a.base + '/admin/newsletter/subscribers', { headers: admin })).json()).count, 0);
    assert.strictEqual((await fetch(a.base + '/newsletter/confirm?t=bad.sig')).status, 400);
    r = await fetch(a.base + '/newsletter/confirm', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 't=' + encodeURIComponent(tok) });
    assert.strictEqual(r.status, 200); assert.match(await r.text(), /Thank you/);
    assert.strictEqual((await fetch(a.base + '/admin/newsletter/subscribers')).status, 401);
    let j = await (await fetch(a.base + '/admin/newsletter/subscribers', { headers: admin })).json();
    assert.strictEqual(j.count, 1); assert.strictEqual(j.subscribers[0].email, 'jane@gmail.com'); assert.strictEqual(j.subscribers[0].source, 'phone'); assert.strictEqual(j.subscribers[0].name, 'Jane');
    const ut = nl.token({ email: 'jane@gmail.com', tenant: 'rfsafe', action: 'unsub' });
    assert.match(await (await fetch(a.base + '/newsletter/unsubscribe?t=' + ut)).text(), /Unsubscribe me/);
    await fetch(a.base + '/newsletter/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 't=' + encodeURIComponent(ut) });
    j = await (await fetch(a.base + '/admin/newsletter/subscribers', { headers: admin })).json(); assert.strictEqual(j.count, 0);
    assert.ok(!JSON.stringify(a.logs).includes('jane@gmail.com'));
  } finally { await a.close(); }
});
