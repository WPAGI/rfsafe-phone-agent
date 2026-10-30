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
const zlib = require('zlib'); const { installBundle } = require('../src/kbbundle'); const { keep } = require('../scripts/export-wiki-kb');
test('kb bundle installs atomically, rejects path tricks, and is searchable', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kbb-'));
  const gz = (rows) => zlib.gzipSync(rows.map((r) => JSON.stringify(r)).join('\n'));
  const r = installBundle(gz([{ p: 'position/cellm.md', t: '---\ntitle: ceLLM theory\n---\nceLLM is John Coates\' cellular latent learning model.' }]), base, 'rfsafe');
  assert.strictEqual(r.pages, 1);
  const kb = new KB({ dirs: [path.join(base, 'rfsafe-wiki')] }); assert.match(kb.search('what is sell m theory', 1)[0].text, /ceLLM/);
  assert.throws(() => installBundle(gz([{ p: '../evil.md', t: 'x' }]), base, 'rfsafe'), /bad path/);
  assert.ok(fs.existsSync(path.join(base, 'rfsafe-wiki', 'position', 'cellm.md')), 'old KB kept after a rejected upload');
});
test('export keeps RF Safe topics and drops replies, off-topic and creator pages', () => {
  assert.ok(keep('research/rfsafe-org/rfsafe-1-x.md', '---\ntitle: x\n---\n'));
  assert.ok(!keep('sources/a.md', '---\npost_type: reply\n---\n'));
  assert.ok(!keep('sources/b.md', '---\nprimary_category: politics-and-public-figures\n---\n'));
  assert.ok(!keep('answers/creator-health-insurance.md', '---\n---\n'));
});
test('search returns at most 2 passages per page (graph-node copies collapse)', () => {
  const kb = new KB({ dirs: [] });
  kb.addDoc({ title: 'Cataract study', body: 'cataract microwave' }); kb.addDoc({ title: 'Graph node — Cataract study', body: 'cataract microwave' }); kb.addDoc({ title: 'Cataract study', body: 'cataract microwave lens' }); kb.addDoc({ title: 'Other', body: 'cataract' });
  const t = kb.search('cataract', 3).map((h) => h.title); assert.ok(t.includes('Other')); assert.ok(t.filter((x) => /Cataract study/.test(x)).length <= 2);
});
test('full Second Brain export covers the named topics and answers fast enough for voice', { skip: !process.env.KB_WIKI_DIR && 'set KB_WIKI_DIR=<export dir> to run' }, () => {
  const r = coverage('rfsafe', [process.env.KB_WIKI_DIR], 'coverage-wiki.json');
  assert.deepStrictEqual(r.filter((x) => !x.covered).map((x) => x.q), []);
  const kb = new KB({ dirs: [process.env.KB_WIKI_DIR] }); const t = Date.now(); for (let i = 0; i < 50; i++) kb.search('What did the NTP study find about tumors in rats', 3);
  assert.ok((Date.now() - t) / 50 < 100, 'search under 100 ms');
});
test('PUT /admin/tenants/rfsafe/kb-bundle needs the admin token, installs, and kb_answer uses it', async () => {
  const { startApp } = require('./helpers'); const a = await startApp();
  try {
    const body = zlib.gzipSync(JSON.stringify({ p: 'position/cellm.md', t: '---\ntitle: ceLLM theory\n---\nceLLM zebraword test passage.' }));
    const put = (h) => fetch(a.base + '/admin/tenants/rfsafe-demo/kb-bundle', { method: 'PUT', headers: { 'content-type': 'application/gzip', ...h }, body });
    assert.strictEqual((await put({})).status, 401);
    const r = await put({ authorization: 'Bearer ' + a.deps.adminToken }); assert.strictEqual(r.status, 200); assert.strictEqual((await r.json()).pages, 1);
    const t = a.deps.tenants.get('rfsafe-demo'); assert.match(JSON.stringify(a.deps.kbFor(t).answer('zebraword')), /zebraword/);
  } finally { await a.close(); }
});
