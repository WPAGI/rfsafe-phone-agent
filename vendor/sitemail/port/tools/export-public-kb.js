#!/usr/bin/env node
'use strict';
// Export a site's PUBLIC knowledge base (its /kb/api/v1/kb.json feed) into a read-only seed file for another site.
// Read-only on the source: one GET of a public URL. Only public fields are kept (the feed is already public).
//   node port/tools/export-public-kb.js https://rfsafe.app/kb/api/v1/kb.json seed/public-kb/rfsafe-app-public-kb.json
// Then point the new site's config at it: public_kb.seed = 'seed/public-kb/rfsafe-app-public-kb.json'.
const fs = require('fs');
const crypto = require('crypto');

function shape(doc, from) {
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
  const entries = (Array.isArray(doc.entries) ? doc.entries : []).filter((e) => e && typeof e.slug === 'string' && typeof e.text === 'string')
    .map((e) => ({ slug: e.slug, title: str(e.title, 300), question: str(e.question, 300), topic: str(e.topic, 80), text: e.text, source: str(e.source, 500), updated: str(e.updated, 40) }));
  const body_systems = (Array.isArray(doc.body_systems) ? doc.body_systems : []).filter((b) => b && typeof b.id === 'string')
    .map((b) => ({ id: b.id, name: str(b.name, 80), research_label: str(b.research_label, 120), research_url: str(b.research_url, 300), summary: str(b.summary, 4000), summary_updated: str(b.summary_updated, 40) }));
  const c = doc.safety_claim_critiques || {};
  const safety_claim_critiques = { items: (Array.isArray(c.items) ? c.items : []).filter((x) => x && typeof x.claim === 'string' && typeof x.critique === 'string') };
  const body = { entries, body_systems, safety_claim_critiques };
  const sha256 = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return { schema: 'sitemail-public-kb-seed/1', exported_from: from, source_data_version: doc.data_version || null, source_last_updated: doc.last_updated || null,
    exported_at: new Date().toISOString(), counts: { entries: entries.length, topics: new Set(entries.map((e) => e.topic)).size, body_systems: body_systems.length, critique_items: safety_claim_critiques.items.length }, sha256, core_slug: doc.core_slug || null, ...body };
}

async function main() {
  const [url, out] = process.argv.slice(2);
  if (!/^https:\/\//.test(url || '') || !out) { console.error('usage: export-public-kb.js <https://site/kb/api/v1/kb.json> <seed/public-kb/name.json>'); process.exit(2); }
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) { console.error('GET ' + url + ' -> ' + r.status); process.exit(1); }
  const seed = shape(await r.json(), url);
  if (!seed.entries.length) { console.error('no public entries in ' + url + '; nothing written'); process.exit(1); }
  fs.writeFileSync(out, JSON.stringify(seed, null, 1) + '\n');
  console.log(JSON.stringify({ out, counts: seed.counts, sha256: seed.sha256.slice(0, 16) }));
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { shape };
