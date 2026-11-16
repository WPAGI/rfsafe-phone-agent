'use strict';
// Server-side lookup over the public research directory (site/research/data/research-index*.json).
// There is no mailbox tool, phone-line tool, or /api/research search; the site search in
// site/research/assets/app.js already loads these same files in the browser. This module reads
// them on the server so the mailbox writer can attach real rfsafe.app research page URLs by topic.
// John, Nov 15, 1:18 PM ET: link only to https://rfsafe.app/research/papers/... (the index url field).
// Never give the writer source_url (safecellularphones.org), PubMed, or DOI links; the study page
// has the "open original study" link.
const fs = require('fs');
const path = require('path');
const bodySystems = require('../site/research/assets/body-systems.js');
const picks = require('./study-picks');

const DEFAULT_DIR = path.join(__dirname, '..', 'site', 'research', 'data');
const SITE = 'https://rfsafe.app';
const HUMAN = new Set(['randomized_trial', 'cross_sectional', 'cohort', 'case_control', 'case_report', 'ecological']);
const STOP = new Set('a an and are as at be by can do does for from has have how i if in is it its me my of on or our that the this to was what when where which who why will with you your about like just also have had has been being into than then them they their'.split(' '));
const SYN = [
  [/\bbrain tumou?rs?\b/g, ' glioma glioblastoma meningioma '],
  [/\bbrain cancers?\b/g, ' glioma glioblastoma '],
  [/\bgliomas?\b/g, ' glioma glioblastoma brain tumor '],
  [/\bglioblastomas?\b/g, ' glioblastoma glioma brain tumor '],
];

function normUrl(u) {
  try {
    const x = new URL(u);
    let p = x.pathname;
    try { p = decodeURIComponent(p); } catch {}
    return (x.protocol + '//' + x.hostname.replace(/^www\./i, '') + p.replace(/\/+$/, '')).toLowerCase();
  } catch { return null; }
}
function tok(s) {
  let t = String(s || '').toLowerCase();
  for (const [re, r] of SYN) t = t.replace(re, r);
  return [...new Set(t.replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))];
}
function isPapersUrl(u) {
  try {
    const x = new URL(u);
    let p = x.pathname;
    try { p = decodeURIComponent(p); } catch {}
    const host = x.hostname.replace(/^www\./i, '').toLowerCase();
    return x.protocol === 'https:' && host === 'rfsafe.app' && p.toLowerCase().startsWith('/research/papers/');
  } catch { return false; }
}
function pageUrl(rec) {
  const u = String(rec && rec.url || '').trim();
  if (!u) return '';
  let pathname = u;
  if (/^https?:\/\//i.test(u)) {
    try { pathname = new URL(u).pathname; } catch { return ''; }
  }
  if (!pathname.startsWith('/')) pathname = '/' + pathname;
  if (!/^\/research\/papers\//i.test(pathname)) return '';
  return SITE + pathname;
}
function groupOf(type) {
  if (type === 'animal') return 'animal';
  if (type === 'in_vitro') return 'lab';
  if (HUMAN.has(type)) return 'human';
  return 'other';
}

let cache = null;
function load(dataDir) {
  const dir = dataDir || DEFAULT_DIR;
  if (cache && cache.dir === dir) return cache;
  const records = [];
  const urls = new Set();
  const manifestPath = path.join(dir, 'research-index.json');
  if (!fs.existsSync(manifestPath)) { cache = { dir, records, urls }; return cache; }
  let files = [];
  try {
    const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const chunks = Array.isArray(man.chunks) ? man.chunks : [];
    const resolve = (name) => {
      const n = String(name || '').replace(/^\/+/, '');
      if (!n) return null;
      return [path.join(dir, n), path.join(dir, path.basename(n)), path.join(path.dirname(dir), n)].find((f) => fs.existsSync(f)) || null;
    };
    files = chunks.map((c) => resolve(typeof c === 'string' ? c : (c.file || c.name || c.path || ''))).filter(Boolean);
  } catch {}
  if (!files.length) {
    for (let i = 0; i < 16; i++) {
      const f = path.join(dir, 'research-index-' + i + '.json');
      if (fs.existsSync(f)) files.push(f);
    }
  }
  for (const f of files) {
    let recs = [];
    try { recs = JSON.parse(fs.readFileSync(f, 'utf8')).records || []; } catch { continue; }
    for (const rec of recs) {
      const page = pageUrl(rec);
      if (!page) continue;
      const np = normUrl(page); if (np) urls.add(np);
      // The effect classification (Harm, Mixed...) is not topic text: a customer writing "harm" must not pull every Harm-labeled paper.
      const blob = [rec.title, Array.isArray(rec.keywords) ? rec.keywords.join(' ') : '', rec.summary, rec.journal].map((x) => String(x || '')).join(' ');
      records.push({
        paper_id: rec.paper_id,
        title: String(rec.title || '').trim(),
        year: rec.year || null,
        journal: rec.journal || '',
        study_type: rec.study_type || 'unknown',
        effect_label: rec.effect_label || '',
        group: groupOf(rec.study_type),
        page_url: page,
        keywords: Array.isArray(rec.keywords) ? rec.keywords : [],
        retracted: rec.retracted === true,
        status: rec.status || '',
        flags: rec.flags,
        _terms: new Set(tok(blob)),
      });
    }
  }
  let tags = {};
  try { tags = (bodySystems.loadFromDir(fs, path, dir).tags) || {}; } catch {}
  cache = { dir, records, urls, tags };
  return cache;
}
function resetCache() { cache = null; }

// Wireless exposure in the title (same idea as the Brain box symptom map, src/kb-symptoms.js): an ELF power-line,
// corn-plant or EMF-therapy paper is not evidence about phones.
const RF = /\b(?:radio[- ]?frequency|rf|rf-emfs?|microwaves?|mobile|cell(?:ular)?|cellphones?|phones?|smartphones?|wi-?fi|wlan|wireless|base stations?|5g|4g|lte|gsm|cdma|umts|ghz|mhz)\b/i;
const THERAPY = /\b(?:treatments?|treating|therapy|therapeutic|stimulation|pemf|tumor-treating|remodeling|ablation|procedures?|surgery|surgical|catheter)\b/i;
const exposureScore = (rec) => (RF.test(rec.title) ? 3 : 0) - (THERAPY.test(rec.title) ? 10 : 0);
// q = topic words (or every word when the email has none); ctx = the generic words the email used (tie-breakers only).
function keywordHits(idx, q, ctx = []) {
  const scored = [];
  for (const rec of idx.records) {
    if (bodySystems.isRetracted(rec)) continue;
    let s = 0;
    for (const t of q) if (rec._terms.has(t)) s += t.length > 5 ? 2 : 1;
    if (!s) continue;
    for (const t of ctx) if (rec._terms.has(t)) s += 0.25;
    s += exposureScore(rec);
    if (s > 0) scored.push({ rec, s });
  }
  scored.sort((a, b) => b.s - a.s || (b.rec.year || 0) - (a.rec.year || 0));
  return scored;
}
function tagHits(idx, mapped, q) {
  const scored = [];
  const tags = idx.tags || {};
  for (const rec of idx.records) {
    if (bodySystems.isRetracted(rec)) continue;
    const tag = tags[String(rec.paper_id)];
    if (!tag) continue;
    const organHit = mapped.organs.length && mapped.organs.some((o) => (tag.o || []).includes(o));
    const systemHit = mapped.systems.length && mapped.systems.some((s) => (tag.s || []).includes(s));
    if (!organHit && !systemHit) continue;
    let s = 0;
    if (organHit) s += 8;
    if (systemHit) s += 4;
    if (tag.src === 'rules') s += 3;
    else if ((tag.conf || 0) >= bodySystems.AI_MIN) s += 1;
    for (const t of q) if (rec._terms.has(t)) s += t.length > 5 ? 2 : 1;
    s += exposureScore(rec);
    if (s > 0) scored.push({ rec, s });
  }
  scored.sort((a, b) => b.s - a.s || (b.rec.year || 0) - (a.rec.year || 0));
  return scored;
}
// Study picks (Brain box rule internal-study-picks, src/study-picks.js; John, Nov 15, 11:28 PM ET "search harm first").
// Only studies on the email's topic count (score at least `floor` of the best). Within each study group, the preferred
// effect class (Harm) comes first; other classes fill in, in the rule's order, only when there is no relevant Harm study.
function pickStudies(scored, cap, rules = picks.DEFAULTS) {
  const top = scored.length ? scored[0].s : 0;
  const relevant = scored.filter((h) => h.s > 0 && h.s >= top * (rules.floor || 0));
  const order = [...rules.prefer, ...rules.then];
  const tier = (rec) => { const i = order.indexOf(rec.effect_label || 'Unknown'); return i < 0 ? order.length : i; };
  const ranked = relevant.map((h, i) => ({ ...h, i })).sort((a, b) => tier(a.rec) - tier(b.rec) || a.i - b.i);
  const picked = [];
  const used = new Set();
  const take = (group, n) => {
    let c = 0;
    for (const { rec } of ranked) {
      if (c >= n || used.has(rec.paper_id) || rec.group !== group) continue;
      used.add(rec.paper_id); picked.push(rec); c++;
    }
  };
  take('animal', 2); take('lab', 2); take('human', 2);
  for (const { rec } of ranked) {
    if (picked.length >= cap) break;
    if (used.has(rec.paper_id)) continue;
    used.add(rec.paper_id); picked.push(rec);
  }
  return picked;
}
function mergeHits(primary, fallback) {
  const seen = new Set(primary.map((h) => h.rec.paper_id));
  const out = primary.slice();
  for (const h of fallback) {
    if (seen.has(h.rec.paper_id)) continue;
    seen.add(h.rec.paper_id);
    out.push(h);
  }
  return out;
}
function search(query, opts = {}) {
  const idx = load(opts.dataDir);
  const rules = opts.rules || picks.DEFAULTS;
  const all = tok(query);
  // Topic words only: "phone", "study", "harm", "safe" and plain conversation say nothing about the topic.
  const generic = new Set(rules.generic || []);
  const topic = all.filter((t) => !generic.has(t));
  const q = topic.length ? topic : all;
  if (!q.length || !idx.records.length) return { query: String(query || '').slice(0, 200), studies: [] };
  const mapped = bodySystems.mapQuery(query);
  const tagged = (mapped.systems.length || mapped.organs.length) ? tagHits(idx, mapped, q) : [];
  const keywords = keywordHits(idx, q, topic.length ? all.filter((t) => generic.has(t)) : []);
  // Prefer rules tags, then high-confidence AI tags; fill from keyword search if fewer than two tagged hits.
  const scored = tagged.length >= 2 ? tagged : mergeHits(tagged, keywords);
  const cap = Math.max(6, Number(opts.k) || 6);
  const picked = pickStudies(scored, cap, rules);
  const studies = picked.map(({ _terms, retracted, status, flags, ...pub }) => pub);
  return { query: String(query || '').slice(0, 200), studies, note: 'From the RF Safe research directory. Use only these page_url values (https://rfsafe.app/research/papers/...). Never use a source_url, PubMed, DOI or any other research link; the customer can open the original study from that page. Never invent a link or paper.' };
}

// The index record for an rfsafe.app study page URL (Brain box symptom map pins), or null.
function byUrl(u, opts = {}) {
  if (!isPapersUrl(u)) return null;
  const n = normUrl(u); const idx = load(opts.dataDir);
  if (!idx.byUrl) { idx.byUrl = new Map(); for (const r of idx.records) idx.byUrl.set(normUrl(r.page_url), r); }
  return idx.byUrl.get(n) || null;
}
function isKnownUrl(u, opts = {}) {
  if (!isPapersUrl(u)) return false;
  const n = normUrl(u);
  return !!(n && load(opts.dataDir).urls.has(n));
}
function urlsOf(lookup) {
  const out = [];
  for (const s of (lookup && lookup.studies) || []) {
    if (s.page_url && isPapersUrl(s.page_url)) out.push(s.page_url);
  }
  return out;
}
function isOffsiteResearchUrl(u) {
  try {
    const x = new URL(u);
    const host = x.hostname.replace(/^www\./i, '').toLowerCase();
    const path = x.pathname.toLowerCase();
    if (host === 'safecellularphones.org' || host.endsWith('.safecellularphones.org')) return true;
    if (host === 'doi.org' || host === 'dx.doi.org') return true;
    if (host === 'pubmed.ncbi.nlm.nih.gov' || host === 'ncbi.nlm.nih.gov' || host === 'pmc.ncbi.nlm.nih.gov' || host.endsWith('.ncbi.nlm.nih.gov')) return true;
    if (host === 'rfsafe.app' && path.startsWith('/research/papers/')) return false;
    if (/\/pubmed\/|\/pmc\/|\bdoi\b/.test(host + path)) return true;
    return false;
  } catch { return false; }
}

// A paper named by an outside source (e.g. a web search finding) -> its rfsafe.app study page, when the research directory
// has the same paper. Title match on word overlap (both ways), so "Mobile phone use and brain tumour risk - COSMOS, a
// prospective cohort study" finds record 198. Retracted records are never returned. Returns [] when unsure.
function findByTitle(title, opts = {}) {
  const want = [...new Set(tok(title))]; if (want.length < 4) return [];
  const min = Number(opts.min) || 0.8; const out = [];
  for (const r of load(opts.dataDir).records) {
    if (r.retracted) continue;
    const have = [...new Set(tok(r.title))]; if (have.length < 3) continue;
    const hs = new Set(have); const inter = want.filter((w) => hs.has(w)).length;
    const score = Math.min(inter / want.length, inter / have.length);
    if (score >= min) out.push({ paper_id: r.paper_id, title: r.title, year: r.year, page_url: r.page_url, score: Math.round(score * 100) / 100 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, Number(opts.k) || 3);
}

module.exports = { findByTitle, search, byUrl, tokens: tok, isRetracted: bodySystems.isRetracted, isKnownUrl, urlsOf, isPapersUrl, isOffsiteResearchUrl, load, resetCache, normUrl, pageUrl, SITE, DEFAULT_DIR, mapQuery: bodySystems.mapQuery };
