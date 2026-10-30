#!/usr/bin/env node
'use strict';
// Export a KB directory for a tenant from the brain wiki. Copies .md pages from the chosen sub-folders,
// keeping front matter; adds `source:` only when the page cites an allowlisted URL.
// Usage: node scripts/export-kb.js <wikiDir> <outDir> [subdirs=answers,topics,position] [allow=rfsafe.org,quantacase.com]
const fs = require('fs'); const path = require('path');
const [wiki, out, subs = 'answers,topics,position', allow = 'rfsafe.org,quantacase.com'] = process.argv.slice(2);
if (!wiki || !out) { console.error('usage: export-kb.js <wikiDir> <outDir> [subdirs] [allowDomains]'); process.exit(2); }
const allowRe = new RegExp('https://(?:[a-z0-9-]+\\.)*(?:' + allow.split(',').map((d) => d.replace(/\./g, '\\.')).join('|') + ')/[^\\s)\\]"\'>]*', 'i');
let n = 0;
for (const sub of subs.split(',')) {
  const dir = path.join(wiki, sub); if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    let text = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = text.match(allowRe);
    if (m && /^---\n/.test(text) && !/^source:/m.test(text.split('\n---')[0])) text = text.replace(/^---\n/, `---\nsource: ${m[0]}\n`);
    fs.mkdirSync(path.join(out, sub), { recursive: true }); fs.writeFileSync(path.join(out, sub, f), text); n++;
  }
}
console.log(`exported ${n} pages to ${out}`);
