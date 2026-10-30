'use strict';
const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { resolveStorage } = require('../src/storage');
const { buildDeps } = require('../src/runtime');

const root = path.join(__dirname, '..');

test('empty tenants dir is seeded once and an unwritable disk falls back in demo', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-store-'));
  const tenants = path.join(tmp, 'tenants');
  const logs = [];
  const seeded = resolveStorage({ mode: 'demo', env: { DATA_DIR: tmp, TENANTS_DIR: tenants }, root, log: (e) => logs.push(e) });
  assert.strictEqual(seeded.seeded, true);
  assert.ok(fs.existsSync(path.join(tenants, 'rfsafe.json')));
  assert.ok(fs.existsSync(path.join(tmp, 'kb', 'rfsafe', 'what-is-sar.md')));
  assert.ok(logs.includes('tenants.seeded'));
  fs.writeFileSync(path.join(tenants, 'rfsafe.json'), '{"kept":true}');
  resolveStorage({ mode: 'demo', env: { DATA_DIR: tmp, TENANTS_DIR: tenants }, root, log: () => {} });
  assert.strictEqual(fs.readFileSync(path.join(tenants, 'rfsafe.json'), 'utf8'), '{"kept":true}');

  const blocker = path.join(tmp, 'not-a-directory');
  fs.writeFileSync(blocker, 'x');
  const fell = resolveStorage({ mode: 'demo', env: { DATA_DIR: blocker }, root, log: () => {} });
  assert.strictEqual(fell.fellBack, true);
  assert.notStrictEqual(fell.dataDir, blocker);
  assert.ok(fs.existsSync(path.join(fell.tenantsDir, 'rfsafe.json')));
  assert.throws(() => resolveStorage({ mode: 'live', env: { DATA_DIR: blocker }, root, log: () => {} }), /missing env: DATA_DIR/);
});

test('live mode names every missing requirement', () => {
  assert.throws(() => buildDeps({ mode: 'live', env: {}, tenantsDir: path.join(root, 'demo/tenants'), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pa-live-')) }), (err) => {
    assert.match(err.message, /missing env/);
    assert.match(err.message, /PUBLIC_BASE_URL/);
    assert.match(err.message, /PA_MASTER_KEY/);
    assert.match(err.message, /XAI_API_KEY/);
    assert.match(err.message, /DATA_DIR/);
    assert.match(err.message, /xai_webhook_secret/);
    return true;
  });
});
