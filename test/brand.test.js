'use strict';
const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs'); const path = require('path');
const { snapshot } = require('./brand-snapshot.gen');
const { rebrand, brandFor, validateBrand, LEGACY } = require('../src/brand');
const { validateTenant, TenantRegistry } = require('../src/tenants');
const xai = require('../src/xai'); const sms = require('../src/sms'); const email = require('../src/email'); const { Tools } = require('../src/tools');
const kbformat = require('../src/kbformat');

test('RF Safe output is byte-identical to main (prompts, tools, texts, emails, readiness, provision)', async () => {
  const want = fs.readFileSync(path.join(__dirname, 'fixtures/rfsafe-brand-snapshot.json'), 'utf8');
  assert.strictEqual(JSON.stringify(await snapshot(), null, 1) + '\n', want);
});

const BDO = { team_name: 'Best Deal On', email_from: 'Best Deal On <no-reply@bestdealon.app>', site: 'bestdealon.app', trademark_line: 'Best Deal On is a product of Quanta X Technology LLC.' };
const rf = JSON.parse(fs.readFileSync(path.join(__dirname, '../deploy/rfsafe.tenant.json'), 'utf8'));
const bdo = () => new TenantRegistry(null).add({ id: 'bestdealon', name: 'Best Deal On', numbers: ['+17275559001'], link_allowlist: ['bestdealon.app'], email_enabled: true, sms_enabled: false, brand: BDO });

test('brand block validates; bad ones are rejected', () => {
  assert.deepStrictEqual(validateBrand(BDO), []);
  assert.deepStrictEqual(validateBrand(undefined), []);
  assert.ok(validateBrand({ ...BDO, email_from: 'no-reply@bestdealon.app' }).length);
  assert.ok(validateBrand({ ...BDO, site: 'https://bestdealon.app' }).length);
  assert.ok(validateBrand({ ...BDO, extra: 1 }).length);
  assert.ok(validateTenant({ id: 'x-y', name: 'X', numbers: ['+17275559002'], link_allowlist: ['a.com'], brand: { team_name: 'X' } }).some((e) => /brand\./.test(e)));
  assert.strictEqual(brandFor({}), LEGACY);
});

test('a branded tenant never sees RF Safe names, addresses or sites', async () => {
  const t = bdo();
  const sent = []; const tools = new Tools(t, { kbFor: () => ({ answer: () => ({ found: false, guidance: 'g' }) }), emailFor: () => ({ send: async (m) => { sent.push(m); return { ok: true }; } }), log() {}, now: () => new Date(), approvals: {}, consent: {} });
  const blobs = [
    xai.buildInstructions(t, { afterHours: false }), JSON.stringify(tools.definitions()), sms.buildSmsInstructions(t),
    sms.fixLeakedInstructions('Offer to take a message.', t), sms.shortenWithOffer('Long. '.repeat(300), t),
    JSON.stringify(await tools.run('note_unanswered', { question: 'q' }, { channel: 'voice', callId: 'c' })),
    JSON.stringify(email.buildEmail({ links: [{ url: 'https://bestdealon.app/a' }], summary: 'S', name: 'Jo', newsletter: { confirmUrl: 'https://x/c', unsubscribeUrl: 'https://x/u' }, tenant: t })),
    email.subjectFor('Deals', true, t),
  ];
  for (const b of blobs) { assert.doesNotMatch(b, /RF Safe|rfsafe|quantacase|QuantaCase/i, b.slice(0, 200)); }
  assert.match(blobs[0] + blobs[1], /Best Deal On|bestdealon\.app/);
  assert.match(blobs[6], /Best Deal On is a product of Quanta X Technology LLC\./);
  assert.strictEqual(email.subjectFor('Deals', true, t), 'Your Best Deal On info: Deals');
  assert.doesNotMatch(blobs[1], /an Best Deal On/);
});

test('Resend sends from the tenant brand only when given; RF Safe default unchanged', async () => {
  const bodies = []; const f = async (u, o) => { bodies.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ id: 'e1' }) }; };
  const r = new email.ResendEmail({ apiKey: 'k', fetchImpl: f });
  await r.send({ to: 'a@b.co', subject: 's', text: 't', html: 'h' });
  await r.send({ to: 'a@b.co', subject: 's', text: 't', html: 'h', from: BDO.email_from });
  assert.strictEqual(bodies[0].from, 'RF Safe <rfsafe@callbots.org>'); assert.strictEqual(bodies[1].from, BDO.email_from);
});

test('rebrand: domain lists collapse; untouched without brand', () => {
  const t = { brand: BDO };
  assert.strictEqual(rebrand('links (quantacase.com and rfsafe.org pages)', t), 'links (bestdealon.app pages)');
  assert.strictEqual(rebrand('RF Safe\'s view on rfsafe.org', t), 'Best Deal On\'s view on bestdealon.app');
  const s = 'RF Safe on rfsafe.org'; assert.strictEqual(rebrand(s, {}), s); assert.strictEqual(rebrand(s, rf), s);
});

test('sar_lookup stays off unless a tenant turns it on', () => {
  const tools = new Tools(bdo(), { sarFor: () => ({}), log() {} });
  assert.ok(!tools.definitions().some((d) => /^sar_/.test(d.name)));
});

test('KB card sources can use a tenant allowlist (default unchanged)', () => {
  const card = { id: 'deal-a', kind: 'topic', title: 'T', position: '', body: 'b', sources: ['https://bestdealon.app/x'], aliases: [], updated: '2026-11-03' };
  assert.ok(kbformat.validateCard(card).includes('sources'));
  assert.deepStrictEqual(kbformat.validateCard(card, kbformat.allowFor(['bestdealon.app'])), []);
  assert.ok(kbformat.validateCard({ ...card, sources: ['https://evil.bestdealon.app.example.com/x'] }, kbformat.allowFor(['bestdealon.app'])).includes('sources'));
});
