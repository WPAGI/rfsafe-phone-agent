'use strict';
// Email the caller the links they asked for, via Resend. Link-only, no marketing.
const { checkUrl } = require('./linkguard');
const SUMMARY_MAX = 4000;
const TOPIC_MAX = 80;
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
const AI_NOTE = "This reply was written by RF Safe's AI assistant. AI can make mistakes.";
const FOOTER_TXT = 'You asked for this on a call with the RF Safe line (AI assistant). This is a one-time email, not a mailing list.\nRF Safe is a trademark of Quanta X Technology LLC.\nPrivacy: https://callbots.org/privacy\n' + AI_NOTE;
// Summary: plain text from the KB. Keep allowlisted https URLs, strip every other URL, cap length.
function cleanSummary(raw, allowlist) {
  let t = String(raw || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  t = t.replace(/https?:\/\/[^\s<>"']+|www\.[^\s<>"']+/gi, (u) => { const m = u.match(/[).,;:!?]+$/); const core = m ? u.slice(0, -m[0].length) : u; return checkUrl(core, allowlist || []).ok ? u : (m ? m[0] : ''); });
  t = t.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length > SUMMARY_MAX) { t = t.slice(0, SUMMARY_MAX); const cut = Math.max(t.lastIndexOf('. '), t.lastIndexOf('\n')); if (cut > SUMMARY_MAX * 0.6) t = t.slice(0, cut + 1); t = t.trim() + ' ...'; }
  return t;
}
function cleanTopic(raw) { return String(raw || '').replace(/https?:\/\/\S+|www\.\S+/gi, '').replace(/[\r\n\t]+/g, ' ').replace(/[^\p{L}\p{N} ,.'&()\/-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, TOPIC_MAX).trim(); }
function subjectFor(topic, hasSummary) { const tp = cleanTopic(topic); return tp ? (hasSummary ? 'Your RF Safe info: ' : 'Your RF Safe links: ') + tp : (hasSummary ? 'Your RF Safe info' : SUBJECT); }
function buildEmail({ links, note, summary, name, newsletter }) {
  const lines = links.map((l) => (l.title ? l.title + ': ' : '') + l.url);
  const paras = summary ? summary.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean) : [];
  const sub = !!(newsletter && newsletter.subscriber);
  const greet = sub ? `Hi ${name || 'there'}, thank you for being an RF Safe newsletter subscriber and for requesting information from RF Safe.` : `Hi ${name || 'there'}, thank you for requesting information from RF Safe.`;
  const intro = summary ? 'Here is the information you asked for on your call with the RF Safe line:' : 'Here are the links you asked for:';
  const nlTxt = newsletter && !sub ? ['', 'Newsletter: you asked to receive RF Safe\'s monthly newsletter. Please confirm (nothing is sent until you do; the link works for 30 days):', 'Confirm my newsletter subscription: ' + newsletter.confirmUrl] : [];
  const footTxt = newsletter ? FOOTER_TXT.replace('This is a one-time email, not a mailing list.', sub ? 'You are receiving this because you asked on the call; you are an RF Safe newsletter subscriber.' : 'You are not on any mailing list unless you confirm above.') .replace('\n' + AI_NOTE, '\nUnsubscribe: ' + newsletter.unsubscribeUrl + '\n' + AI_NOTE) : FOOTER_TXT;
  const text = [greet, '', intro, '', ...(summary ? [summary, '', 'Sources:'] : []), ...lines, ...(note ? ['', note] : []), ...nlTxt, '', '--', footTxt].join('\n');
  const nlHtml = newsletter && !sub ? `<p>You asked to receive RF Safe's monthly newsletter. Please confirm; nothing is sent until you do (the link works for 30 days).</p><p><a href="${esc(newsletter.confirmUrl)}" style="display:inline-block;padding:10px 16px;background:#0b5;color:#fff;text-decoration:none;border-radius:6px">Confirm my newsletter subscription</a></p>` : '';
  const footHtml = (sub ? 'You asked for this on a call with the RF Safe line (AI assistant). You are an RF Safe newsletter subscriber.' : newsletter ? 'You asked for this on a call with the RF Safe line (AI assistant). You are not on any mailing list unless you confirm above.' : 'You asked for this on a call with the RF Safe line (AI assistant). This is a one-time email, not a mailing list.') + '<br>RF Safe is a trademark of Quanta X Technology LLC.<br><a href="https://callbots.org/privacy">Privacy</a>' + (newsletter ? ` &middot; <a href="${esc(newsletter.unsubscribeUrl)}">Unsubscribe</a>` : '');
  const html = `<p>${esc(greet)}</p><p>${esc(intro)}</p>${paras.map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}${summary ? '<p><strong>Sources:</strong></p>' : ''}<ul>${links.map((l) => `<li>${l.title ? esc(l.title) + ': ' : ''}<a href="${esc(l.url)}">${esc(l.url)}</a></li>`).join('')}</ul>${note ? `<p>${esc(note)}</p>` : ''}${nlHtml}<hr><p style="font-size:12px;color:#666">${footHtml}</p><p style="font-size:11px;color:#999">${esc(AI_NOTE)}</p>`;
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
module.exports = { ResendEmail, MockEmail, buildEmail, cleanSummary, cleanTopic, subjectFor, SUMMARY_MAX, checkLinks, maskEmail, validEmail, FROM, SUBJECT, AI_NOTE };
