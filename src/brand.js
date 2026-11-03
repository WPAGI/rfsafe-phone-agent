'use strict';
// Per-tenant brand. The prompts, tool notes, emails and texts were written for RF Safe. A tenant WITHOUT a
// `brand` block gets that text unchanged (byte-for-byte; see test/brand-snapshot.test.js). A tenant WITH a
// `brand` block gets the RF Safe names, addresses and sites swapped for its own.
//   brand: { team_name: "Best Deal On", email_from: "Best Deal On <no-reply@bestdealon.app>", site: "bestdealon.app",
//            trademark_line?: "Best Deal On is a product of Quanta X Technology LLC.", kb_allow_domains?: ["bestdealon.app"] }
const LEGACY = Object.freeze({
  team_name: 'RF Safe', email_from: 'RF Safe <rfsafe@callbots.org>', site: 'rfsafe.org',
  trademark_line: 'RF Safe is a trademark of Quanta X Technology LLC.',
  kb_allow_domains: ['rfsafe.org', 'quantacase.com', 'doi.org', 'pubmed.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov', 'x.com', 'ntp.niehs.nih.gov'],
});
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const FROM_RE = /^[^<>\r\n]{1,60} <[^@\s<>]+@[a-z0-9-]+(\.[a-z0-9-]+)+>$/i;

function validateBrand(b) {
  if (b == null) return [];
  const e = [];
  if (typeof b !== 'object' || Array.isArray(b)) return ['brand must be an object'];
  if (typeof b.team_name !== 'string' || !b.team_name.trim() || b.team_name.length > 60 || /[\r\n<>]/.test(b.team_name)) e.push('brand.team_name required (max 60, one line)');
  if (typeof b.email_from !== 'string' || !FROM_RE.test(b.email_from)) e.push('brand.email_from must look like "Name <addr@domain>"');
  if (typeof b.site !== 'string' || !DOMAIN.test(b.site)) e.push('brand.site must be a bare domain');
  if (b.trademark_line != null && (typeof b.trademark_line !== 'string' || b.trademark_line.length > 200 || /[\r\n<>]/.test(b.trademark_line))) e.push('brand.trademark_line max 200 chars, one line');
  if (b.kb_allow_domains != null && (!Array.isArray(b.kb_allow_domains) || !b.kb_allow_domains.length || !b.kb_allow_domains.every((d) => typeof d === 'string' && DOMAIN.test(d)))) e.push('brand.kb_allow_domains must be bare domains');
  for (const k of Object.keys(b)) if (!['team_name', 'email_from', 'site', 'trademark_line', 'kb_allow_domains'].includes(k)) e.push('brand.' + k + ' unknown');
  return e;
}

function brandFor(t) {
  const b = t && t.brand;
  if (!b) return LEGACY;
  return { team_name: b.team_name, email_from: b.email_from, site: b.site, trademark_line: b.trademark_line || '', kb_allow_domains: b.kb_allow_domains || [b.site] };
}
const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const addrOf = (from) => (String(from).match(/<([^>]+)>/) || [])[1] || String(from);

// Swap RF Safe wording for the tenant's brand. No brand block -> the exact input string.
function rebrand(text, t) {
  if (typeof text !== 'string' || !t || !t.brand) return text;
  const b = brandFor(t);
  return text
    .replace(/rfsafe@callbots\.org/g, addrOf(b.email_from))
    .replace(/RF Safe is a trademark of Quanta X Technology LLC\.(<br>|\n| )?/g, (m, sep) => (b.trademark_line ? b.trademark_line + (sep || '') : ''))
    .replace(/(?:www\.)?rfsafe\.org|quantacase\.com/g, b.site)
    .replace(new RegExp(esc(b.site) + '(?: and | or | / |, |/)' + esc(b.site), 'g'), b.site)
    .replace(/\bQuantaCase\b/g, b.team_name)
    .replace(/\b([Aa])n RF Safe\b/g, (m, a) => (/^[aeiou]/i.test(b.team_name) ? a + 'n ' : a + ' ') + b.team_name)
    .replace(/\bRF Safe\b/g, b.team_name);
}
// Rebrand every string inside a tool result / definition (shallow objects and arrays).
function rebrandDeep(v, t) {
  if (!t || !t.brand) return v;
  if (typeof v === 'string') return rebrand(v, t);
  if (Array.isArray(v)) return v.map((x) => rebrandDeep(x, t));
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = (/^(url|urls|sources|source)$/.test(k) && (typeof x === 'string' || (Array.isArray(x) && x.every((y) => typeof y === 'string')))) ? x : rebrandDeep(x, t); return o; }
  return v;
}
module.exports = { LEGACY, brandFor, rebrand, rebrandDeep, validateBrand, addrOf };
