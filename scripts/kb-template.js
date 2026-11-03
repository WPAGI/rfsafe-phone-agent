#!/usr/bin/env node
'use strict';
// node scripts/kb-template.js check <dir> [domain,...]
// node scripts/kb-template.js bundle <dir> <tenant> <out.jsonl.gz> [domain,...]
const fs = require('fs'); const T = require('../src/kbtemplate');
const [cmd, dir, ...rest] = process.argv.slice(2);
const doms = (s) => (s ? s.split(',') : undefined);
if (cmd === 'check') { const r = T.checkTemplate(dir, { allowDomains: doms(rest[0]) }); console.log(r.ok ? `ok: ${r.cards.length} cards` : r.errors.join('\n')); process.exit(r.ok ? 0 : 1); }
if (cmd === 'bundle') { fs.writeFileSync(rest[1], T.buildBundle(dir, { tenant: rest[0], allowDomains: doms(rest[2]) })); console.log('wrote ' + rest[1]); process.exit(0); }
console.error('usage: kb-template.js check <dir> [domains] | bundle <dir> <tenant> <out> [domains]'); process.exit(2);
