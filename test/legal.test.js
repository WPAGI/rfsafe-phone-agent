'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { startApp } = require('./helpers');
const { renderLanding, SITEMAP, CSS } = require('../src/page');

test('/privacy and /terms: served, same design, CTIA SMS section, operator, effective date', async () => {
  const a = await startApp();
  try {
    for (const p of ['/privacy', '/terms']) {
      const r = await fetch(a.base + p); assert.strictEqual(r.status, 200); assert.match(r.headers.get('content-type'), /text\/html/);
      const h = await r.text();
      assert.ok(h.includes(CSS.slice(0, 200)), 'shares homepage CSS');
      assert.match(h, /Effective date: October 30, 2026/);
      assert.match(h, /Quanta X Technology LLC/); assert.match(h, /8134 122nd St N, Seminole, FL 33772/); assert.match(h, /Florida limited liability company/);
      assert.match(h, /consent is given verbally on the call/);
      assert.match(h, /texts are sent only to the phone number you are calling from/);
      assert.match(h, /Message frequency varies/); assert.match(h, /Msg &amp; data rates may apply/);
      assert.match(h, /<strong>STOP<\/strong>/); assert.match(h, /<strong>HELP<\/strong>/);
      assert.match(h, /Mobile opt-in data and consent will not be shared with third parties or affiliates for marketing purposes/);
      assert.match(h, /support@quantaxtechnology\.com/);
      assert.match(h, /href="\/privacy"/); assert.match(h, /href="\/terms"/);
      assert.match(h, new RegExp('<link rel="canonical" href="https://callbots.org' + p + '">'));
      assert.doesNotMatch(h, /John Coates/);
    }
    assert.match(await (await fetch(a.base + '/terms')).text(), /RF Safe is a trademark of Quanta X Technology LLC/);
  } finally { await a.close(); }
});
test('homepage footer links both pages; sitemap lists them', () => {
  const h = renderLanding(); assert.match(h, /<a href="\/privacy">Privacy Policy<\/a>/); assert.match(h, /<a href="\/terms">Terms of Service<\/a>/);
  assert.match(SITEMAP, /<loc>https:\/\/callbots\.org\/privacy<\/loc>/); assert.match(SITEMAP, /<loc>https:\/\/callbots\.org\/terms<\/loc>/);
});
test('HELP reply names support email when set, plus frequency and rates', () => {
  const src = require('fs').readFileSync(require.resolve('../src/sms.js'), 'utf8');
  assert.match(src, /support_email/); assert.match(src, /Msg frequency varies\. Msg & data rates may apply\. Reply STOP to opt out\./);
});
test('KB seeding: .managed dirs refresh changed files; other dirs keep disk edits', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path'); const { copyMissing } = require('../src/storage');
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'kbs-')); const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'kbd-'));
  fs.mkdirSync(path.join(src, 'm')); fs.mkdirSync(path.join(src, 'u'));
  fs.writeFileSync(path.join(src, 'm', '.managed'), 'x'); fs.writeFileSync(path.join(src, 'm', 'a.md'), 'new'); fs.writeFileSync(path.join(src, 'u', 'a.md'), 'new');
  fs.mkdirSync(path.join(dst, 'm')); fs.mkdirSync(path.join(dst, 'u'));
  fs.writeFileSync(path.join(dst, 'm', 'a.md'), 'old'); fs.writeFileSync(path.join(dst, 'u', 'a.md'), 'edited');
  copyMissing(src, dst);
  assert.strictEqual(fs.readFileSync(path.join(dst, 'm', 'a.md'), 'utf8'), 'new');
  assert.strictEqual(fs.readFileSync(path.join(dst, 'u', 'a.md'), 'utf8'), 'edited');
  assert.strictEqual(copyMissing(src, dst), 0);
});
test('ownership wording: no "John Coates\'s company"; Quanta X owns RF Safe; staff referral', () => {
  const fs = require('fs'); const path = require('path'); const root = path.join(__dirname, '..');
  for (const f of ['deploy/rfsafe.extra-instructions.txt', 'deploy/rfsafe.knowledge.patch.json', 'deploy/rfsafe.tenant.json']) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(s, /John Coates's company/); assert.match(s, /trademark owned by Quanta X Technology LLC/); assert.match(s, /Katie Webb is the owner and CEO/); assert.match(s, /refer them to Quanta X Technology staff/);
  }
  const t = JSON.parse(fs.readFileSync(path.join(root, 'deploy/rfsafe.tenant.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(t.known_callers).sort(), ['+17273540485', '+17276101188']); assert.strictEqual(t.transfer_target, 'tel:+17276101188');
  assert.deepStrictEqual(require('../src/tenants').validateTenant({ ...t, numbers: ['+17276775572'] }), []);
});
