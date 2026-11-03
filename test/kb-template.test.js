'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { KB } = require('../src/kb'); const T = require('../src/kbtemplate'); const F = require('../src/kbformat');
const kbb = require('../src/kbbundle'); const { Tools } = require('../src/tools');
const TPL = path.join(__dirname, '..', 'kb', 'template');
const D = ['bestdealon.app'];
const card = (o = {}) => ({ id: 'faq/hours', kind: 'faq', title: 'Opening hours', position: '', body: 'Open 9 to 5 weekdays.', sources: ['https://bestdealon.app/hours'], aliases: [], updated: '2026-11-03', ...o });
const copyTpl = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-')); for (const f of fs.readdirSync(TPL)) fs.copyFileSync(path.join(TPL, f), path.join(d, f)); return d; };

test('empty template loads and is valid', () => {
  const r = T.checkTemplate(TPL, { allowDomains: D }); assert.deepStrictEqual(r.errors, []); assert.strictEqual(r.cards.length, 0);
  const kb = new KB({ dirs: [TPL] }); assert.strictEqual(kb.answer('what are your hours').found, false);
});
test('empty template: bot says not found and logs a gap', async () => {
  const gaps = []; const kb = new KB({ dirs: [TPL] });
  const t = { id: 'bestdealon', brand: { team_name: 'Best Deal On', email_from: 'a@bestdealon.app', site: 'bestdealon.app' } };
  const tools = new Tools(t, { kbFor: () => kb, consent: {}, notify: () => {}, log: () => {} });
  tools.gapLog = (ev) => gaps.push(ev);
  const r = await tools.run('kb_answer', { question: 'do you deliver on sundays' }, {});
  assert.strictEqual(r.found, false); assert.strictEqual(gaps.length, 1); assert.strictEqual(gaps[0].reason, 'no_match'); assert.strictEqual(gaps[0].tenant, 'bestdealon');
  assert.ok(!/rfsafe/i.test(JSON.stringify(r)), 'no RF Safe text leaks to a branded tenant');
});
test('card without a source is rejected', () => {
  assert.ok(F.validateGenericCard(card({ sources: [] }), F.allowFor(D)).some((e) => e.startsWith('sources')));
  const d = copyTpl(); fs.writeFileSync(path.join(d, 'faq.jsonl'), JSON.stringify(card({ sources: [] })) + '\n');
  const r = T.checkTemplate(d, { allowDomains: D }); assert.strictEqual(r.ok, false); assert.match(r.errors.join(), /faq.jsonl:1: bad .*sources/);
  assert.throws(() => T.buildBundle(d, { tenant: 'bestdealon', allowDomains: D }), /sources/);
});
test('source off the business domains, bad kind, placeholder card are rejected', () => {
  const a = F.allowFor(D);
  assert.ok(F.validateGenericCard(card({ sources: ['https://rfsafe.org/x'] }), a).length);
  assert.ok(F.validateGenericCard(card({ kind: 'study' }), a).includes('kind'));
  assert.ok(F.validateGenericCard(card({ body: '  ' }), a).length);
  assert.deepStrictEqual(F.validateGenericCard(card(), a), []);
});
test('filled template packs, installs with tenant domains, and answers', () => {
  const d = copyTpl(); fs.writeFileSync(path.join(d, 'faq.jsonl'), JSON.stringify(card()) + '\n');
  const buf = T.buildBundle(d, { tenant: 'bestdealon', allowDomains: D });
  assert.throws(() => F.decode(buf), /domains/); // needs the tenant's domains
  assert.throws(() => F.decode(buf, { allowDomains: D, tenantId: 'rfsafe' }), /tenant/);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kbi-'));
  const r = kbb.installBundle(buf, base, 'bestdealon', { allowDomains: D, teamName: 'Best Deal On' }); assert.strictEqual(r.pages, 1);
  const kb = new KB({ dirs: [kbb.bundleDir ? kbb.bundleDir(base, 'bestdealon') : path.join(base, 'bestdealon-wiki')] });
  assert.strictEqual(kb.answer('opening hours').found, true);
});
test('rfsafe-kb bundles decode exactly as before', () => {
  const c = { id: 'research/x', kind: 'research-finding', title: 'X', position: '', body: 'b', sources: ['https://rfsafe.org/x'], aliases: [], updated: '2026-11-03' };
  const buf = F.encode({ tenant: 'rfsafe', generated: 'g', producer: 'p' }, [c]);
  assert.strictEqual(F.decode(buf).header.format, 'rfsafe-kb'); assert.strictEqual(F.toMarkdown(F.decode(buf).cards[0]), F.toMarkdown(c));
});
