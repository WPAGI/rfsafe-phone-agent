'use strict';
// The files a set of entry modules needs: follows relative require() and require.resolve() calls.
const fs = require('fs');
const path = require('path');
function closure(root, entries) {
  const seen = new Set(); const missing = [];
  const resolve = (from, r) => { const b = path.resolve(path.dirname(from), r); for (const c of [b, b + '.js', b + '.json', path.join(b, 'index.js')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; return null; };
  const walk = (f) => {
    if (seen.has(f)) return; seen.add(f); if (!f.endsWith('.js')) return;
    const src = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n'); // skip comment lines
    for (const m of src.matchAll(/require(?:\.resolve)?\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) { const x = resolve(f, m[1]); if (x) walk(x); else missing.push(path.relative(root, f) + ' -> ' + m[1]); }
  };
  for (const e of entries) { const f = path.join(root, e); if (!fs.existsSync(f)) { missing.push(e); continue; } walk(f); }
  return { files: [...seen].map((f) => path.relative(root, f).split(path.sep).join('/')).sort(), missing };
}
module.exports = { closure };
