'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { Tools, Approvals } = require('../src/tools');
const { Consent, MockTwilio } = require('../src/twilio');
const { MockCallControl } = require('../src/mocks');
const { KB } = require('../src/kb');
const { SmsRateLimit } = require('../src/ratelimit');
const { fetchAllowlistedPage } = require('../src/web');

function mk(over = {}) {
  const t = { id: 'r', name: 'R', numbers: ['+15555550100'], link_allowlist: ['rfsafe.org', 'quantacase.com'], transfer_target: 'tel:+15555550199', hours: { tz: 'America/New_York', open: '09:00', close: '17:00' }, sms_enabled: true, approval_mode: false, blocked_topics: [], website: { pages: [{ title: 'QuantaCase', url: 'https://quantacase.com/', text: 'QuantaCase cases from Quanta X Technology. Order on the website.' }] }, ...over };
  const consent = new Consent(null); consent.record('r', '+15555550142', 'inbound');
  const sms = new MockTwilio(); const notes = [];
  const tools = new Tools(t, { kbFor: () => new KB({ allowlist: t.link_allowlist }), shopifyFor: () => { throw new Error('none'); }, smsFor: () => sms, consent, callControl: new MockCallControl(), notify: async (_, m) => notes.push(m), approvals: new Approvals(), log: () => {}, now: () => new Date('2026-10-29T14:00:00Z'), rateLimit: new SmsRateLimit({ perCall: 3, perHour: 5, perDay: 10 }) });
  return { tools, sms };
}
const voice = { channel: 'voice', callId: 'c1', caller: '+15555550142' };

test('send_link_sms is link-only and stops at the per-call cap', async () => {
  const m = mk(); await m.tools.run('set_text_number', { use_caller_id: true }, voice);
  const url = { url: 'https://quantacase.com/products/example' };
  for (let i = 0; i < 3; i++) assert.strictEqual((await m.tools.run('send_link_sms', url, voice)).sent, true);
  const blocked = await m.tools.run('send_link', url, voice);
  assert.strictEqual(blocked.error, 'per_call_cap');
  assert.strictEqual(m.sms.sent.length, 3);
  assert.strictEqual((await m.tools.run('send_link_sms', { url: 'http://quantacase.com/x' }, voice)).error, 'https_only');
});

test('website lookup stays on the allowlist', async () => {
  const m = mk();
  const hit = await m.tools.run('website_lookup', { query: 'QuantaCase order' }, voice);
  assert.strictEqual(hit.ok, true);
  assert.strictEqual(hit.pages[0].url, 'https://quantacase.com/');
  const off = await m.tools.run('website_lookup', { url: 'https://evil.example/pay' }, voice);
  assert.strictEqual(off.error, 'domain_not_allowlisted');
  let fetches = 0;
  const fetched = await fetchAllowlistedPage('https://rfsafe.org/sar', async () => { fetches += 1; return { status: 302, ok: false }; }, ['rfsafe.org']);
  assert.strictEqual(fetched.error, 'redirect_blocked');
  assert.strictEqual(fetches, 1);
  const skipped = await fetchAllowlistedPage('https://evil.example/x', async () => { fetches += 1; return { status: 200, ok: true, text: async () => 'no' }; }, ['rfsafe.org']);
  assert.strictEqual(skipped.error, 'domain_not_allowlisted');
  assert.strictEqual(fetches, 1);
});

test('hourly cap counts across calls', async () => {
  const m = mk();
  const lim = m.tools.d.rateLimit;
  lim.perCall = 100; lim.perHour = 2; lim.perDay = 10;
  const url = { url: 'https://rfsafe.org/a' };
  for (const c of ['c1', 'c2', 'c3']) await m.tools.run('set_text_number', { use_caller_id: true }, { ...voice, callId: c });
  assert.ok((await m.tools.run('send_link_sms', url, voice)).sent);
  assert.ok((await m.tools.run('send_link_sms', url, { ...voice, callId: 'c2' })).sent);
  assert.strictEqual((await m.tools.run('send_link_sms', url, { ...voice, callId: 'c3' })).error, 'hourly_cap');
});
