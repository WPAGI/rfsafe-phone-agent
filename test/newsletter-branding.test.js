'use strict';
// Newsletter pages and texts follow the tenant's brand: Best Deal On shows no RF Safe wording; RF Safe (no brand block) is unchanged.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { startApp } = require('./helpers');
const { newsSmsConfirmed, NEWS_SMS_SPOKEN, page } = require('../src/newsletter');
const { rebrand } = require('../src/brand');
const bdo = JSON.parse(fs.readFileSync(path.join(__dirname, '../deploy/bestdealon/tenants/bestdealon.json'), 'utf8'));
const RF = /RF Safe|rfsafe|QuantaCase|quantacase|Quanta X Technology LLC\. *<a|support@quantaxtechnology/;
const form = (t) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 't=' + encodeURIComponent(t) });

async function withTenants(tenants, fn) {
  const a = await startApp(); const og = a.deps.tenants.get.bind(a.deps.tenants);
  if (tenants) { a.deps.tenants.get = (id) => tenants.find((x) => x.id === id) || og(id); a.deps.tenants.list = () => tenants; }
  try { await fn(a); } finally { await a.close(); }
}

test('bdo: confirm, unsubscribe and error pages have Best Deal On branding, no RF Safe wording', async () => {
  await withTenants([bdo], async (a) => {
    const nl = a.deps.newsletter; const tok = nl.token({ email: 'jo@example.com', tenant: 'bestdealon' });
    const ut = nl.token({ email: 'jo@example.com', tenant: 'bestdealon', action: 'unsub' });
    const pages = [
      await (await fetch(a.base + '/newsletter/confirm?t=' + tok)).text(),
      await (await fetch(a.base + '/newsletter/confirm', form(tok))).text(),
      await (await fetch(a.base + '/newsletter/unsubscribe?t=' + ut)).text(),
      await (await fetch(a.base + '/newsletter/unsubscribe', form(ut))).text(),
      await (await fetch(a.base + '/newsletter/confirm?t=bad.sig')).text(),
      await (await fetch(a.base + '/newsletter/confirm', form('bad.sig'))).text(),
    ];
    for (const p of pages) assert.doesNotMatch(p, RF, p);
    assert.match(pages[1], /You are subscribed to Best Deal On's monthly newsletter\./);
    assert.match(pages[0], /Best Deal On&#39;s monthly newsletter/);
    assert.match(pages[3], /You will not receive Best Deal On's newsletter\./);
    assert.match(pages[4], /support@bestdealon\.app/);
  });
});

test('RF Safe (no brand block): newsletter pages are byte-for-byte unchanged', async () => {
  await withTenants(null, async (a) => {
    const nl = a.deps.newsletter; const tok = nl.token({ email: 'jane@gmail.com', tenant: 'rfsafe' });
    const done = await (await fetch(a.base + '/newsletter/confirm', form(tok))).text();
    assert.strictEqual(done, page('Thank you!', "<p>You are subscribed to RF Safe's monthly newsletter. Every issue has an unsubscribe link.</p>"));
    const bad = await (await fetch(a.base + '/newsletter/confirm?t=bad.sig')).text();
    assert.strictEqual(bad, page('Link expired or invalid', '<p>This link is invalid or has expired. Ask for a new one on your next call, or email support@quantaxtechnology.com.</p>'));
    assert.match(done, /RF Safe is a trademark of Quanta X Technology LLC\./);
  });
});

test('news texts: bdo wording has no RF Safe, RF Safe wording unchanged', () => {
  assert.doesNotMatch(rebrand(newsSmsConfirmed(bdo.name), bdo), RF);
  assert.doesNotMatch(rebrand(NEWS_SMS_SPOKEN, bdo), RF);
  const rf = { id: 'rfsafe', name: 'RF Safe' };
  assert.strictEqual(rebrand(newsSmsConfirmed('RF Safe'), rf), newsSmsConfirmed('RF Safe'));
  assert.strictEqual(rebrand(NEWS_SMS_SPOKEN, rf), NEWS_SMS_SPOKEN);
});

test('bdo newsletter email (subject, body, footer) has no RF Safe wording', () => {
  const { buildEmail, subjectFor } = require('../src/email');
  const e = buildEmail({ tenant: bdo, name: 'Jo', links: [{ url: 'https://bestdealon.app/', title: 'Best Deal On' }], newsletter: { confirmUrl: 'https://x/newsletter/confirm?t=a', unsubscribeUrl: 'https://x/newsletter/unsubscribe?t=b' } });
  assert.doesNotMatch(e.text, RF); assert.doesNotMatch(e.html, RF);
  assert.doesNotMatch(subjectFor('deals', false, bdo), RF);
});
