#!/usr/bin/env node
'use strict';
// Checks that each question in kb/curated/<tenant>/coverage.json retrieves a passage matching its "expect" regex.
// Usage: node scripts/kb-coverage.js <tenant> [--wiki] [extraKbDir ...]  (--wiki: full Second Brain questions, pass the export dir)   (exit 1 if any topic is a gap)
const fs = require('fs'); const path = require('path'); const { KB } = require('../src/kb');
function coverage(tenant, extra = [], file = 'coverage.json') {
  const cur = path.join(__dirname, '..', 'kb', 'curated', tenant);
  const kb = new KB({ dirs: [...extra, cur].filter((d) => fs.existsSync(d)) });
  const items = JSON.parse(fs.readFileSync(path.join(cur, file), 'utf8'));
  return items.map(({ q, expect }) => { const hits = kb.search(q, 3); const re = new RegExp(expect, 'i'); return { q, covered: hits.some((h) => re.test(h.text)), top: hits[0] ? hits[0].title : null }; });
}
module.exports = { coverage };
if (require.main === module) {
  const args = process.argv.slice(2); const wiki = args.includes('--wiki'); const [tenant = 'rfsafe', ...extra] = args.filter((a) => a !== '--wiki');
  const r = coverage(tenant, extra, wiki ? 'coverage-wiki.json' : 'coverage.json'); for (const x of r) console.log(x.covered ? 'COVERED' : 'GAP    ', '|', x.q, '|', x.top);
  process.exit(r.every((x) => x.covered) ? 0 : 1);
}
