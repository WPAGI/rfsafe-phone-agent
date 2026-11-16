'use strict';
// The site's own outgoing mail from Resend's sent list (sign-in emails etc.), filtered to MAIL_DOMAINS senders.
// Only the site's own sign-in / verification mail has its codes and links hidden; other outgoing mail is shown in full.
// Nothing is sent or changed at Resend.
const { addrDomain } = require('../mail/client');
const { redact } = require('./policy');
const { htmlToText } = require('../mail');
// Outgoing mail that carries a sign-in link or one-time code (magic links, verification, password reset, PIN).
const AUTH_RE = /\b(sign[- ]?in|log[- ]?in|magic link|verification|verify|one[- ]time|passcode|password reset|reset your password|security code|login code|your code|PIN)\b/i;
const isAuthMail = (subject, text) => AUTH_RE.test(String(subject || '')) || /\b(sign[- ]?in link|magic link|verification code|one[- ]time code|your code is|login code)\b/i.test(String(text || '').slice(0, 4000));
const API = 'https://api.resend.com';
class SentMail {
  constructor({ key, allowed, fetchImpl = globalThis.fetch, now = () => Date.now() }) { this.key = key; this.allowed = allowed; this.fetch = fetchImpl; this.now = now; this.cache = null; }
  async req(p) {
    if (!this.key) throw new Error('mail_not_configured');
    const r = await this.fetch(API + p, { headers: { authorization: 'Bearer ' + this.key }, signal: AbortSignal.timeout(15000) });
    if (r.status === 404) return null; if (!r.ok) throw new Error('mail_provider_unavailable'); return r.json();
  }
  ours(m) { return this.allowed.has(addrDomain(m.from)); }
  async list() {
    if (!this.allowed.size) return [];
    if (this.cache && this.now() - this.cache.at < 60000) return this.cache.rows;
    const j = await this.req('/emails?limit=100'); const d = j && Array.isArray(j.data) ? j.data : [];
    const rows = d.filter(m => this.ours(m)).map(m => ({ id: 'x.' + m.id, from: m.from, to: [].concat(m.to || []), subject: isAuthMail(m.subject) ? redact(m.subject || '') : (m.subject || ''), created_at: m.created_at, status: m.last_event || null, redacted: isAuthMail(m.subject) }));
    this.cache = { at: this.now(), rows }; return rows;
  }
  async get(id) {
    const m = String(id).match(/^x\.([A-Za-z0-9-]{8,80})$/); if (!m || !this.allowed.size) return null;
    const e = await this.req('/emails/' + encodeURIComponent(m[1])); if (!e || !this.ours(e)) return null;
    const text = e.text || htmlToText(e.html);
    const auth = isAuthMail(e.subject, text);
    return { id, from: e.from, to: [].concat(e.to || []), subject: auth ? redact(e.subject || '') : (e.subject || ''), created_at: e.created_at, text: auth ? redact(text) : text, status: e.last_event || null, redacted: auth };
  }
}
module.exports = { SentMail, isAuthMail };
