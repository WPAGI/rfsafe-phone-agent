'use strict';
// RF Safe KB bundle format v1 (spec: docs/KB_FORMAT.md). Gzipped JSON lines: header, then one topic card per line.
const crypto = require('crypto'); const zlib = require('zlib');
const FORMAT = 'rfsafe-kb'; const VERSION = 1;
const KINDS = ['curated', 'position', 'answer', 'topic', 'study', 'harm-node', 'research', 'article', 'post', 'research-finding'];
const ALLOW = /^https:\/\/(?:[a-z0-9-]+\.)*(?:rfsafe\.org|quantacase\.com|doi\.org|pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov|x\.com|ntp\.niehs\.nih\.gov)\//i;
const hash = (c) => crypto.createHash('sha256').update(JSON.stringify([c.title, c.position, c.body, c.sources, c.aliases])).digest('hex').slice(0, 16);
function validateCard(c) {
  const e = [];
  if (!c || typeof c !== 'object') return ['not an object'];
  if (typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9._/-]{1,200}$/.test(c.id) || c.id.includes('..')) e.push('id');
  if (!KINDS.includes(c.kind)) e.push('kind');
  if (typeof c.title !== 'string' || !c.title.trim() || c.title.length > 300) e.push('title');
  if (typeof c.position !== 'string' || c.position.length > 4000) e.push('position');
  if (typeof c.body !== 'string' || c.body.length > 200000) e.push('body');
  if (!Array.isArray(c.sources) || c.sources.some((s) => typeof s !== 'string' || !ALLOW.test(s))) e.push('sources');
  if (c.kind === 'research-finding' && !(c.sources || []).length) e.push('sources (research-finding needs at least one)');
  if (!Array.isArray(c.aliases) || c.aliases.some((s) => typeof s !== 'string')) e.push('aliases');
  if (typeof c.updated !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.updated)) e.push('updated');
  return e;
}
function encode(header, cards) { return zlib.gzipSync([JSON.stringify({ format: FORMAT, version: VERSION, count: cards.length, ...header }), ...cards.map((c) => JSON.stringify(c))].join('\n') + '\n'); }
function decode(buf) {
  const lines = zlib.gunzipSync(buf, { maxOutputLength: 400 * 1024 * 1024 }).toString('utf8').split('\n').filter(Boolean);
  const header = JSON.parse(lines.shift() || '{}');
  if (header.format !== FORMAT || header.version !== VERSION) throw Object.assign(new Error(`not a ${FORMAT} v${VERSION} bundle`), { status: 400 });
  const cards = lines.map((l, i) => { const c = JSON.parse(l); const e = validateCard(c); if (e.length) throw Object.assign(new Error(`card ${i + 1} (${c && c.id}): bad ${e.join(', ')}`), { status: 400 }); return c; });
  const ids = new Set(); for (const c of cards) { if (ids.has(c.id)) throw Object.assign(new Error('duplicate id ' + c.id), { status: 400 }); ids.add(c.id); }
  return { header, cards };
}
// Card -> Markdown page the KB indexes. Position comes first so the bot states RF Safe's view.
function toMarkdown(c) {
  const rf = c.sources.find((s) => /rfsafe\.org|quantacase\.com/i.test(s));
  const fm = ['---', `title: ${JSON.stringify(c.title)}`, rf ? `source: ${rf}` : null, `aliases: ${c.aliases.join(' ')}`, `page_type: ${c.kind === 'curated' ? 'position' : c.kind}`, `updated: ${c.updated}`, '---'].filter(Boolean).join('\n');
  return `${fm}\n${c.position ? `RF Safe's position: ${c.position}\n\n` : ''}${c.body}\n\nSources: ${c.sources.join(' ')}\n`;
}
module.exports = { FORMAT, VERSION, KINDS, validateCard, encode, decode, toMarkdown, hash };
