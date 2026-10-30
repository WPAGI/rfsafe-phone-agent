#!/usr/bin/env node
'use strict';
// Build a full-wiki KB bundle for the phone bot (gzipped JSON lines: {"p": relative path, "t": markdown}).
// Includes answers/, position/, topics/, research/ (incl. the 1,465 rfsafe.org study pages) and on-topic
// X/article sources. Skips replies, off-topic categories and anything outside RF Safe (e.g. creator/x-money).
// Adds `source:` (first allowlisted rfsafe.org / quantacase.com link) so the bot can text/email it.
// Usage: node scripts/export-wiki-kb.js <wikiDir> <out.jsonl.gz> [--dir <outDir>]
const fs = require('fs'); const path = require('path'); const zlib = require('zlib');
const SUBS = ['answers', 'position', 'topics', 'research', 'sources'];
const OFF = /^primary_category:\s*(politics-and-public-figures|personal-story|history-faith-and-culture|other-off-topic|x-money-creator-concepts)\s*$/m;
const SKIP_NAME = /creator|x-money|health-insurance/i;
const allowRe = /https:\/\/(?:[a-z0-9-]+\.)*(?:rfsafe\.org|quantacase\.com)\/[^\s)\]"'>]*/i;
function keep(rel, text) {
  if (SKIP_NAME.test(rel)) return false;
  const fm = (text.match(/^---\n([\s\S]*?)\n---/) || [, ''])[1];
  if (rel.startsWith('topics/') && /other-off-topic|personal-story|politics|history-faith|x-money|uncategorized/.test(rel)) return false;
  if (rel.startsWith('sources/')) { if (/^post_type:\s*reply\s*$/m.test(fm) || OFF.test(fm)) return false; }
  return true;
}
function* pages(wiki) {
  for (const sub of SUBS) {
    const walk = function* (d) { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const q = path.join(d, e.name); if (e.isDirectory()) yield* walk(q); else if (e.name.endsWith('.md')) yield q; } };
    for (const f of walk(path.join(wiki, sub))) {
      const rel = path.relative(wiki, f).split(path.sep).join('/'); let t = fs.readFileSync(f, 'utf8');
      if (!keep(rel, t)) continue;
      t = t.replace(/\n## (Page history|Linked from)[\s\S]*?(?=\n## |$)/g, '\n'); // drop wiki boilerplate
      const m = t.match(allowRe);
      if (m && /^---\n/.test(t) && !/^source:/m.test(t.split('\n---')[0])) t = t.replace(/^---\n/, `---\nsource: ${m[0]}\n`);
      yield { p: rel, t };
    }
  }
}
module.exports = { pages, keep };
if (require.main === module) {
  const [wiki, out, flag, dir] = process.argv.slice(2);
  if (!wiki || !out) { console.error('usage: export-wiki-kb.js <wikiDir> <out.jsonl.gz> [--dir outDir]'); process.exit(2); }
  const lines = []; let n = 0;
  for (const pg of pages(wiki)) { lines.push(JSON.stringify(pg)); n++; if (flag === '--dir' && dir) { const f = path.join(dir, pg.p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, pg.t); } }
  fs.writeFileSync(out, zlib.gzipSync(lines.join('\n'))); console.log(`bundled ${n} pages -> ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB gz)`);
}
