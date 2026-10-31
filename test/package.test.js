'use strict';
const test = require('node:test'); const assert = require('node:assert'); const path = require('path'); const fs = require('fs');
const { scanTree } = require('../scripts/scan-secrets');
const root = path.join(__dirname, '..');
test('npm test uses the Node 22 file glob', () => {
  assert.strictEqual(require('../package.json').scripts.test, 'node --test ./test/*.test.js');
});
test('go-live docs name the checklist, the script, and the health check', () => {
  const md = fs.readFileSync(path.join(root, 'GO-LIVE.md'), 'utf8');
  for (const needle of ['PA_MODE', 'PA_ADMIN_TOKEN', 'PA_MASTER_KEY', 'XAI_API_KEY', 'RFSAFE_XAI_WEBHOOK_SECRET', 'RFSAFE_TWILIO_AUTH_TOKEN', 'DATA_DIR', 'TENANTS_DIR', 'A2P 10DLC', 'E911', 'scripts/provision-number.js', '/health', '/admin']) assert.ok(md.includes(needle), needle);
  const yaml = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');
  assert.match(yaml, /healthCheckPath: \/health/);
  assert.match(yaml, /mountPath: \/var\/data/);
  assert.match(yaml, /DATA_DIR/);
  assert.match(yaml, /TENANTS_DIR/);
  assert.match(yaml, /value: demo/);
});
test('source tree has no secrets', () => { const r = scanTree(root, { excludeDirs: ['node_modules', 'dist', 'data', '.git'] }); assert.deepStrictEqual(r.problems, []); });
test('every tenant file uses secret references only and demo data is labeled', () => {
  for (const dir of ['demo/tenants', 'deploy']) for (const f of fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.json'))) {
    const t = JSON.parse(fs.readFileSync(path.join(root, dir, f), 'utf8'));
    for (const v of Object.values(t.secrets || {})) assert.match(v, /^(env|store):/);
    if (dir === 'demo/tenants') assert.match(t._note, /EXAMPLE DATA/);
  }
});
test('no tool or route can take payments', () => {
  const src = fs.readdirSync(path.join(root, 'src'), { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(root, 'src', f), 'utf8')).join('\n');
  assert.ok(!/checkoutCreate|cartCreate|paymentIntent|\/charges\b/.test(src));
});
