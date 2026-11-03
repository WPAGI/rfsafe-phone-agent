'use strict';
// Twilio: webhook signature check, SMS send (REST, injectable transport), consent + STOP/HELP.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { safeEq, fp } = require('./util');

// https://www.twilio.com/docs/usage/webhooks/webhooks-security : HMAC-SHA1(authToken, url + sorted k+v), base64
function twilioSignature(authToken, url, params) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}
// Per-tenant webhook check. Twilio's webhook configuration API can sign with a SharedKey created with an
// API key (https://www.twilio.com/docs/usage/webhooks/webhook-shared-keys). Such requests carry
// X-Twilio-Webhooks-Signature-Settings: key=<sharedKeyId>,algorithm=HMAC_SHA1|HMAC_SHA256 and the signature
// in X-Twilio-Signature over the same url + sorted params string. Without that header Twilio signed with the
// account auth token (the RF Safe path, unchanged). tenant.twilio.webhook_keys maps sharedKeyId -> secret name;
// tenant.twilio.require_shared_key refuses the auth-token path.
const SIG_ALGOS = { HMAC_SHA1: 'sha1', HMAC_SHA256: 'sha256' };
function parseSignatureSettings(h) {
  const o = {}; for (const part of String(h || '').split(',')) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return o;
}
function sharedKeySignature(secret, algorithm, url, params) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return crypto.createHmac(SIG_ALGOS[algorithm], secret).update(Buffer.from(data, 'utf8')).digest('base64');
}
function verifyTenantTwilio(tenant, sec, url, params, headers) {
  const sig = headers['x-twilio-signature']; if (!tenant || !sig) return false;
  const cfg = tenant.twilio || {}; const ss = headers['x-twilio-webhooks-signature-settings'];
  if (ss) {
    const { key, algorithm } = parseSignatureSettings(ss);
    const name = key && (cfg.webhook_keys || {})[key]; if (!name || !SIG_ALGOS[algorithm]) return false;
    const secret = sec(tenant, name); if (!secret) return false;
    return safeEq(sharedKeySignature(secret, algorithm, url, params), sig);
  }
  if (cfg.require_shared_key) return false;
  return verifyTwilio(sec(tenant, 'twilio_auth_token'), url, params, sig);
}
function verifyTwilio(authToken, url, params, header) {
  if (!authToken || !header) return false;
  return safeEq(twilioSignature(authToken, url, params), header);
}

const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|optout|revoke)\s*$/i;
const START_WORDS = /^\s*(start|unstop|yes)\s*$/i;
const HELP_WORDS = /^\s*(help|info)\s*$/i;

// Consent ledger: who contacted the tenant first (opt-in by inbound text/call) and who opted out.
// Keyed by tenant + phone, so tenants are isolated. Stored as JSON lines (append-only) in DATA_DIR.
class Consent {
  constructor(file) { this.file = file; this.state = new Map(); if (file && fs.existsSync(file)) for (const l of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) this._apply(JSON.parse(l)); }
  _k(t, p) { return t + '|' + p; }
  _apply(e) { const k = this._k(e.tenant, e.phone); const s = this.state.get(k) || { contacted: false, optedOut: false }; if (e.type === 'inbound' || e.type === 'verbal_call') s.contacted = true; if (e.type === 'stop') s.optedOut = true; if (e.type === 'start') { s.optedOut = false; s.contacted = true; } this.state.set(k, s); }
  record(tenant, phone, type) { const e = { tenant, phone, type, at: new Date().toISOString() }; this._apply(e); if (this.file) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.appendFileSync(this.file, JSON.stringify(e) + '\n', { mode: 0o600 }); } }
  isOptedOut(tenant, phone) { const s = this.state.get(this._k(tenant, phone)); return !!(s && s.optedOut); }
  canText(tenant, phone) { const s = this.state.get(this._k(tenant, phone)); return !!(s && s.contacted && !s.optedOut); }
}

// Real transport (used only when TWILIO_LIVE=1 and credentials exist). Tests/demo use MockTwilio.
class TwilioRest {
  // REST auth: an API key (SK sid + secret) when given, else the account sid + auth token. URLs always use the account sid.
  constructor({ accountSid, authToken, apiKeySid, apiKeySecret, fetchImpl = globalThis.fetch }) { this.sid = accountSid; this.user = apiKeySid && apiKeySecret ? apiKeySid : accountSid; this.tok = apiKeySid && apiKeySecret ? apiKeySecret : authToken; this.fetch = fetchImpl; }
  async sendSms({ from, to, body, statusCallback, messagingServiceSid }) {
    // A2P 10DLC: send through the Messaging Service (registered campaign) when one is set; otherwise From.
    const form = new URLSearchParams(messagingServiceSid ? { MessagingServiceSid: messagingServiceSid, To: to, Body: body } : { From: from, To: to, Body: body }); if (statusCallback) form.set('StatusCallback', statusCallback);
    const r = await this.fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Messages.json`, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(this.user + ':' + this.tok).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: form });
    const j = await r.json(); if (!r.ok) throw new Error('twilio ' + r.status + ' ' + (j.code || '')); return { sid: j.sid };
  }
  // Read-only: E.164 numbers in a Messaging Service's sender pool.
  async senderPool(messagingServiceSid) {
    const r = await this.fetch(`https://messaging.twilio.com/v1/Services/${encodeURIComponent(messagingServiceSid)}/PhoneNumbers?PageSize=100`, { headers: { authorization: 'Basic ' + Buffer.from(this.user + ':' + this.tok).toString('base64') } });
    const j = await r.json(); if (!r.ok) throw new Error('twilio ' + r.status + ' ' + (j.code || '')); return (j.phone_numbers || []).map((p) => p.phone_number);
  }
}
class MockTwilio {
  constructor() { this.sent = []; }
  async sendSms(m) { this.sent.push(m); return { sid: 'SM_mock_' + this.sent.length }; }
  async senderPool() { return this.pool || []; }
}

// The one function that sends any SMS to a customer. Gate order: consent -> link guard (caller) -> send.
async function sendCustomerSms({ tenant, transport, consent, to, body, log }) {
  if (!consent.canText(tenant.id, to)) { log && log('sms.blocked', { tenant: tenant.id, to: fp(to), reason: 'no_consent_or_opted_out' }); return { ok: false, reason: 'no_consent_or_opted_out' }; }
  const r = await transport.sendSms({ from: tenant.numbers[0], to, body, messagingServiceSid: tenant.twilio && tenant.twilio.messaging_service_sid });
  log && log('sms.sent', { tenant: tenant.id, to: fp(to), sid: r.sid, chars: body.length });
  return { ok: true, sid: r.sid };
}

function twiml(msg) { const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])); return '<?xml version="1.0" encoding="UTF-8"?><Response>' + (msg ? `<Message>${esc(msg)}</Message>` : '') + '</Response>'; }

module.exports = { twilioSignature, verifyTwilio, verifyTenantTwilio, sharedKeySignature, parseSignatureSettings, Consent, TwilioRest, MockTwilio, sendCustomerSms, twiml, STOP_WORDS, START_WORDS, HELP_WORDS };
