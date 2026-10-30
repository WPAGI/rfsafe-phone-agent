'use strict';
// Click-to-connect onboarding (multi-tenant). Real OAuth endpoints are built but every token exchange
// goes through an injectable `exchange` function; demo/tests use mocks. Nothing here buys or registers.
const crypto = require('crypto');
const { safeEq } = require('./util');

// Signed, expiring OAuth state bound to tenant + provider (CSRF protection).
function makeState(secret, tenantId, provider, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ t: tenantId, p: provider, e: now + 10 * 60 * 1000, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}
function readState(secret, state, provider, now = Date.now()) {
  const [payload, mac] = String(state || '').split('.');
  if (!payload || !mac || !safeEq(mac, crypto.createHmac('sha256', secret).update(payload).digest('base64url'))) return null;
  const s = JSON.parse(Buffer.from(payload, 'base64url').toString()); if (s.p !== provider || s.e < now) return null; return s;
}

const SHOPIFY_SCOPES = 'unauthenticated_read_product_listings,read_products';
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

function shopifyAuthorizeUrl({ shop, clientId, redirectUri, state, scopes = SHOPIFY_SCOPES }) {
  if (!SHOP_DOMAIN.test(shop)) throw Object.assign(new Error('shop must be <name>.myshopify.com'), { status: 400 });
  return `https://${shop}/admin/oauth/authorize?` + new URLSearchParams({ client_id: clientId, scope: scopes, redirect_uri: redirectUri, state });
}
// Shopify OAuth callback HMAC: hex HMAC-SHA256 of the sorted query string without `hmac`.
function shopifyCallbackValid(query, appSecret) {
  const { hmac, signature, ...rest } = query; if (!hmac) return false;
  const msg = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join('&');
  return safeEq(crypto.createHmac('sha256', appSecret).update(msg).digest('hex'), hmac);
}

// Steps a tenant goes through; the dashboard renders this checklist.
function onboardingStatus(t) {
  return [
    { step: 'business_profile', done: !!(t.name && t.owner_email) },
    { step: 'website_kb', done: !!(t.kb && (t.kb.dirs || t.kb.collection_id)) },
    { step: 'link_allowlist', done: !!(t.link_allowlist && t.link_allowlist.length) },
    { step: 'shopify_connect', done: !!t.shopify, optional: true },
    { step: 'twilio_connect', done: !!(t.twilio && t.twilio.account_sid) },
    { step: 'phone_number', done: !!(t.numbers && t.numbers.length), note: 'buying a number costs money: owner approval required' },
    { step: 'voice_and_hours', done: !!(t.voice && t.hours) },
    { step: 'texting_registration_a2p', done: !!t.sms_enabled, note: 'A2P 10DLC fees apply: owner approval required' },
    { step: 'test_call', done: !!t.test_call_ok },
  ];
}

module.exports = { makeState, readState, shopifyAuthorizeUrl, shopifyCallbackValid, onboardingStatus, SHOPIFY_SCOPES };
