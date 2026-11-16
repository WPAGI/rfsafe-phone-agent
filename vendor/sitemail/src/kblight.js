'use strict';
// KB Light first, KB Full fallback (John Coates, Nov 16, 2026, 3:06-3:08 AM ET: "Search KB Light first, fall back to
// KB Full"; "Yes, deploy KB Light first then KB Full ... for email and phones").
//
//   KB Light = this site's Brain box entries (the owner-approved, locked entries shown on /kb).
//   KB Full  = everything the lookup searched before this change (the host's phone KB folders, read only, plus the
//              Brain box entries on top for the Mailbox), searched exactly as before.
//
// A question is searched in KB Light first. When KB Light has a GOOD MATCH, only those Light passages are returned
// (an approved Light entry always wins, and fewer tokens go to the model). Otherwise the KB Full answer is returned
// unchanged. Nothing here writes anything: both layers are read-only indexes.
//
// GOOD MATCH (documented threshold, see port/KB_LIGHT.md):
//   q = the question's content words (src/kb.js tokenizer, minus generic shop words like "case", "phone"), plus the
//       topic words added by EXPAND below (e.g. "Canada" also asks about "international" and "within the United States").
//   A Light passage is a good match when it contains at least MIN_TERMS (2) of those words AND at least
//   MIN_COVERAGE (60%) of the question's own content words, each word weighted by how rare it is in KB Light (IDF). The words that triggered a topic group (e.g. "10 year
//   old", "Canada") count as covered when 2+ of that group's topic words are in the passage, and a question that
//   triggered a group needs at least one of its groups met (a MagSafe question needs magnets/charging words, a kids
//   question RF Safe's recommendation). Good matches are ranked by how much of the question they cover. A one-word question
//   needs that word in the entry's title. Extra Light passages scoring under 50% of the best good match are dropped.
// Per-channel switches: mail, phone (voice), sms. Env KB_LIGHT_FIRST_MAIL / KB_LIGHT_FIRST_PHONE / KB_LIGHT_FIRST_SMS
// = 0|false|off turns a channel back to the old KB Full-only lookup without a code change (1|true|on forces it on);
// unset = the site config (kb.light_first). With no kb.light_first config every channel is off (old behaviour).
const { KB, tok } = require('./kb');

const MIN_TERMS = 2; const MIN_COVERAGE = 0.6; const RELATIVE_SCORE = 0.5;
// Words that appear in nearly every store or RF Safe answer, so they never decide a match on their own.
const GENERIC = new Set('case cases phone phones cell cellphone quantacase rfsafe rf safe hi hello hey thanks thank please would could get also just want need tell question questions about there any much many did were they them their she he his her we us im ive dont can cant know like work works working use using one two my our will'.split(' '));
// Topic words: a question that uses the left-hand words also asks about the right-hand words.
const EXPAND = [
  [/\bmag[\s-]?safe\b/i, 'magsafe magnetic magnets magnet wireless charging charger'],
  [/\bwireless(?:ly)?\s+charg\w*|\bqi\b|\bcharging\s+pads?\b|\bcharger\b/i, 'wireless charging charger magsafe'],
  [/\bcanada\b|\bmexico\b|\binternational(?:ly)?\b|\boverseas\b|\babroad\b|\bforeign\b|\boutside\s+(?:the\s+)?(?:u\.?s\.?a?\.?|united\s+states|us)\b|\b(?:uk|england|europe|australia)\b/i, 'international ship ships shipping within united states'],
  [/\bwest\s+coast\b|\beast\s+coast\b|\bcalifornia\b|\boregon\b|\bseattle\b|\bhow\s+long\b[^?.]{0,40}\b(?:ship|shipping|deliver|delivery|arrive|take)\w*|\bdelivery\s+times?\b|\bshipping\s+times?\b|\btransit\b/i, 'shipping ship ships usps business days coast arrive'],
  [/\b\d{1,2}[- ]?(?:year|yr)[- ]?olds?\b|\b(?:ten|eight|nine|eleven|twelve|seven|six)[- ]year[- ]olds?\b|\bsons?\b|\bdaughters?\b|\bteens?\b|\bteenagers?\b|\btoddlers?\b|\bminors?\b|\bkids?\b|\bchild(?:ren)?\b/i, 'child children recommend'],
];
const terms = (s) => [...new Set(tok(s))].filter((w) => !GENERIC.has(w));

function queryTerms(q) {
  const text = String(q || ''); const own = terms(text); const groups = [];
  for (const [re, words] of EXPAND) { const m = text.match(re); if (m) groups.push({ trigger: terms(m[0]), words: terms(words) }); }
  const extra = [...new Set(groups.flatMap((g) => g.words))].filter((w) => !own.includes(w));
  return { own, extra, groups };
}
// True when one Light hit is a good match for the question (see the header for the rule).
function goodMatch(q, hit, opts = {}) {
  const minTerms = opts.min_terms || MIN_TERMS; const minCov = opts.min_coverage != null ? opts.min_coverage : MIN_COVERAGE;
  const qt = typeof q === 'string' ? queryTerms(q) : q;
  if (!qt.own.length) return 0;
  const title = new Set(tok(String((hit && hit.title) || '')));
  const ht = new Set([...title, ...tok(String((hit && hit.text) || ''))]);
  // A one-word question (e.g. "returns?") needs that word in the entry's title.
  if (qt.own.length === 1 && !qt.groups.length) return title.has(qt.own[0]) ? 1 : 0;
  const covered = new Set(qt.own.filter((w) => ht.has(w)));
  let matched = covered.size; let groupsMet = 0;
  // Topic groups: a group is met when the passage has at least 2 of its topic words that are not already question
  // words (or all of them, when fewer are left). Then the question words that triggered it (e.g. "10 year old",
  // "Canada") count as covered. When the question triggered any group, at least one must be met: a MagSafe question
  // needs a passage about magnets or charging, a kids question one with RF Safe's recommendation.
  for (const g of qt.groups) { const words = g.words.filter((w) => !qt.own.includes(w)); const hits = words.filter((w) => ht.has(w)); if (words.length && hits.length >= Math.min(2, words.length)) { groupsMet++; for (const w of g.trigger) if (qt.own.includes(w)) covered.add(w); matched += hits.length; } }
  if (qt.groups.length && !groupsMet) return 0;
  // Coverage is weighted by how rare each question word is in KB Light (IDF), so a rare word the passage misses
  // ("talk", "staff") counts more than common ones it has ("real", "person").
  const w = (t) => (opts.idf ? opts.idf(t) : 1); const total = qt.own.reduce((a, t) => a + w(t), 0) || 1;
  const cov = [...covered].reduce((a, t) => a + w(t), 0) / total;
  const ok = matched >= Math.min(minTerms, qt.own.length + qt.extra.length) && cov >= minCov && covered.size >= 1;
  return ok ? covered.size * 10 + groupsMet : 0; // 0 = not a good match; otherwise higher = covers more of the question
}

function flagOn(env, channel, cfgOn) {
  const v = String((env || {})['KB_LIGHT_FIRST_' + String(channel).toUpperCase()] || '').trim().toLowerCase();
  if (/^(0|false|off|no)$/.test(v)) return false;
  if (/^(1|true|on|yes)$/.test(v)) return true;
  return !!cfgOn;
}

// light(): the KB Light index (a src/kb.js KB over the Brain box entries only). full(): the KB Full index or object
// with the same search/answer methods. cfg: kb.light_first from the site config.
function createKbLightFirst({ light, env = process.env, cfg = {} } = {}) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const opts = { min_terms: Number.isInteger(c.min_terms) ? c.min_terms : MIN_TERMS, min_coverage: typeof c.min_coverage === 'number' ? c.min_coverage : MIN_COVERAGE };
  const channelOn = (ch) => flagOn(env, ch, c[ch]);
  const tenants = Array.isArray(c.phone_tenants) ? c.phone_tenants.map(String) : [];
  // Light passages that are good matches (best first), or [] when KB Light has nothing good.
  function lightHits(q, k = 3) {
    let L; try { L = light(); } catch { return []; }
    if (!L || !L.docs || !L.docs.length) return [];
    const qt = queryTerms(q); const out = []; const N = L.docs.length;
    const idf = (t) => { const p = L.post.get(t); const n = p ? p.length / 2 : 0; return Math.log(1 + (N - n + 0.5) / (n + 0.5)); };
    const mopts = { ...opts, idf };
    for (const h of L.search(q + ' ' + qt.extra.join(' '), Math.max(k * 4, 12))) { const m = goodMatch(qt, h, mopts); if (m) out.push({ h, m }); }
    // Best first: the passage that covers more of the question wins, then the higher search score. Weak tail passages
    // (under RELATIVE_SCORE of the best good match's score) are dropped, so one strong entry is not padded.
    out.sort((a, b) => b.m - a.m || (b.h.score || 0) - (a.h.score || 0));
    const top = Math.max(0, ...out.map((x) => x.h.score || 0));
    return out.filter((x, i) => i === 0 || (x.h.score || 0) >= top * RELATIVE_SCORE).slice(0, k).map((x) => ({ ...x.h, layer: 'light' }));
  }
  // Mailbox: same contract as KB#search. opts.title (same-entry follow-up) goes to the layer that holds that title.
  function search(full, q, k = 3, o = {}) {
    if (o && o.title) { let L = null; try { L = light(); } catch {} const lh = L && L.docs && L.docs.some((d) => d.title === o.title) ? L.search(q, k, o).map((h) => ({ ...h, layer: 'light' })) : []; return lh.length ? lh : full.search(q, k, o); }
    const lh = lightHits(q, k); if (lh.length) return lh;
    return full.search(q, k, o);
  }
  // Phone and SMS: same contract as KB#answer (found, guidance, passages), plus kb_layer.
  function answer(full, q) {
    const lh = lightHits(q, 3);
    if (lh.length) return { ...KB.prototype.answer.call({ search: () => lh }, q), kb_layer: 'light' };
    return { ...full.answer(q), kb_layer: 'full' };
  }
  return {
    channelOn, lightHits, search, answer,
    // Phone/SMS hook for the host: null means "not handled, use the host's own lookup exactly as before".
    answerFor(tenantId, q, channel, full) { const ch = channel === 'voice' ? 'phone' : channel; if (!['phone', 'sms'].includes(ch) || !channelOn(ch) || !tenants.includes(String(tenantId)) || !full) return null; return answer(full, q); },
    status() { let n = 0; try { const L = light(); n = L && L.bySlug ? L.bySlug.size : 0; } catch {} return { mail: channelOn('mail'), phone: channelOn('phone'), sms: channelOn('sms'), light_entries: n, min_terms: opts.min_terms, min_coverage: opts.min_coverage }; },
  };
}

module.exports = { createKbLightFirst, goodMatch, queryTerms, flagOn, MIN_TERMS, MIN_COVERAGE, RELATIVE_SCORE, EXPAND, GENERIC };
