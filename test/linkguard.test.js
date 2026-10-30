'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { checkUrl, checkOutboundSms, looksLikeCard } = require('../src/linkguard');
const A = ['quantacase.com', 'rfsafe.org'];
test('allowlisted https links pass, incl. subdomains', () => {
  assert.ok(checkUrl('https://quantacase.com/products/x', A).ok);
  assert.ok(checkUrl('https://www.rfsafe.org/a?b=1', A).ok);
  assert.ok(checkUrl('https://QUANTACASE.COM/', A).ok);
});
test('spoofs and unsafe forms are rejected', () => {
  for (const [u, why] of [
    ['http://quantacase.com/', 'https_only'], ['https://quantacase.com.evil.com/', 'domain_not_allowlisted'], ['https://evilquantacase.com/', 'domain_not_allowlisted'],
    ['https://quantacase.com@evil.com/', 'credentials_in_url'], ['https://user:pw@rfsafe.org/', 'credentials_in_url'], ['https://rfsafe.org:8443/', 'non_default_port'],
    ['https://1.2.3.4/', 'ip_host'], ['javascript:alert(1)', 'https_only'], ['https://xn--rfsfe-qra.org/', 'domain_not_allowlisted'], ['not a url', 'unparseable_url'],
    ['https://rfsafe.org.', 'ok?'],
  ]) { const r = checkUrl(u, A); if (why === 'ok?') continue; assert.strictEqual(r.ok, false, u); assert.strictEqual(r.reason, why, u); }
});
test('hidden links in the note are rejected', () => {
  assert.strictEqual(checkOutboundSms({ url: 'https://rfsafe.org/a', note: 'also see bit.ly/xyz' }, A).reason, 'unapproved_link_in_note');
  assert.strictEqual(checkOutboundSms({ url: 'https://rfsafe.org/a', note: 'or http://evil.com' }, A).reason, 'unapproved_link_in_note');
  assert.ok(checkOutboundSms({ url: 'https://rfsafe.org/a', note: 'see also quantacase.com/faq' }, A).ok);
});
test('payment content is refused', () => {
  assert.ok(looksLikeCard('4242 4242 4242 4242')); assert.ok(!looksLikeCard('call 727 555 0100'));
  assert.strictEqual(checkOutboundSms({ url: 'https://rfsafe.org/', note: 'send your CVV' }, A).reason, 'payment_content');
  assert.strictEqual(checkOutboundSms({ url: 'https://rfsafe.org/', note: 'x'.repeat(301) }, A).reason, 'note_too_long');
});
