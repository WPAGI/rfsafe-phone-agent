'use strict';
// Install an rfsafe-kb v1 bundle (docs/KB_FORMAT.md) built by scripts/kb-sync.js into
// <dataDir>/kb/<tenant>-wiki. Writes to a temp dir, then swaps it in, so a bad upload never leaves a half KB.
const fs = require('fs'); const path = require('path'); const zlib = require('zlib');
function readRaw(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => { let n = 0; const c = []; req.on('data', (b) => { n += b.length; if (n > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else c.push(b); }); req.on('end', () => resolve(Buffer.concat(c))); req.on('error', reject); });
}
function installBundle(buf, baseDir, tenantId) {
  const { header, cards } = require('./kbformat').decode(buf); // throws 400 on any bad card, before touching the disk
  if (!cards.length) throw Object.assign(new Error('empty bundle'), { status: 400 });
  const { toMarkdown } = require('./kbformat');
  const id = String(tenantId).replace(/[^a-z0-9_-]/gi, ''); const final = path.join(baseDir, id + '-wiki'); const tmp = final + '.tmp-' + process.pid;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const c of cards) { const f = path.join(tmp, c.id + '.md'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, toMarkdown(c)); }
  fs.writeFileSync(path.join(tmp, 'BUNDLE.json'), JSON.stringify({ ...header, installed: new Date().toISOString() }));
  const old = final + '.old'; fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(final)) fs.renameSync(final, old);
  fs.renameSync(tmp, final); fs.rmSync(old, { recursive: true, force: true });
  return { pages: cards.length, version: header.version, generated: header.generated || null, dir: final };
}
module.exports = { installBundle, readRaw };
