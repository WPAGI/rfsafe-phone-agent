#!/usr/bin/env node
'use strict';
// Incremental sync: rebuild the rfsafe-kb v1 bundle from the wiki (+ Research Bot inbox), diff it against the
// last bundle, and write ONE reviewable output file plus a short diff report. Never uploads anything.
// Usage: node scripts/kb-sync.js <wikiDir> <stateDir> [--inbox <dir>]
//   writes <stateDir>/rfsafe-kb.v1.jsonl.gz      (the file the phone bot loads; upload step in docs/KB_FORMAT.md)
//          <stateDir>/history/rfsafe-kb.v1.<stamp>.jsonl.gz (previous bundle, kept for rollback)
//          <stateDir>/diff-<stamp>.md            (added / changed / removed cards, for review)
// Exit 0 with "no changes" (and no new files) when nothing changed.
const fs = require('fs'); const path = require('path'); const fmt = require('../src/kbformat'); const { build } = require('./export-wiki-kb');
function diff(prev, next) {
  const P = new Map(prev.map((c) => [c.id, fmt.hash(c)])); const N = new Map(next.map((c) => [c.id, c]));
  const added = next.filter((c) => !P.has(c.id)); const changed = next.filter((c) => P.has(c.id) && P.get(c.id) !== fmt.hash(c));
  const removed = prev.filter((c) => !N.has(c.id)); return { added, changed, removed };
}
function sync(wiki, state, inbox, now = new Date()) {
  fs.mkdirSync(path.join(state, 'history'), { recursive: true });
  const out = path.join(state, 'rfsafe-kb.v1.jsonl.gz');
  const prev = fs.existsSync(out) ? fmt.decode(fs.readFileSync(out)).cards : [];
  const next = build(wiki, inbox);
  for (const c of next) { const e = fmt.validateCard(c); if (e.length) throw new Error(`${c.id}: bad ${e.join(', ')}`); }
  const d = diff(prev, next); const n = d.added.length + d.changed.length + d.removed.length;
  if (!n && prev.length) return { changed: false, total: next.length, ...counts(d) };
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (fs.existsSync(out)) fs.copyFileSync(out, path.join(state, 'history', `rfsafe-kb.v1.${stamp}.jsonl.gz`));
  fs.writeFileSync(out + '.tmp', fmt.encode({ tenant: 'rfsafe', generated: now.toISOString(), producer: 'second-brain+research-bot', previous_count: prev.length }, next)); fs.renameSync(out + '.tmp', out);
  const li = (a) => a.slice(0, 200).map((c) => `- [${c.kind}] ${c.title.replace(/\n/g, ' ')} (\`${c.id}\`)`).join('\n') + (a.length > 200 ? `\n- ... and ${a.length - 200} more` : '');
  const report = path.join(state, `diff-${stamp}.md`);
  fs.writeFileSync(report, `# RF Safe KB sync ${now.toISOString()}\n\nBundle: ${out} (${next.length} cards, was ${prev.length})\n\n## Added (${d.added.length})\n${li(d.added)}\n\n## Changed (${d.changed.length})\n${li(d.changed)}\n\n## Removed (${d.removed.length})\n${li(d.removed)}\n`);
  return { changed: true, total: next.length, bundle: out, report, ...counts(d) };
}
const counts = (d) => ({ added: d.added.length, changed_cards: d.changed.length, removed: d.removed.length });
module.exports = { sync, diff };
if (require.main === module) {
  const a = process.argv.slice(2); const i = a.indexOf('--inbox'); const inbox = i >= 0 ? a.splice(i, 2)[1] : null; const [wiki, state] = a;
  if (!wiki || !state) { console.error('usage: kb-sync.js <wikiDir> <stateDir> [--inbox dir]'); process.exit(2); }
  const r = sync(wiki, state, inbox); console.log(r.changed ? `updated: +${r.added} ~${r.changed_cards} -${r.removed} (${r.total} cards)\nbundle: ${r.bundle}\nreview: ${r.report}` : `no changes (${r.total} cards)`);
}
