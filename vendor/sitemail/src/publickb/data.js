'use strict';
// Public knowledge base (rfsafe.app/kb): the data layer. Reads the live owner KB store (DATA_DIR/kb-api/<tenant>/meta)
// on request, with a cache of a few seconds at most, so a publish, edit, undo or visibility change in Knowledge
// Base Admin shows up right away. See docs/PUBLIC_KB.md.
//
// Privacy rule (enforced here, and only here): an entry is public when
//   1. it is a knowledge base entry (the owner KB store), and
//   2. it is enabled, and
//   3. it is public: the owner's toggle in Knowledge Base Admin wins; otherwise the entry's own is_public flag;
//      otherwise true, except built-in internal entries (the phone line's answer guide and similar).
// Only whitelisted fields leave this module: slug, title, question, topic, text, source, updated. Never gap ids,
// source questions (they can quote a customer), admin settings, proposals, prompts, keys or usage.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const symptoms = require('../kb-symptoms');

const SCHEMA = 'rfsafe-public-kb/1';
const API_VERSION = 1;
const TTL_MS = 3000; // at most a few seconds stale; publishes and toggles also reset the cache at once
const CORE_SLUG = 'rfsafe-core-position';
const OTHER_TOPIC = 'More answers';
// Preferred reading order for the section prefixes the KB titles use ("Core Science: What is ...?").
// Topics are derived from the live titles; any new prefix still shows up, after these, alphabetically.
const TOPIC_ORDER = ['Core Science', 'How It Works', 'Health Effects', 'Symptoms', 'Cancer Studies', 'Safety Evidence', 'Safety Limits', 'FCC Limits and SAR Testing',
  'Court Case and FCC', 'HHS, FDA and Public Law 90-602', 'Towers and Section 704', 'Public Comments', 'Children and Pregnancy',
  'Everyday Habits', 'QuantaCase', 'Li-Fi and Wired', 'About RF Safe'];
// Topics whose entries are Research Bot's safety-claim critiques ("What is wrong with study X?"). They fill the
// Safety-claim critiques section; overview answers first, then the study-by-study critiques (slugs "critique-…").
const CRITIQUE_TOPICS = new Set(['Safety Evidence']);
// /kb/<slug> paths that are pages, not entries. An entry with one of these slugs is left off the public page.
const RESERVED = new Set(['topics', 'topic', 'body-systems', 'critiques', 'safety-claims', 'search', 'api', 'assets', 'entry', 'start', 'about', 'for-ai']);
// Built-in internal entries: instructions for the phone line or bots, not positions. Hidden unless the owner turns them on.
const INTERNAL_SLUG = /(?:^|-)voice-answer-guide$|(?:^|-)reference-guide$|^internal-|^draft-|^symptom-map-/; // symptom-map-*: Brain box data (src/kb-symptoms.js), not public by default
const INTERNAL_TITLE = /\b(?:phone line answers|answer guide|bot instructions|internal only|internal use)\b/i;
const OWNER_PREFIX = /^Owner-approved (?:answer|refund policy)[^\n]*:\s*\n+/i;
const BODY_SYSTEM_IDS = ['nervous', 'sensory-ocular', 'sensory-auditory', 'cardiovascular', 'immune', 'endocrine', 'reproductive',
  'developmental', 'digestive', 'renal', 'respiratory', 'integumentary', 'musculoskeletal'];
// Plain names for the 13 groups (the research taxonomy labels use medical terms; those are shown second).
const BODY_SYSTEM_NAMES = { nervous: 'Brain and nerves', 'sensory-ocular': 'Eyes', 'sensory-auditory': 'Ears and hearing', cardiovascular: 'Heart and blood vessels',
  immune: 'Immune system and blood', endocrine: 'Hormone glands', reproductive: 'Reproductive system', developmental: 'Development and pregnancy',
  digestive: 'Digestive system and liver', renal: 'Kidneys and bladder', respiratory: 'Lungs', integumentary: 'Skin', musculoskeletal: 'Muscles and bones' };
const STOP = new Set('a an and are as at be but by can could do does for from had has have how i if in into is it its may me more most my no not of on or our out so than that the their them then there these they this to too up was we were what when where which who why will with would you your yes'.split(' '));

const topicSlug = (name) => String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'more';
const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter((w) => w.length > 1 && !STOP.has(w));

function splitTitle(title) {
  const t = String(title || '').trim();
  const m = t.match(/^([A-Z][^:?]{1,58}):\s+(.+)$/);
  // "Safety Evidence (overview): …" belongs to "Safety Evidence".
  if (m) return { topic: m[1].trim().replace(/\s*\([^)]*\)$/, '') || m[1].trim(), question: m[2].trim() };
  return { topic: OTHER_TOPIC, question: t };
}

function isInternal(slug, title) { return INTERNAL_SLUG.test(String(slug || '')) || INTERNAL_TITLE.test(String(title || '')); }
// Effective public flag. override: the owner's toggle (true/false) or undefined. meta: the stored entry.
function effectivePublic({ slug, title, meta, override }) {
  if (typeof override === 'boolean') return override;
  if (meta && typeof meta.is_public === 'boolean') return meta.is_public;
  return !isInternal(slug, title || (meta && meta.title));
}

function readJsonFile(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
// mtime-cached JSON file reader (body-system labels, summaries, critiques).
function fileCache() {
  const m = new Map();
  return (file) => {
    let st; try { st = fs.statSync(file); } catch { m.delete(file); return null; }
    const c = m.get(file); if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.data;
    const data = readJsonFile(file); m.set(file, { mtime: st.mtimeMs, size: st.size, data }); return data;
  };
}
const httpsUrl = (u) => typeof u === 'string' && /^https:\/\/[^\s"<>]+$/.test(u) ? u : '';

function createData({ kbApiStore, tenantId, visibility = () => ({}), siteDir, dataDir, repoDir = path.join(__dirname, '..', '..'), now = () => new Date(), ttlMs = TTL_MS, baseUrl = () => 'https://rfsafe.app' }) {
  let cache = null;
  const readFile = fileCache();
  const reset = () => { cache = null; };

  function bodySystems() {
    const tax = readFile(path.join(siteDir, 'research', 'data', 'body-systems-v1.json')) || {};
    const sums = readFile(path.join(siteDir, 'research', 'data', 'body-system-summaries-v1.json')) || {};
    const labels = new Map((Array.isArray(tax.systems) ? tax.systems : []).map((s) => [s.id, s.label]));
    const sys = sums && sums.systems && typeof sums.systems === 'object' ? sums.systems : {};
    return BODY_SYSTEM_IDS.map((id) => {
      const s = sys[id] && typeof sys[id] === 'object' ? sys[id] : {};
      const blurb = typeof s.site_blurb === 'string' && s.site_blurb.trim().length >= 40 ? s.site_blurb.trim() : null;
      return { id, name: BODY_SYSTEM_NAMES[id], research_label: labels.get(id) || null, summary: blurb, summary_title: typeof s.title === 'string' ? s.title.trim().slice(0, 120) : null,
        summary_updated: typeof s.updated === 'string' ? s.updated.slice(0, 40) : null, research_url: '/research?system=' + encodeURIComponent(id) };
    });
  }
  // Safety-claim critiques: a data slot for Research Bot. The data disk copy (DATA_DIR/kb-public/…) wins over the repo copy.
  function critiques() {
    const name = 'safety-claim-critiques-v1.json';
    const doc = (dataDir && readFile(path.join(dataDir, 'kb-public', name))) || readFile(path.join(repoDir, 'kb', 'public', name)) || {};
    const items = (Array.isArray(doc.items) ? doc.items : []).filter((x) => x && typeof x === 'object' && x.published !== false && typeof x.claim === 'string' && typeof x.critique === 'string').slice(0, 500).map((x, i) => ({
      id: topicSlug(x.id || x.claim).slice(0, 60) || 'critique-' + (i + 1), claim: x.claim.trim().slice(0, 400), claimed_by: typeof x.claimed_by === 'string' ? x.claimed_by.trim().slice(0, 200) : '',
      critique: x.critique.trim().slice(0, 6000), sources: (Array.isArray(x.sources) ? x.sources : []).map((s) => ({ title: String((s && s.title) || '').slice(0, 200), url: httpsUrl(s && s.url) })).filter((s) => s.url).slice(0, 12),
      kb_slugs: (Array.isArray(x.kb_slugs) ? x.kb_slugs : []).filter((s) => typeof s === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)).slice(0, 10), updated: typeof x.updated === 'string' ? x.updated.slice(0, 40) : null
    }));
    return { items };
  }

  let derived = null; // { key, ... } heavy parts, rebuilt only when the public content changes
  function build() {
    const tid = tenantId();
    let metas = []; try { metas = tid && kbApiStore ? kbApiStore.list(tid) : []; } catch { metas = []; }
    let vis = {}; try { vis = (tid && visibility(tid)) || {}; } catch { vis = {}; }
    const entries = [];
    for (const m of metas) {
      if (!m || !m.slug || m.enabled !== true) continue;
      if (RESERVED.has(m.slug)) continue;
      if (!effectivePublic({ slug: m.slug, title: m.title, meta: m, override: vis[m.slug] })) continue;
      const { topic, question } = splitTitle(m.title);
      // Brain box symptom-map entries: only their reader-facing text is public, never the Mailbox lookup lines.
      const text = symptoms.isSymptomSlug(m.slug) ? symptoms.publicText(m.text) : String(m.text || '').replace(OWNER_PREFIX, '').replace(/\r/g, '').trim();
      if (!text) continue;
      entries.push({ slug: m.slug, url: '/kb/' + m.slug, title: String(m.title || m.slug).trim(), question, topic, topic_id: topicSlug(topic), text, source: httpsUrl(m.source), updated: m.updated || null, _k: String(m.aliases || '').slice(0, 600) });
    }
    const bs = bodySystems(); const cr = critiques();
    const key = crypto.createHash('sha256').update(JSON.stringify([entries.map((e) => [e.slug, e.title, e.text, e.source, e.updated, e._k]), bs, cr])).digest('hex');
    if (derived && derived.key === key) return { ...derived, at: now().getTime(), base: baseUrl() };
    const rank = (t) => { const i = TOPIC_ORDER.indexOf(t); return i < 0 ? (t === OTHER_TOPIC ? 9999 : 1000) : i; };
    const late = (e) => (/^critique-/.test(e.slug) ? 1 : 0);
    entries.sort((a, b) => (a.slug === CORE_SLUG ? -1 : b.slug === CORE_SLUG ? 1 : 0) || late(a) - late(b) || a.question.localeCompare(b.question));
    const names = [...new Set(entries.map((e) => e.topic))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const topics = names.map((name) => { const list = entries.filter((e) => e.topic === name); return { id: topicSlug(name), name, url: '/kb/topics/' + topicSlug(name), count: list.length, slugs: list.map((e) => e.slug) }; });
    // Entries in reading order: topic by topic; inside a topic, the core position first, then by question.
    const tix = new Map(topics.map((t, i) => [t.name, i]));
    entries.sort((a, b) => tix.get(a.topic) - tix.get(b.topic) || (a.slug === CORE_SLUG ? -1 : b.slug === CORE_SLUG ? 1 : 0) || late(a) - late(b) || a.question.localeCompare(b.question));
    // Related entries: shared words weighted by rarity, a small same-topic bonus.
    const df = new Map(); const bags = new Map();
    for (const e of entries) { const set = new Set(words(e.question + ' ' + e._k + ' ' + e.text.slice(0, 1500))); bags.set(e.slug, set); for (const w of set) df.set(w, (df.get(w) || 0) + 1); }
    const N = entries.length || 1;
    const related = new Map();
    for (const e of entries) {
      const mine = bags.get(e.slug); const scored = [];
      for (const o of entries) {
        if (o.slug === e.slug) continue; let s = 0;
        for (const w of bags.get(o.slug)) if (mine.has(w)) s += Math.log(1 + N / df.get(w));
        if (o.topic === e.topic) s *= 1.15;
        scored.push([s, o.slug]);
      }
      scored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
      related.set(e.slug, scored.slice(0, 5).filter((x) => x[0] > 0).map((x) => x[1]));
    }
    const bySlug = new Map(entries.map((e) => [e.slug, e]));
    const dataVersion = key.slice(0, 16);
    const lastUpdated = entries.reduce((m, e) => (e.updated && e.updated > m ? e.updated : m), '') || null;
    const critKb = entries.filter((e) => CRITIQUE_TOPICS.has(e.topic));
    const critiquesAll = { status: critKb.length || cr.items.length ? 'live' : 'coming_soon', topic: critKb.length ? topics.find((t) => CRITIQUE_TOPICS.has(t.name)) || null : null,
      overview: critKb.filter((e) => !late(e)).map((e) => e.slug), studies: critKb.filter((e) => late(e)).map((e) => e.slug), items: cr.items };
    derived = { key, entries, bySlug, topics, related, core: bySlug.get(CORE_SLUG) || null, bodySystems: bs, critiques: critiquesAll, dataVersion, lastUpdated };
    return { ...derived, at: now().getTime(), base: baseUrl() };
  }
  function snapshot() {
    const t = now().getTime();
    if (cache && t - cache.at >= 0 && t - cache.at < ttlMs) return cache;
    cache = build(); return cache;
  }
  return { snapshot, reset, build };
}

// The only shape an entry has outside this module.
function publicShape(e, base = '') { return { slug: e.slug, url: base + e.url, title: e.title, question: e.question, topic: e.topic, topic_id: e.topic_id, text: e.text, source: e.source || null, updated: e.updated || null }; }

module.exports = { CRITIQUE_TOPICS, createData, publicShape, effectivePublic, isInternal, splitTitle, topicSlug, words, SCHEMA, API_VERSION, TTL_MS, CORE_SLUG, TOPIC_ORDER, BODY_SYSTEM_IDS, BODY_SYSTEM_NAMES, RESERVED, OTHER_TOPIC };
