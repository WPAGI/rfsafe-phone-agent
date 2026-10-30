#!/usr/bin/env node
'use strict';
// Checks that each question in kb/curated/<tenant>/coverage.json retrieves a passage matching its "expect" regex.
// Usage: node scripts/kb-coverage.js <tenant> [extraKbDir ...]   (exit 1 if any topic is a gap)
const fs = require('fs'); const path = require('path'); const { KB } = require('../src/kb');
function coverage(tenant, extra = []) {
  const cur = path.join(__dirname, '..', 'kb', 'curated', tenant);
  const kb = new KB({ dirs: [...extra, cur].filter((d) => fs.existsSync(d)) });
  const items = JSON.parse(fs.readFileSync(path.join(cur, 'coverage.json'), 'utf8'));
  return items.map(({ q, expect }) => { const hits = kb.search(q, 3); const re = new RegExp(expect, 'i'); return { q, covered: hits.some((h) => re.test(h.text)), top: hits[0] ? hits[0].title : null }; });
}
module.exports = { coverage };
if (require.main === module) {
  const [tenant = 'rfsafe', ...extra] = process.argv.slice(2);
  const r = coverage(tenant, extra); for (const x of r) console.log(x.covered ? 'COVERED' : 'GAP    ', '|', x.q, '|', x.top);
  process.exit(r.every((x) => x.covered) ? 0 : 1);
}
