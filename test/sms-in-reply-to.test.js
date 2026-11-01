'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { SentMessages, inReplyTo, detailPage } = require('../src/messages');
const { twilioSignature } = require('../src/twilio');
const { startApp, ENV } = require('./helpers');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-irt-')), 'sent-messages.jsonl');
const shell = (t, b) => b;
function store() { let now = Date.parse('2026-10-30T15:00:00Z'); const sm = new SentMessages({ file: tmp(), now: () => now }); return { sm, at: (iso) => { now = Date.parse(iso); } }; }

test('inReplyTo: call id first, then caller, then nearest prior; never a later text', () => {
  const { sm, at } = store();
  at('2026-10-30T15:00:00Z'); sm.addInbound({ tenant: 'r', call: 'sms-A', from: '+17275550101', text: 'by call' });
  at('2026-10-30T15:01:00Z'); sm.addInbound({ tenant: 'r', call: 'sms-B', from: '+17275550101', text: 'by caller' });
  at('2026-10-30T15:02:00Z'); sm.addInbound({ tenant: 'r', call: 'sms-C', from: '+17275550999', text: 'nearest' });
  at('2026-10-30T15:03:00Z'); const r = sm.add({ channel: 'sms', tenant: 'r', call: 'sms-A', to: '+17275550101', text: 'reply', caller: '+17275550101' });
  at('2026-10-30T15:04:00Z'); sm.addInbound({ tenant: 'r', call: 'sms-A', from: '+17275550101', text: 'later' });
  const ib = sm.inbound();
  assert.strictEqual(inReplyTo(r, ib).text, 'by call'); assert.strictEqual(inReplyTo(r, ib).match, 'call');
  assert.strictEqual(inReplyTo({ ...r, call: 'zzz' }, ib).text, 'by caller');
  assert.strictEqual(inReplyTo({ ...r, call: 'zzz', caller_fp: 'fp_other' }, ib).text, 'nearest');
  assert.strictEqual(inReplyTo({ ...r, call: 'zzz', inbound: 'copy' }, ib).match, 'reply');
  assert.strictEqual(sm.list('sms').length, 1, 'inbound records stay out of the sent-texts list');
});

test('no match: older reply shows "Original text not stored (before ...)"', () => {
  const { sm, at } = store();
  at('2026-10-29T10:00:00Z'); const r = sm.add({ channel: 'sms', tenant: 'r', call: 'c1', to: '+17275550101', text: 'old reply' });
  at('2026-10-31T10:00:00Z'); sm.addInbound({ tenant: 'r', call: 'x', from: '+17275550101', text: 'new' });
  assert.strictEqual(inReplyTo(r, sm.inbound()), null);
  const h = detailPage({ shell, r, inbound: sm.inbound() });
  assert.match(h, /<details><summary>In reply to<\/summary>/); assert.match(h, /Original text not stored \(before Oct 31, 2026/);
  assert.match(detailPage({ shell, r, inbound: [] }), /Original text not stored/);
});

test('escaping and masking in the In reply to section', () => {
  const { sm } = store();
  sm.addInbound({ tenant: 'r', call: 'c1', from: '+17275550101', text: '<script>alert(1)</script> & "x"' });
  const r = sm.add({ channel: 'sms', tenant: 'r', call: 'c1', to: '+17275550101', text: 'ok' });
  const h = detailPage({ shell, r, inbound: sm.inbound() });
  assert.doesNotMatch(h, /<script>alert/); assert.match(h, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;x&quot;/);
  assert.match(h, /\+1727\*\*\*0101/); assert.match(h, /Time \(UTC\)/); assert.match(h, /E[DS]T/);
});

test('inbound texts are stored on arrival; detail page needs admin auth', async () => {
  const a = await startApp();
  try {
    const p = { From: '+17275550177', To: '+17275550100', Body: 'HELP <b>' };
    const res = await fetch(a.base + '/twilio/sms', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(ENV.DEMO_TWILIO_AUTH_TOKEN, a.base + '/twilio/sms', p) }, body: new URLSearchParams(p).toString() });
    assert.strictEqual(res.status, 200);
    const [ib] = a.deps.sentMessages.inbound();
    assert.strictEqual(ib.text, 'HELP <b>'); assert.strictEqual(ib.from, '+17275550177'); assert.match(ib.call, /^sms-fp_[0-9a-f]{12}-2026-10-29$/); assert.ok(ib.caller_fp);
    const r = a.deps.sentMessages.add({ channel: 'sms', tenant: ib.tenant, call: ib.call, to: '+17275550177', text: 'reply' });
    const u = a.base + '/admin/messages?type=sms&id=' + encodeURIComponent(r.id);
    const un = await fetch(u); assert.strictEqual(un.status, 401); assert.doesNotMatch(await un.text(), /HELP/);
    assert.strictEqual((await fetch(u, { redirect: 'manual', headers: { accept: 'text/html' } })).status, 303);
  } finally { await a.close(); }
});
