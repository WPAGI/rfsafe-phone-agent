'use strict';
const test = require('node:test'); const assert = require('node:assert'); const path = require('path'); const fs = require('fs');
const { scanTree } = require('../scripts/scan-secrets');
const root = path.join(__dirname, '..');
test('source tree has no secrets', () => { const r = scanTree(root, { excludeDirs: ['node_modules', 'dist', 'data', '.git'] }); assert.deepStrictEqual(r.problems, []); });
test('every tenant file uses secret references only and demo data is labeled', () => {
  for (const dir of ['demo/tenants', 'deploy']) for (const f of fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.json'))) {
    const t = JSON.parse(fs.readFileSync(path.join(root, dir, f), 'utf8'));
    for (const v of Object.values(t.secrets || {})) assert.match(v, /^(env|store):/);
    if (dir === 'demo/tenants') assert.match(t._note, /EXAMPLE DATA/);
  }
});
test('no tool or route can take payments', () => {
  const src = fs.readdirSync(path.join(root, 'src')).map((f) => fs.readFileSync(path.join(root, 'src', f), 'utf8')).join('\n');
  assert.ok(!/checkoutCreate|cartCreate|paymentIntent|\/charges\b/.test(src));
});
