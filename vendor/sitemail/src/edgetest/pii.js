'use strict';
// Edge testing: customer-PII scan and redaction for saved test emails and replies (John, Nov 17, 2026, 10:36 PM ET).
// Kept: test and business addresses (our own domains, mail.grokbot.com, example domains), RF Safe's business ZIP,
// the test order #1173, and product links on our own stores (their long ?variant= ids are not tracking numbers).
// Everything else that looks like an email, phone, street address, tracking number or order number is replaced.
const TEST_ORDERS = new Set(['1173']);
const OWN_HOSTS = /^(?:www\.)?(?:rfsafe\.app|rfsafe\.com|rfsafe\.org|callbots\.org|quantacase\.com|nnemf\.org)$/i;
const SAFE_EMAIL_DOMAIN = /(?:^|\.)(?:rfsafe\.app|rfsafe\.com|rfsafe\.org|callbots\.org|quantacase\.com|mail\.grokbot\.com|example\.com|example\.org|example\.net|example|invalid|test)$/i;
const BUSINESS_ZIPS = new Set(['33772']); // RF Safe ships from Seminole, Florida (public business address)
const TAG = { email: '[redacted email]', phone: '[redacted phone]', address: '[redacted address]', tracking: '[redacted tracking number]', order: '[redacted order number]' };

const RX = {
  email: /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g,
  // NANP numbers with separators, or +country numbers. 555-01xx is the reserved fictional range and is kept.
  phone: /(?<![\w\d])(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-](\d{4})(?![\d])|(?<![\w\d])\+(?:[2-9]\d{0,2})[\s.-]?\d{2,4}[\s.-]\d{3,4}[\s.-]?\d{3,4}(?!\d)/g,
  address: /\b\d{1,6}\s+(?:[NSEW]\.?\s+)?(?:[A-Z][a-z]+\.?\s+){1,4}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place|Ter|Terrace|Cir|Circle|Hwy|Highway|Pkwy|Parkway)\b\.?(?:[ ,]+(?:Apt|Unit|Suite|Ste|#)\s*[\w-]+)?/g,
  tracking: /\b(?:9[1-5]\d{18,24}|1Z[0-9A-Z]{16}|[A-Z]{2}\d{9}US|\d{12}|\d{15}|\d{20,22})\b/g,
  order: /(?:#\s?(\d{3,7})\b)|(?:\border(?:\s+(?:number|no\.?|num|id))?\s*(?:is\s*)?:?\s*#?\s?(\d{3,7})\b)/gi,
};

// Our own product/store URLs are masked first so their ids are never read as tracking or order numbers.
function protectUrls(s) {
  const kept = [];
  const out = s.replace(/https?:\/\/[^\s<>"')\]]+/g, (u) => { let h = ''; try { h = new URL(u).hostname; } catch { h = ''; } if (OWN_HOSTS.test(h)) { kept.push(u); return '\u0000' + (kept.length - 1) + '\u0000'; } return u; });
  return { out, restore: (x) => x.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]) };
}
function nearBusinessZip(s, idx, len) { const win = s.slice(idx, idx + len) + s.slice(idx + len, idx + len + 60).split(/\n|\.\s/)[0]; const m = win.match(/\b(\d{5})(?:-\d{4})?\b/g) || []; return m.some(z => BUSINESS_ZIPS.has(z.slice(0, 5))); }

// Returns findings without the full value: kind, position and a masked preview (first 2 and last 2 characters).
function scan(text) {
  const s = String(text == null ? '' : text); const { out } = protectUrls(s); const found = [];
  const add = (kind, m, idx) => found.push({ kind, at: idx, length: m.length, preview: m.length <= 6 ? m[0] + '***' : m.slice(0, 2) + '***' + m.slice(-2) });
  for (const m of out.matchAll(RX.email)) if (!SAFE_EMAIL_DOMAIN.test(m[1])) add('email', m[0], m.index);
  for (const m of out.matchAll(RX.phone)) { if (m[2] === '555' && /^01\d\d$/.test(m[3] || '')) continue; add('phone', m[0], m.index); }
  for (const m of out.matchAll(RX.address)) if (!nearBusinessZip(out, m.index, m[0].length)) add('address', m[0], m.index);
  for (const m of out.matchAll(RX.tracking)) add('tracking', m[0], m.index);
  for (const m of out.matchAll(RX.order)) { const n = m[1] || m[2]; if (!TEST_ORDERS.has(n)) add('order', m[0], m.index); }
  return found;
}
// Replaces every finding with a [redacted ...] tag. Returns the clean text and counts per kind.
function redact(text) {
  const s = String(text == null ? '' : text); const p = protectUrls(s); let out = p.out; const counts = {};
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; return TAG[k]; };
  out = out.replace(RX.email, (m, dom) => SAFE_EMAIL_DOMAIN.test(dom) ? m : bump('email'));
  out = out.replace(RX.phone, (m, a, b, c) => (b === '555' && /^01\d\d$/.test(c || '')) ? m : bump('phone'));
  out = out.replace(RX.address, (m, off, all) => nearBusinessZip(all, off, m.length) ? m : bump('address'));
  out = out.replace(RX.tracking, () => bump('tracking'));
  out = out.replace(RX.order, (m, a, b) => { const n = a || b; if (TEST_ORDERS.has(n)) return m; return m.replace(n, bump('order')).replace(/#\s?\[/, '['); });
  return { text: p.restore(out), counts };
}
const isSafeEmail = (addr) => { const m = String(addr || '').match(/@([A-Za-z0-9.-]+)\s*>?\s*$/); return !!(m && SAFE_EMAIL_DOMAIN.test(m[1])); };
module.exports = { scan, redact, isSafeEmail, TEST_ORDERS, TAG };
