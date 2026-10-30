#!/usr/bin/env node
'use strict';
// Export the Second Brain wiki as an rfsafe-kb v1 bundle (spec: docs/KB_FORMAT.md).
// Usage: node scripts/export-wiki-kb.js <wikiDir> <out.jsonl.gz> [--inbox <dir of v1 .jsonl/.jsonl.gz from Research Bot>]
const fs = require('fs'); const path = require('path'); const fmt = require('../src/kbformat');
const SUBS = ['answers', 'position', 'topics', 'research', 'sources'];
const OFFCAT = /^(politics-and-public-figures|personal-story|history-faith-and-culture|other-off-topic|x-money-creator-concepts)$/;
const SKIP_NAME = /creator|x-money|health-insurance/i;
const URL_RE = /https:\/\/[^\s)\]"'<>`]+/g;
function frontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/); const fm = {};
  if (m) for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0 && !/^\s/.test(line)) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, ''); }
  return { fm, body: m ? text.slice(m[0].length) : text };
}
function keep(rel, text) {
  if (SKIP_NAME.test(rel)) return false;
  const { fm } = frontMatter(text);
  if (rel.startsWith('topics/') && OFFCAT.test(path.basename(rel, '.md'))) return false;
  if (rel.startsWith('sources/') && (fm.post_type === 'reply' || OFFCAT.test(fm.primary_category || ''))) return false;
  return true;
}
const kindOf = (rel, fm) => rel.startsWith('position/') ? 'position' : rel.startsWith('answers/') ? 'answer' : rel.startsWith('topics/') ? 'topic'
  : rel.startsWith('research/harm-graph/') ? 'harm-node' : rel.startsWith('research/rfsafe-org/') && fm.rfsafe_id ? 'study' : rel.startsWith('research/') ? 'research'
  : fm.source_kind === 'x_post' ? 'post' : 'article';
function card(rel, text, mtime) {
  const { fm, body: raw } = frontMatter(text);
  const body = raw.replace(/\n## (Page history|Linked from)[\s\S]*?(?=\n## |$)/g, '\n').trim();
  const kind = kindOf(rel, fm);
  const sources = [];
  const add = (u) => { if (u && fmt.validateCard({ id: 'x1', kind: 'post', title: 't', position: '', body: '', sources: [u], aliases: [], updated: '2000-01-01' }).length === 0 && !sources.includes(u) && sources.length < 6) sources.push(u); };
  add(fm.rfsafe_url); add(fm.x_url); if (fm.doi) add('https://doi.org/' + fm.doi); if (/^\d+$/.test(fm.pmid || '')) add(`https://pubmed.ncbi.nlm.nih.gov/${fm.pmid}/`);
  for (const u of body.match(URL_RE) || []) add(u.replace(/[.,;:]+$/, ''));
  let position = '';
  const sec = body.match(/\n#+ [^\n]*(RF Safe'?s? (position|view|stance)|Position)[^\n]*\n+([^\n#][\s\S]*?)(?=\n\s*\n|$)/i);
  if (sec) position = sec[3].trim();
  else if (kind === 'study' && fm.catalog_effect) position = `RF Safe's study library lists this ${fm.study_type || ''} study as effect: ${fm.catalog_effect}${fm.catalog_evidence ? `, evidence strength: ${fm.catalog_evidence}` : ''}.`.replace(/\s+/g, ' ');
  else if (kind === 'post' || kind === 'article') position = `In John Coates' own words (RF Safe founder${fm.date_utc ? ', ' + fm.date_utc.slice(0, 10) : ''}); see the text below.`;
  const updated = [fm.last_updated, fm.updated, fm.filed, fm.created, (fm.date_utc || '').slice(0, 10)].find((d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '')) || mtime.toISOString().slice(0, 10);
  const title = (fm.title || path.basename(rel, '.md')).slice(0, 300);
  return { id: 'wiki/' + rel.replace(/\.md$/, '').toLowerCase().replace(/[^a-z0-9._/-]/g, '-'), kind, title, position: position.slice(0, 4000), body: body.slice(0, 200000), sources, aliases: [], updated, producer: 'second-brain' };
}
function* cards(wiki) {
  for (const sub of SUBS) {
    const walk = function* (d) { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const q = path.join(d, e.name); if (e.isDirectory()) yield* walk(q); else if (e.name.endsWith('.md')) yield q; } };
    for (const f of walk(path.join(wiki, sub))) { const rel = path.relative(wiki, f).split(path.sep).join('/'); const t = fs.readFileSync(f, 'utf8'); if (keep(rel, t)) yield card(rel, t, fs.statSync(f).mtime); }
  }
}
// Research Bot drops: v1 bundles (.jsonl.gz) or plain v1 JSON lines (.jsonl, header optional).
function inboxCards(dir) {
  const out = []; if (!dir || !fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, f); let lines;
    if (f.endsWith('.jsonl.gz')) { out.push(...fmt.decode(fs.readFileSync(p)).cards); continue; }
    if (!f.endsWith('.jsonl')) continue; lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    for (const l of lines) { const c = JSON.parse(l); if (c.format) continue; const e = fmt.validateCard(c); if (e.length) throw new Error(`${f}: card ${c.id}: bad ${e.join(', ')}`); out.push(c); }
  }
  return out;
}
function build(wiki, inbox) { const all = new Map(); for (const c of cards(wiki)) all.set(c.id, c); for (const c of inboxCards(inbox)) all.set(c.id, c); return [...all.values()]; }
module.exports = { keep, card, cards, inboxCards, build };
if (require.main === module) {
  const a = process.argv.slice(2); const i = a.indexOf('--inbox'); const inbox = i >= 0 ? a.splice(i, 2)[1] : null; const [wiki, out] = a;
  if (!wiki || !out) { console.error('usage: export-wiki-kb.js <wikiDir> <out.jsonl.gz> [--inbox dir]'); process.exit(2); }
  const cs = build(wiki, inbox); for (const c of cs) { const e = fmt.validateCard(c); if (e.length) { console.error(c.id, e); process.exit(1); } }
  fs.writeFileSync(out, fmt.encode({ tenant: 'rfsafe', generated: new Date().toISOString(), producer: 'second-brain' }, cs));
  console.log(`exported ${cs.length} cards -> ${out}`);
}
