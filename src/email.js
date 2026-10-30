'use strict';
// Email the caller the links they asked for, via Resend. Link-only, no marketing.
const { checkUrl } = require('./linkguard');
const FROM = 'RF Safe <rfsafe@callbots.org>';
const SUBJECT = 'Your RF Safe links';
const EMAIL_RE = /^[^@\s<>"',;]+@[^@\s<>"',;]+\.[a-z]{2,}$/i;
const validEmail = (e) => typeof e === 'string' && e.length <= 254 && EMAIL_RE.test(e.trim());
// j***@g***.com
function maskEmail(e) {
  const [u, d] = String(e || '').split('@'); if (!d) return '***';
  const dot = d.lastIndexOf('.'); const host = dot > 0 ? d.slice(0, dot) : d; const tld = dot > 0 ? d.slice(dot) : '';
  return (u[0] || '') + '***@' + (host[0] || '') + '***' + tld;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FOOTER_TXT = 'You asked for these links on a call with the RF Safe line (AI assistant). This is a one-time email, not a mailing list.\nRF Safe is a trademark of Quanta X Technology LLC.\nPrivacy: https://callbots.org/privacy';
function buildEmail({ links, note }) {
  const lines = links.map((l) => (l.title ? l.title + ': ' : '') + l.url);
  const text = ['Here are the links you asked for:', '', ...lines, ...(note ? ['', note] : []), '', '--', FOOTER_TXT].join('\n');
  const html = `<p>Here are the links you asked for:</p><ul>${links.map((l) => `<li>${l.title ? esc(l.title) + ': ' : ''}<a href="${esc(l.url)}">${esc(l.url)}</a></li>`).join('')}</ul>${note ? `<p>${esc(note)}</p>` : ''}<hr><p style="font-size:12px;color:#666">You asked for these links on a call with the RF Safe line (AI assistant). This is a one-time email, not a mailing list.<br>RF Safe is a trademark of Quanta X Technology LLC.<br><a href="https://callbots.org/privacy">Privacy</a></p>`;
  return { text, html };
}
// Check links: https, allowlisted (quantacase.com / rfsafe.org), max 5, no card-like text.
function checkLinks(urls, allowlist) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean).slice(0, 6);
  if (!list.length) return { ok: false, reason: 'no_links' };
  if (list.length > 5) return { ok: false, reason: 'too_many_links' };
  const out = [];
  for (const u of list) { const c = checkUrl(String(u), allowlist); if (!c.ok) return { ok: false, reason: c.reason || 'link_not_allowed' }; out.push({ url: c.url }); }
  return { ok: true, links: out };
}
class ResendEmail {
  constructor({ apiKey, fetchImpl = globalThis.fetch }) { this.key = apiKey; this.fetch = fetchImpl; }
  async send({ to, replyTo, subject, text, html }) {
    if (!this.key) return { ok: false, reason: 'email_not_configured' };
    const r = await this.fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + this.key, 'content-type': 'application/json' }, body: JSON.stringify({ from: FROM, to: [to], subject, text, html, ...(replyTo ? { reply_to: replyTo } : {}) }) });
    if (!r.ok) return { ok: false, reason: 'provider_' + r.status };
    const j = await r.json().catch(() => ({})); return { ok: true, id: j.id || null };
  }
}
class MockEmail { constructor() { this.sent = []; } async send(m) { this.sent.push(m); return { ok: true, id: 'mock_' + this.sent.length }; } }
module.exports = { ResendEmail, MockEmail, buildEmail, checkLinks, maskEmail, validEmail, FROM, SUBJECT };
