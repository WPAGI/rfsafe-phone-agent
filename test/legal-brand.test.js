'use strict';
// Best Deal On gets its own privacy and terms text; RF Safe / callbots.org output stays byte-identical.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { renderPrivacy, renderTerms } = require('../src/legal');
const { startApp } = require('./helpers');
const bdo = JSON.parse(fs.readFileSync(path.join(__dirname, '../deploy/bestdealon/tenants/bestdealon.json'), 'utf8'));
const RF = /RF Safe|rfsafe|QuantaCase|quantacase|CallBots|callbots/;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
// Hashes of the RF Safe pages as of 9c28368 (before tenant-driven legal text). Must never change here.
const RF_PRIVACY_SHA = '230cd470037bbd34cad20252bf88722baa086f379688da52a7f953f19140db2b'; const RF_TERMS_SHA = '2728018997590c02aeea506e4ee9ffe12826e25384711bcb80d1239e0405bcb2';

test('RF Safe (no tenant / no brand block): privacy and terms are byte-identical', () => {
  assert.strictEqual(sha(renderPrivacy()), RF_PRIVACY_SHA); assert.strictEqual(sha(renderTerms()), RF_TERMS_SHA);
  assert.strictEqual(renderPrivacy({ id: 'rfsafe' }), renderPrivacy()); assert.strictEqual(renderTerms({ id: 'rfsafe' }), renderTerms());
});
test('bdo privacy and terms: Best Deal On text, no RF Safe or CallBots wording', () => {
  for (const p of [renderPrivacy(bdo), renderTerms(bdo)]) {
    assert.doesNotMatch(p, RF); assert.match(p, /Best Deal On/); assert.match(p, /support@bestdealon\.app/);
    assert.match(p, /not shared with third parties or affiliates/);
    assert.match(p, /coming soon/i);
    assert.doesNotMatch(p, /reply STOP to (opt out|cancel)|we will text you|will call you back|we text|order status/i);
  }
});
test('HTTP: single branded tenant serves Best Deal On legal pages; RF Safe demo unchanged', async () => {
  const a = await startApp();
  try {
    let r = await (await fetch(a.base + '/privacy')).text(); assert.strictEqual(r, renderPrivacy());
    a.deps.tenants.list = () => [bdo];
    r = await (await fetch(a.base + '/privacy')).text(); assert.strictEqual(r, renderPrivacy(bdo));
    r = await (await fetch(a.base + '/terms')).text(); assert.strictEqual(r, renderTerms(bdo)); assert.doesNotMatch(r, RF);
  } finally { await a.close(); }
});
