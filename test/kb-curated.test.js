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
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) assert.match(fs.readFileSync(path.join(dir, f), 'utf8'), /^source: https:\/\/(www\.)?(rfsafe\.org|quantacase\.com)\//m, f);
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
  const fmt = require('../src/kbformat'); const card = (o) => ({ id: 'wiki/position/cellm', kind: 'position', title: 'ceLLM theory', position: 'ceLLM is John Coates\' cellular latent learning model.', body: 'b', sources: ['https://rfsafe.org/x'], aliases: ['sell m'], updated: '2026-10-30', ...o });
  const gz = (cards) => fmt.encode({ tenant: 'rfsafe' }, cards);
  const r = installBundle(gz([card({})]), base, 'rfsafe');
  assert.strictEqual(r.pages, 1);
  const kb = new KB({ dirs: [path.join(base, 'rfsafe-wiki')] }); assert.match(kb.search('what is sell m theory', 1)[0].text, /ceLLM/);
  assert.throws(() => installBundle(gz([card({ id: '../evil' })]), base, 'rfsafe'), /bad id/);
  assert.throws(() => installBundle(gz([card({ sources: ['http://evil.example/'] })]), base, 'rfsafe'), /bad sources/);
  assert.throws(() => installBundle(zlib.gzipSync('{"p":"a.md"}'), base, 'rfsafe'), /not a rfsafe-kb v1/);
  assert.ok(fs.existsSync(path.join(base, 'rfsafe-wiki', 'wiki', 'position', 'cellm.md')), 'old KB kept after a rejected upload');
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
test('full Second Brain export covers the named topics and answers fast enough for voice', { skip: !process.env.KB_BUNDLE && 'set KB_BUNDLE=<rfsafe-kb.v1.jsonl.gz> to run' }, () => {
  const [dir] = require('../scripts/kb-coverage').dirsFor([process.env.KB_BUNDLE]);
  const r = coverage('rfsafe', [dir], 'coverage-wiki.json');
  assert.deepStrictEqual(r.filter((x) => !x.covered).map((x) => x.q), []);
  const kb = new KB({ dirs: [dir, path.join(__dirname, '../kb/curated/rfsafe')] }); const t = Date.now(); for (let i = 0; i < 50; i++) kb.search('What did the NTP study find about tumors in rats', 3);
  assert.ok((Date.now() - t) / 50 < 100, 'search under 100 ms');
});
test('PUT /admin/tenants/rfsafe/kb-bundle needs the admin token, installs, and kb_answer uses it', async () => {
  const { startApp } = require('./helpers'); const a = await startApp();
  try {
    const body = require('../src/kbformat').encode({ tenant: 'rfsafe' }, [{ id: 'wiki/position/cellm', kind: 'position', title: 'ceLLM theory', position: 'zebraword test passage.', body: '', sources: [], aliases: [], updated: '2026-10-30' }]);
    const put = (h) => fetch(a.base + '/admin/tenants/rfsafe-demo/kb-bundle', { method: 'PUT', headers: { 'content-type': 'application/gzip', ...h }, body });
    assert.strictEqual((await put({})).status, 401);
    const r = await put({ authorization: 'Bearer ' + a.deps.adminToken }); assert.strictEqual(r.status, 200); assert.strictEqual((await r.json()).pages, 1);
    const t = a.deps.tenants.get('rfsafe-demo'); assert.match(JSON.stringify(a.deps.kbFor(t).answer('zebraword')), /zebraword/);
  } finally { await a.close(); }
});

test('kb-sync writes one bundle, a diff report, keeps history, and is a no-op when nothing changed', () => {
  const { sync } = require('../scripts/kb-sync'); const fmt = require('../src/kbformat');
  const wiki = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-')); const state = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const w = (rel, t) => { fs.mkdirSync(path.dirname(path.join(wiki, rel)), { recursive: true }); fs.writeFileSync(path.join(wiki, rel), t); };
  w('research/rfsafe-org/rfsafe-1-a.md', '---\ntitle: "Study A"\nrfsafe_id: 1\nrfsafe_url: https://rfsafe.org/mel/paper.php?id=1\ncatalog_effect: "harm"\nstudy_type: "animal"\nfiled: 2026-10-01\n---\nAbstract A.');
  w('sources/p1.md', '---\ntitle: "Li-Fi post"\nsource_kind: x_post\npost_type: original\nprimary_category: lifi-and-technology\ndate_utc: 2026-10-02T00:00:00Z\nx_url: https://x.com/rfsafe/status/1\n---\nLi-Fi now.');
  w('sources/r1.md', '---\ntitle: "reply"\nsource_kind: x_post\npost_type: reply\n---\nskip me');
  const r1 = sync(wiki, state, null, new Date('2026-10-30T10:00:00Z')); assert.strictEqual(r1.added, 2);
  const { cards } = fmt.decode(fs.readFileSync(r1.bundle)); const st = cards.find((c) => c.kind === 'study');
  assert.match(st.position, /effect: harm/); assert.deepStrictEqual(st.sources, ['https://rfsafe.org/mel/paper.php?id=1']);
  assert.strictEqual(sync(wiki, state, null, new Date('2026-10-30T11:00:00Z')).changed, false);
  w('sources/p2.md', '---\ntitle: "CELLM post"\nsource_kind: x_post\npost_type: original\nprimary_category: science-and-mechanisms\n---\nceLLM.');
  const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'in-'));
  fs.writeFileSync(path.join(inbox, 'f.jsonl'), JSON.stringify({ id: 'research/lifi-1', kind: 'research-finding', title: 'Li-Fi standard', position: 'p', body: 'b', sources: ['https://rfsafe.org/class/start/'], aliases: ['lifi'], updated: '2026-10-30' }) + '\n');
  const r3 = sync(wiki, state, inbox, new Date('2026-10-30T12:00:00Z')); assert.strictEqual(r3.added, 2);
  assert.match(fs.readFileSync(r3.report, 'utf8'), /Added \(2\)[\s\S]*CELLM post/); assert.strictEqual(fs.readdirSync(path.join(state, 'history')).length, 1);
  fs.writeFileSync(path.join(inbox, 'bad.jsonl'), JSON.stringify({ id: 'research/x', kind: 'research-finding', title: 'x', position: '', body: '', sources: [], aliases: [], updated: '2026-10-30' }) + '\n');
  assert.throws(() => sync(wiki, state, inbox), /needs at least one/);
});
