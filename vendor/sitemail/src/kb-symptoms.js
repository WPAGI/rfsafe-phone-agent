'use strict';
// Brain box (the knowledge base, /mail/kb): symptom-to-research map.
// John, Nov 15, 4:01-4:03 PM ET: when a customer asks about headaches, ringing in the ears, sleep or any other
// symptom, the reply links to our study resources on that kind of disruption. "Not a mailbox rule, a brain box
// rule": the map is Brain box DATA, one editable KB entry per symptom group (slug symptom-map-<id>), written and
// read through the same KB API / agent API / Knowledge Base Admin as every other entry (locks, version history,
// undo). The Mailbox only reads it at reply time (src/mailbox/bots.js) and links the studies this module resolves.
//
// Entry text (one "Key: value" line each; lists separated by ";"):
//   Symptom: Headaches and migraines
//   Terms: headache; headaches; migraine; head pain          words or phrases a customer writes (synonyms)
//   Body systems: nervous                                   ids from site/research/data/body-systems-v1.json
//   Organs: brain                                           optional organ ids from the same file
//   Research keywords: headache; migraine                   words looked up in the research index
//   Pinned studies: https://rfsafe.app/research/papers/...  optional, shown first (rfsafe.app study pages only)
//   Brain box answers: headaches-from-phone-use             optional KB entry slugs that answer this symptom
// Symptom-map entries are not public (/kb) by default and are never indexed as answer passages.
// Public text (John, Nov 15, 5:40 PM ET: "They should show up in the public"): an entry may open with plain-language
// text for readers, followed by a MARKER line and then the mapping lines above. The public /kb shows only the text
// before the marker (publicText); the lookup reads only the mapping lines (parse ignores every other line).
const researchDir = require('./research-dir');

const PREFIX = 'symptom-map-';
const MARKER = 'Mailbox lookup data (Brain box symptom map, not shown on the public page)';
const TYPE = 'symptom-map';
const SITE = 'https://rfsafe.app';
const SYSTEMS = ['nervous', 'sensory-ocular', 'sensory-auditory', 'cardiovascular', 'immune', 'endocrine', 'reproductive', 'developmental', 'digestive', 'renal', 'respiratory', 'integumentary', 'musculoskeletal'];
const ORGANS = ['brain', 'hippocampus', 'cerebral-cortex', 'cerebellum', 'spinal-cord', 'pineal', 'eye', 'ear', 'heart', 'blood', 'thymus-spleen', 'bone-marrow', 'thyroid', 'adrenal', 'pituitary', 'pancreas', 'testis', 'sperm', 'ovary-uterus', 'prostate', 'breast', 'embryo-fetus', 'liver', 'salivary-parotid', 'intestine', 'kidney', 'bladder', 'lung', 'skin', 'muscle', 'bone'];
const KEYS = { symptom: 'symptom', terms: 'terms', 'body systems': 'systems', systems: 'systems', organs: 'organs', 'research keywords': 'keywords', keywords: 'keywords', 'pinned studies': 'pinned', pinned: 'pinned', 'brain box answers': 'answers', 'kb entries': 'answers' };
// Effect labels ranked for "top harm/effect studies": harm first, then mixed; null and benefit-only results last.
const EFFECT_RANK = { Harm: 6, Mixed: 3, Unclear: 0, Benefit: -2, 'No effect': -4 };

// Prefer radiofrequency / wireless studies over unrelated screen-light or therapy papers.
const RF = /\b(?:radio[- ]?frequency|rf|microwaves?|mobile|cell(?:ular)?|phones?|smartphones?|wi-?fi|wlan|wireless|base station|5g|4g|electromagnetic|emf|ghz|mhz)\b/i;
// Studies of EMF used as a treatment are not harm/effect evidence for a customer's symptom.
const THERAPY = /\b(?:treatment|therapy|therapeutic|stimulation|pemf|peripheral pulsed electromagnetic)\b/i;
const RF_TERMS = ['radiofrequency', 'microwave', 'microwaves', 'mobile', 'cellphone', 'smartphone', 'smartphones', 'wifi', 'wireless', 'electromagnetic', 'emf', 'emfs', 'ghz', 'mhz', 'base'];
const isSymptomSlug = (s) => typeof s === 'string' && s.startsWith(PREFIX) && s.length > PREFIX.length;
const list = (v) => String(v || '').split(/[;\n]/).map((x) => x.trim()).filter(Boolean);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parse(text) {
  const out = { symptom: '', terms: [], systems: [], organs: [], keywords: [], pinned: [], answers: [] };
  const t = String(text || '').replace(/^\s*Owner-approved answer \(source:[^)\n]*\):\s*/i, '');
  for (const line of t.split('\n')) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z ]{1,30}?)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = KEYS[m[1].toLowerCase().trim()];
    if (!k) continue;
    if (k === 'symptom') out.symptom = m[2].trim();
    else out[k].push(...list(m[2]).map((x) => (k === 'pinned' ? x : x.toLowerCase())));
  }
  return out;
}

// Problems with a symptom-map entry's text; empty when it is usable. Used by the KB API write path.
function validate(text) {
  const p = parse(text); const bad = [];
  if (!p.symptom) bad.push('Symptom: line is required');
  if (!p.terms.length) bad.push('Terms: needs at least one word or phrase');
  if (!p.systems.length && !p.keywords.length) bad.push('Body systems: or Research keywords: is required');
  const us = p.systems.filter((s) => !SYSTEMS.includes(s)); if (us.length) bad.push('unknown body system id: ' + us.join(', ') + ' (use ' + SYSTEMS.join(', ') + ')');
  const uo = p.organs.filter((s) => !ORGANS.includes(s)); if (uo.length) bad.push('unknown organ id: ' + uo.join(', '));
  const up = p.pinned.filter((u) => !researchDir.isPapersUrl(u)); if (up.length) bad.push('pinned studies must be https://rfsafe.app/research/papers/... pages: ' + up.join(', '));
  const ua = p.answers.filter((s) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)); if (ua.length) bad.push('Brain box answers must be entry slugs: ' + ua.join(', '));
  return bad;
}

// The map from a KB (src/kb.js) instance or any list of { slug, title, text } entries.
function mapFrom(source) {
  let entries = [];
  if (Array.isArray(source)) entries = source;
  else if (source && typeof source.entriesOfType === 'function') entries = source.entriesOfType(TYPE);
  else if (source && source.bySlug instanceof Map) entries = [...source.bySlug.values()].filter((e) => isSymptomSlug(e.slug));
  return entries.filter((e) => e && isSymptomSlug(e.slug) && e.enabled !== false && validate(e.text).length === 0)
    .map((e) => ({ id: e.slug.slice(PREFIX.length), slug: e.slug, title: e.title || '', ...parse(e.text) }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}
function toText(e) {
  return ['Symptom: ' + e.symptom, 'Terms: ' + e.terms.join('; '), e.systems.length ? 'Body systems: ' + e.systems.join('; ') : '', e.organs.length ? 'Organs: ' + e.organs.join('; ') : '',
    e.keywords.length ? 'Research keywords: ' + e.keywords.join('; ') : '', e.pinned.length ? 'Pinned studies: ' + e.pinned.join('; ') : '', e.answers.length ? 'Brain box answers: ' + e.answers.join('; ') : ''].filter(Boolean).join('\n');
}

// Which symptom groups a customer's text mentions. Each term matches as a whole word or phrase; flexible spaces/hyphens.
function termRe(term) { return new RegExp('(?:^|[^a-z0-9])' + esc(term.toLowerCase()).replace(/\\-|\s+/g, '[\\s-]+') + '(?=$|[^a-z0-9])', 'i'); }
function match(text, map) {
  const s = ' ' + String(text || '').toLowerCase().replace(/[\u2018\u2019]/g, "'") + ' ';
  const out = [];
  for (const e of map || []) {
    const t = e.terms.find((term) => termRe(term).test(s));
    if (t) out.push({ entry: e, term: t });
  }
  return out;
}

// The reader-facing part of a symptom-map entry for the public /kb: the text before the MARKER line. An entry with
// no marker is mapping data only, so it has no public text (and stays off /kb even when is_public is true).
function publicText(text) {
  const t = String(text || '').replace(/\r/g, '');
  const i = t.split('\n').findIndex((line) => line.trim().startsWith(MARKER));
  return i < 0 ? '' : t.split('\n').slice(0, i).join('\n').trim();
}

function systemUrl(id) { return SITE + '/research?system=' + encodeURIComponent(id); }

// Top harm/effect studies for one symptom group, from the research index. rfsafe.app study pages only.
function studiesFor(e, { k = 3, dataDir } = {}) {
  const idx = researchDir.load(dataDir);
  const kw = e.keywords.map((w) => researchDir.tokens(w)).filter((t) => t.length);
  const tags = idx.tags || {};
  const picked = []; const used = new Set();
  for (const u of e.pinned) {
    const rec = researchDir.byUrl(u, { dataDir });
    if (rec && !used.has(rec.paper_id)) { used.add(rec.paper_id); picked.push(rec); }
  }
  const scored = [];
  for (const rec of idx.records) {
    if (used.has(rec.paper_id) || researchDir.isRetracted(rec)) continue;
    let hits = 0; let titleHits = 0; const tt = new Set(researchDir.tokens(rec.title));
    for (const t of kw) { if (t.every((w) => rec._terms.has(w))) hits++; if (t.every((w) => tt.has(w))) titleHits++; }
    const tag = tags[String(rec.paper_id)] || null;
    const sysHit = !!(tag && e.systems.some((s) => (tag.s || []).includes(s)));
    const orgHit = !!(tag && e.organs.some((o) => (tag.o || []).includes(o)));
    if (!hits) continue;
    // Studies named for the symptom first, then body-system tags, harm/effect label, and people over lab models.
    const s = titleHits * 12 + hits * 6 + (orgHit ? 4 : 0) + (sysHit ? 3 : 0) + (EFFECT_RANK[rec.effect_label] || 0) + (rec.group === 'human' ? 3 : 0) + (RF.test(rec.title) ? 6 : 0) - (THERAPY.test(rec.title) ? 10 : 0);
    scored.push({ rec, s });
  }
  scored.sort((a, b) => b.s - a.s || (b.rec.year || 0) - (a.rec.year || 0));
  // Harm or effect studies first; only when there are too few, fall back to the rest.
  // Wireless exposure named in the title first (a "digital device use" or screen-light paper is not RF evidence).
  const rfStudy = (r) => RF.test(r.title);
  const effect = scored.filter((x) => (x.rec.effect_label === 'Harm' || x.rec.effect_label === 'Mixed') && !THERAPY.test(x.rec.title) && rfStudy(x.rec));
  const titles = new Set(picked.map((r) => r.title.toLowerCase()));
  const rfAny = scored.filter((x) => (x.rec.effect_label === 'Harm' || x.rec.effect_label === 'Mixed') && !THERAPY.test(x.rec.title) && RF_TERMS.some((w) => x.rec._terms.has(w)));
  for (const { rec } of [...effect, ...rfAny, ...scored]) { if (picked.length >= k) break; const tl = rec.title.toLowerCase(); if (used.has(rec.paper_id) || titles.has(tl)) continue; used.add(rec.paper_id); titles.add(tl); picked.push(rec); }
  return picked.slice(0, k).map((r) => ({ title: r.title, year: r.year, study_type: r.study_type, effect: r.effect_label || '', page_url: r.page_url }));
}

// What the Mailbox writer gets for an email: each mentioned symptom with its study pages and body-system page.
// source: a KB instance, a list of entries, or an already parsed map (mapFrom output).
function lookup(text, source, opts = {}) {
  const map = Array.isArray(source) && source.every((e) => e && Array.isArray(e.terms)) ? source : mapFrom(source);
  const hits = match(text, map);
  if (!hits.length) return null;
  const symptoms = hits.map(({ entry: e, term }) => ({
    id: e.id, symptom: e.symptom, matched: term,
    studies: studiesFor(e, opts),
    research_pages: e.systems.map((s) => ({ system: s, url: systemUrl(s) })),
    brain_box_answers: e.answers,
  }));
  return { symptoms, note: 'From the Brain box symptom map. For each symptom the customer mentions, link at least one of its study page_url values (https://rfsafe.app/research/papers/...) and you may add its research_pages link. Use only these URLs; never a source_url, PubMed, DOI or safecellularphones.org link. Describe what the studies looked at; never diagnose or say EMF caused the customer\'s symptom.' };
}
function urlsOf(l) { const out = []; for (const s of (l && l.symptoms) || []) { for (const x of s.studies) out.push(x.page_url); for (const p of s.research_pages) out.push(p.url); } return out; }

// Checker rule: every symptom the customer mentioned has at least one of its rfsafe.app study pages linked.
function linkProblem(body, l) {
  const b = String(body || '');
  const norm = (u) => researchDir.normUrl(u);
  const linked = new Set((b.match(/https?:\/\/[^\s<>()"'\]]+/g) || []).map((u) => norm(u.replace(/[.,;:!?]+$/, ''))).filter(Boolean));
  const missing = [];
  for (const s of (l && l.symptoms) || []) {
    const ok = s.studies.some((x) => linked.has(norm(x.page_url)));
    if (!ok) missing.push(s.symptom + (s.studies.length ? '' : ' (no study found in the research index)'));
  }
  return missing.length ? missing : null;
}

module.exports = { PREFIX, TYPE, MARKER, publicText, SYSTEMS, ORGANS, isSymptomSlug, parse, validate, mapFrom, match, studiesFor, lookup, urlsOf, linkProblem, systemUrl, toText };
