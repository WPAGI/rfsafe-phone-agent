'use strict';
// John, Nov 16 2026 9:03 PM ET: allow rfsafe.app links in Callbots replies. r.65159806 (mock copy) was held for
// "Wrong or unknown link: https://rfsafe.app/sar". Lookalikes must still fail.
const test = require('node:test'); const assert = require('node:assert');
const B = require('../vendor/sitemail/src/mailbox/bots');
const { isSiteUrl } = require('../vendor/sitemail/src/mailbox/govlinks');
const body = (u) => 'Hi there,\n\nYou can see the SAR ranking here: ' + u + '\n\nThe RF Safe team';

test('rfsafe.app and www.rfsafe.app pages pass the checker link check', () => {
  for (const u of ['https://rfsafe.app/sar', 'https://rfsafe.app', 'https://rfsafe.app/', 'https://www.rfsafe.app/sar/compare?ids=1,2', 'https://RFSafe.app/sar']) {
    assert.ok(isSiteUrl(u), u);
    assert.deepStrictEqual(B.linkProblems(body(u)), [], u);
  }
});

test('lookalikes and unsafe forms of rfsafe.app still fail', () => {
  for (const u of ['https://rfsafe.app.evil.com/sar', 'https://notrfsafe.app/sar', 'https://evil.rfsafe.app/sar', 'https://rfsafe.app@evil.com/sar', 'http://rfsafe.app/sar', 'https://rfsafe.app:8443/sar', 'https://rfsafe-app.com/sar', 'https://rfsafe.apps/sar']) {
    assert.ok(!isSiteUrl(u), u);
    const p = B.linkProblems(body(u));
    assert.strictEqual(p.length, 1, u + ' ' + JSON.stringify(p));
  }
});
