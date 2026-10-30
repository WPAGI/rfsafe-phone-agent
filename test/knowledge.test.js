'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { KB } = require('../src/kb');
const { SarCatalog } = require('../src/sar');
const { mockSarFetch } = require('../src/mocks');
const { Tools } = require('../src/tools');

const allow = ['quantacase.com', 'rfsafe.org', 'rfsafe.com', 'rfsafe.net'];
test('the RF Safe live KB answers closed comment periods and FCC limits', () => {
  const kb = new KB({ dirs: [path.join(__dirname, '../demo/kb/rfsafe-live')], allowlist: allow });
  const a = kb.answer('can I still comment to the FCC or HHS');
  assert.ok(a.found); assert.match(a.passages.map((p) => p.text).join(' '), /closed/);
  assert.ok(kb.answer('are FCC limits safe').found);
  assert.ok(kb.answer('what is QuantaCase').found);
});
test('sar_lookup finds a phone and returns only allowlisted links', async () => {
  const c = new SarCatalog({ fetchImpl: mockSarFetch() });
  const r = await c.lookup('iphone 17 pro max SAR');
  assert.ok(r.found); assert.strictEqual(r.sar.head_cellular, 1.11); assert.match(r.sar_page, /SAR\.php\?phone=apple-iphone-17-pro-max$/);
  assert.strictEqual((await c.lookup('nokia 3310')).found, false);
  const t = { id: 'x', link_allowlist: allow, sar_lookup: true, numbers: [] };
  const tools = new Tools(t, { sarFor: () => c, kbFor: () => null });
  assert.ok(tools.definitions().some((d) => d.name === 'sar_lookup'));
  const out = await tools.run('sar_lookup', { phone: 'iPhone 17 Pro Max' }, { channel: 'voice' });
  assert.ok(out.ok && out.found);
});
