'use strict';
// Link-only SMS guard. The ONLY outbound customer content is a short note plus allowlisted https links.
// Enforced in code, independent of the model's prompt.

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"']+)|\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|co|us|info|biz|ly|me|app|link|shop|store|xyz)(?:\/[^\s<>"']*)?)/gi;

function normHost(h) { return String(h || '').toLowerCase().replace(/\.$/, ''); }

function hostAllowed(host, allowlist) {
  host = normHost(host);
  return allowlist.some((d) => { d = normHost(d); return host === d || host.endsWith('.' + d); });
}

// Returns {ok, url?, reason?}. Strict: https only, no credentials, no IP hosts, no non-default ports,
// host must be (a subdomain of) an allowlisted domain, after WHATWG parsing (punycode-normalised).
function checkUrl(raw, allowlist) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return { ok: false, reason: 'unparseable_url' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'https_only' };
  if (u.username || u.password) return { ok: false, reason: 'credentials_in_url' };
  if (u.port) return { ok: false, reason: 'non_default_port' };
  if (/^[0-9.]+$/.test(u.hostname) || u.hostname.startsWith('[')) return { ok: false, reason: 'ip_host' };
  if (!hostAllowed(u.hostname, allowlist)) return { ok: false, reason: 'domain_not_allowlisted' };
  return { ok: true, url: u.toString() };
}

// Luhn check for anything that looks like a card number: we never send or echo payment data.
function looksLikeCard(text) {
  const runs = String(text).match(/(?:\d[ -]?){13,19}/g) || [];
  return runs.some((r) => {
    const d = r.replace(/\D/g, ''); if (d.length < 13 || d.length > 19) return false;
    let sum = 0; let alt = false;
    for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
    return sum % 10 === 0;
  });
}

const PAYMENT_WORDS = /\b(card number|cvv|cvc|security code|expiration date|routing number|bank account|pay (me|now|here)|venmo|zelle|cash ?app|paypal\.me)\b/i;
const MAX_NOTE = 300;

// Validates a full outbound SMS body: every URL in it must pass checkUrl, at least one link,
// no payment content, bounded length. Returns {ok, body?, reason?}.
function checkOutboundSms({ url, note = '' }, allowlist) {
  const c = checkUrl(url, allowlist);
  if (!c.ok) return c;
  note = String(note).replace(/\s+/g, ' ').trim();
  if (note.length > MAX_NOTE) return { ok: false, reason: 'note_too_long' };
  if (looksLikeCard(note) || PAYMENT_WORDS.test(note)) return { ok: false, reason: 'payment_content' };
  // any URL-ish token hidden inside the note must also be allowlisted
  for (const m of note.matchAll(URL_RE)) {
    const tok = m[0].startsWith('http') ? m[0] : 'https://' + m[0];
    if (!checkUrl(tok.replace(/[).,!?]+$/, ''), allowlist).ok) return { ok: false, reason: 'unapproved_link_in_note' };
  }
  const body = (note ? note + ' ' : '') + c.url;
  return { ok: true, body };
}

module.exports = { checkUrl, checkOutboundSms, looksLikeCard, hostAllowed };
