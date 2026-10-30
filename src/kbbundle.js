'use strict';
// Install a full-wiki KB bundle (gzipped JSON lines {p, t}) built by scripts/export-wiki-kb.js into
// <dataDir>/kb/<tenant>-wiki. Writes to a temp dir, then swaps it in, so a bad upload never leaves a half KB.
const fs = require('fs'); const path = require('path'); const zlib = require('zlib');
function readRaw(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => { let n = 0; const c = []; req.on('data', (b) => { n += b.length; if (n > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else c.push(b); }); req.on('end', () => resolve(Buffer.concat(c))); req.on('error', reject); });
}
function installBundle(buf, baseDir, tenantId) {
  const lines = zlib.gunzipSync(buf, { maxOutputLength: 400 * 1024 * 1024 }).toString('utf8').split('\n').filter(Boolean);
  const id = String(tenantId).replace(/[^a-z0-9_-]/gi, ''); const final = path.join(baseDir, id + '-wiki'); const tmp = final + '.tmp-' + process.pid;
  fs.rmSync(tmp, { recursive: true, force: true }); let n = 0;
  for (const l of lines) {
    const { p, t } = JSON.parse(l);
    if (typeof p !== 'string' || typeof t !== 'string' || !/^[\w.\-/]+\.md$/.test(p) || p.split('/').includes('..')) throw Object.assign(new Error('bad path in bundle'), { status: 400 });
    const f = path.join(tmp, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); n++;
  }
  if (!n) throw Object.assign(new Error('empty bundle'), { status: 400 });
  const old = final + '.old'; fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(final)) fs.renameSync(final, old);
  fs.renameSync(tmp, final); fs.rmSync(old, { recursive: true, force: true });
  return { pages: n, dir: final };
}
module.exports = { installBundle, readRaw };
