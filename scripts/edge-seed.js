#!/usr/bin/env node
'use strict';
// Build the shipped Edge testing seed for one site from an edge-test library folder (e.g. /workspace/edge_tests).
// Reads only; never writes into the library. Output records are already PII-redacted (src/edgetest/pii.js) and in the
// importer's format. The output is re-scanned and the script exits 1 if anything that looks like PII is left.
//   node scripts/edge-seed.js <libraryDir> <site> <outFile>
//   node scripts/edge-seed.js --scan <file-or-dir>     (findings are masked; full values are never printed)
const fs = require('fs'); const path = require('path');
const I = require('../vendor/sitemail/src/edgetest/importer'); const PII = require('../vendor/sitemail/src/edgetest/pii');
function walkStrings(o, at, out) { if (typeof o === 'string') out.push([at, o]); else if (Array.isArray(o)) o.forEach((v, i) => walkStrings(v, at + '[' + i + ']', out)); else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walkStrings(v, at ? at + '.' + k : k, out); return out; }
function scanRecords(records) { const hits = []; for (const r of records) for (const [at, s] of walkStrings(r, '', [])) for (const f of PII.scan(s)) hits.push({ id: r.id, field: at, kind: f.kind, preview: f.preview }); return hits; }
function toSeed(n) {
  return { id: n.id, site: n.site, from: n.test.from, subject: n.test.subject, question: n.test.question, intent: n.test.intent, expected: n.test.expected,
    runs: n.runs.map(r => ({ product_version: r.product_version, run_number: r.run_number, is_baseline: r.is_baseline, prompt_version: r.prompt_version, prompt_version_note: r.prompt_version_note,
      disposition: r.result.disposition, reason: r.result.hold_reason, reply_text: r.result.reply, checker_verdict: r.result.checker_verdict, checker_notes: r.result.checker_notes, pass_fail: r.result.pass_fail, pass_fail_notes: r.result.pass_fail_notes, date_utc: r.result.at })) };
}
if (require.main === module) {
  const a = process.argv.slice(2);
  if (a[0] === '--scan') {
    const p = a[1]; const recs = fs.statSync(p).isDirectory() ? I.loadDir(p).records : [].concat(JSON.parse(fs.readFileSync(p, 'utf8')));
    const hits = scanRecords(recs); const by = {}; for (const h of hits) by[h.kind] = (by[h.kind] || 0) + 1;
    console.log(JSON.stringify({ records: recs.length, findings: hits.length, by_kind: by, items: hits.slice(0, 50) }, null, 2)); process.exit(hits.length ? 1 : 0);
  }
  const [dir, site, out] = a; if (!dir || !site || !out) { console.error('usage: edge-seed.js <libraryDir> <site> <outFile>'); process.exit(2); }
  const { records, errors } = I.loadDir(dir); const seed = []; const refused = []; const red = {};
  for (const raw of records) { const n = I.normalize(raw); if (!n.ok) { refused.push({ id: n.id, reasons: n.reasons }); continue; } if (n.site !== site) continue; for (const [k, v] of Object.entries(n.redactions)) red[k] = (red[k] || 0) + v; seed.push(toSeed(n)); }
  seed.sort((x, y) => x.id.localeCompare(y.id));
  const left = scanRecords(seed);
  if (left.length) { console.error(JSON.stringify({ error: 'pii_left_after_redaction', items: left.slice(0, 50) }, null, 2)); process.exit(1); }
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(seed, null, 1) + '\n');
  console.log(JSON.stringify({ site, written: seed.length, refused, file_errors: errors, redacted: red, pii_left: 0 }));
}
module.exports = { scanRecords, toSeed };
