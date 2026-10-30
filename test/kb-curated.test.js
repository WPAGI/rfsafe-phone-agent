'use strict';
const test = require('node:test'); const assert = require('node:assert'); const path = require('path'); const fs = require('fs'); const os = require('os');
const { KB, tok } = require('../src/kb'); const { Tools } = require('../src/tools'); const { coverage } = require('../scripts/kb-coverage');
test('spoken spellings of Li-Fi normalize to one token', () => {
  for (const s of ['Li-Fi', 'LiFi', 'li fi', 'lie fi', 'light fidelity']) assert.deepStrictEqual(tok(s), ['lifi'], s);
  assert.deepStrictEqual(tok('amplifies'), ['amplifies']);
});
test('every topic the X Article suggests is covered (live KB + curated cards)', () => {
  const r = coverage('rfsafe', [path.join(__dirname, '../demo/kb/rfsafe-live')]);
  assert.deepStrictEqual(r.filter((x) => !x.covered).map((x) => x.q), []);
});
test('without the curated card, Li-Fi is a gap (regression guard)', () => {
  const kb = new KB({ dirs: [path.join(__dirname, '../demo/kb/rfsafe-live')] });
  assert.ok(!kb.search('What is Li-Fi', 3).some((h) => /Li-Fi/.test(h.text)));
});
test('curated cards carry an allowlisted source link', () => {
  const dir = path.join(__dirname, '../kb/curated/rfsafe');
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) assert.match(fs.readFileSync(path.join(dir, f), 'utf8'), /^source: https:\/\/(rfsafe\.org|quantacase\.com)\//m, f);
});
test('unanswered questions go to the gap log', async () => {
  const gap = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gap-')), 'g.jsonl');
  const t = { id: 'rfsafe', link_allowlist: ['rfsafe.org'], numbers: [] };
  const tools = new Tools(t, { kbFor: () => new KB({ dirs: [] }), kbGapFile: gap });
  assert.ok(tools.definitions().some((d) => d.name === 'note_unanswered'));
  const a = await tools.run('kb_answer', { question: 'zzqx topic' }, { channel: 'voice' }); assert.strictEqual(a.found, false);
  const b = await tools.run('note_unanswered', { question: 'Li-Fi in hospitals' }, { channel: 'voice' }); assert.ok(b.ok);
  const rows = fs.readFileSync(gap, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(rows.map((r) => r.reason), ['no_match', 'model_unanswered']);
});
