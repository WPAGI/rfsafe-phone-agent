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
  _apply(e) { const k = this._k(e.tenant, e.phone); const s = this.state.get(k) || { contacted: false, optedOut: false }; if (e.type === 'inbound') s.contacted = true; if (e.type === 'stop') s.optedOut = true; if (e.type === 'start') { s.optedOut = false; s.contacted = true; } this.state.set(k, s); }
  record(tenant, phone, type) { const e = { tenant, phone, type, at: new Date().toISOString() }; this._apply(e); if (this.file) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.appendFileSync(this.file, JSON.stringify(e) + '\n', { mode: 0o600 }); } }
  canText(tenant, phone) { const s = this.state.get(this._k(tenant, phone)); return !!(s && s.contacted && !s.optedOut); }
}

// Real transport (used only when TWILIO_LIVE=1 and credentials exist). Tests/demo use MockTwilio.
class TwilioRest {
  constructor({ accountSid, authToken, fetchImpl = globalThis.fetch }) { this.sid = accountSid; this.tok = authToken; this.fetch = fetchImpl; }
  async sendSms({ from, to, body, statusCallback }) {
    const form = new URLSearchParams({ From: from, To: to, Body: body }); if (statusCallback) form.set('StatusCallback', statusCallback);
    const r = await this.fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Messages.json`, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(this.sid + ':' + this.tok).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: form });
    const j = await r.json(); if (!r.ok) throw new Error('twilio ' + r.status + ' ' + (j.code || '')); return { sid: j.sid };
  }
}
class MockTwilio {
  constructor() { this.sent = []; }
  async sendSms(m) { this.sent.push(m); return { sid: 'SM_mock_' + this.sent.length }; }
}

// The one function that sends any SMS to a customer. Gate order: consent -> link guard (caller) -> send.
async function sendCustomerSms({ tenant, transport, consent, to, body, log }) {
  if (!consent.canText(tenant.id, to)) { log && log('sms.blocked', { tenant: tenant.id, to: fp(to), reason: 'no_consent_or_opted_out' }); return { ok: false, reason: 'no_consent_or_opted_out' }; }
  const r = await transport.sendSms({ from: tenant.numbers[0], to, body });
  log && log('sms.sent', { tenant: tenant.id, to: fp(to), sid: r.sid, chars: body.length });
  return { ok: true, sid: r.sid };
}

function twiml(msg) { const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])); return '<?xml version="1.0" encoding="UTF-8"?><Response>' + (msg ? `<Message>${esc(msg)}</Message>` : '') + '</Response>'; }

module.exports = { twilioSignature, verifyTwilio, Consent, TwilioRest, MockTwilio, sendCustomerSms, twiml, STOP_WORDS, START_WORDS, HELP_WORDS };
