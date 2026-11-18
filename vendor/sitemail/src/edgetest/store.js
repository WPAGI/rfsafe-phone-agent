'use strict';
// Edge testing storage: one JSON file in the site's data directory, written the same way as the Mailbox store
// (whole-file write to a temp file, then rename; mode 0600). Holds saved tests, runs, per-run results, agent
// grades and human reviews. It is a separate file: nothing here reads or writes the Mailbox's own data.
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
// A site is its bare hostname (e.g. rfsafe.app); the host passes its own.
const SITE_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const clone = (x) => JSON.parse(JSON.stringify(x));
const hash = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);

class EdgeStore {
  constructor({ file, now = () => Date.now() }) {
    this.file = file; this.now = now;
    let db = null; try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { db = null; }
    this.db = db && db.v === 1 ? db : { v: 1, tests: {}, runs: {}, results: {}, grades: {}, reviews: {}, spend: {} };
    for (const k of ['tests', 'runs', 'results', 'grades', 'reviews', 'spend']) this.db[k] ||= {};
  }
  iso() { return new Date(this.now()).toISOString(); }
  save() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); const tmp = this.file + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.db), { mode: 0o600 }); fs.renameSync(tmp, this.file); }
  // ---- tests ----
  tests(site) { return Object.values(this.db.tests).filter(t => !t.archived && (!site || t.site === site)).sort((a, b) => String(a.subject).localeCompare(String(b.subject)) || a.id.localeCompare(b.id)); }
  test(id) { return this.db.tests[id] || null; }
  // Idempotent: same content = unchanged; changed content keeps the id and created time.
  upsertTest(t) {
    if (!ID_RE.test(String(t.id || ''))) throw Object.assign(new Error('bad_test_id'), { status: 400 });
    const body = { id: t.id, site: t.site, subject: t.subject, question: t.question, from: t.from || null, intent: t.intent || '', expected: t.expected || '', source: t.source || 'manual', redactions: t.redactions || {} };
    const h = hash(body); const cur = this.db.tests[t.id];
    if (cur && cur.hash === h && !cur.archived) return 'unchanged';
    this.db.tests[t.id] = { ...body, hash: h, created: cur ? cur.created : this.iso(), updated: this.iso(), archived: false };
    return cur ? 'updated' : 'added';
  }
  archiveTest(id) { const t = this.db.tests[id]; if (!t) return false; t.archived = true; t.updated = this.iso(); return true; }
  // ---- runs ----
  runs(site) { return Object.values(this.db.runs).filter(r => !site || r.site === site).sort((a, b) => cmpRun(a, b)); }
  run(id) { return this.db.runs[id] || null; }
  runKey(site, pv, n) { return site + '|' + pv + '|' + n; }
  nextRunNumber(site, pv) { return 1 + this.runs(site).filter(r => r.product_version === pv).reduce((m, r) => Math.max(m, r.run_number || 0), 0); }
  putRun(r) { this.db.runs[r.id] = { ...(this.db.runs[r.id] || {}), ...r }; return this.db.runs[r.id]; }
  running(site) { return this.runs(site).find(r => r.status === 'running') || null; }
  baseline(site) { return this.runs(site).find(r => r.is_baseline) || this.runs(site)[0] || null; }
  // ---- results ----
  setResult(runId, testId, res) { const m = this.db.results[runId] ||= {}; const h = hash(res); if (m[testId] && m[testId].hash === h) return 'unchanged'; const had = !!m[testId]; m[testId] = { ...res, hash: h }; return had ? 'updated' : 'added'; }
  result(runId, testId) { return (this.db.results[runId] || {})[testId] || null; }
  // Newest run first, only runs that have a result for this test.
  history(testId) { const t = this.test(testId); return this.runs(t && t.site).slice().reverse().map(run => ({ run, result: this.result(run.id, testId) })).filter(x => x.result); }
  // ---- grades (agent) and reviews (human) ----
  gradeKey(testId, baseRun, newRun) { return testId + '|' + baseRun + '|' + newRun; }
  grade(testId, baseRun, newRun) { return this.db.grades[this.gradeKey(testId, baseRun, newRun)] || null; }
  setGrade(testId, baseRun, newRun, g) { this.db.grades[this.gradeKey(testId, baseRun, newRun)] = { ...g, at: this.iso() }; }
  review(testId, runId) { return this.db.reviews[testId + '|' + runId] || null; }
  setReview(testId, runId, { verdict, note, who }) {
    if (!['pass', 'fail'].includes(verdict)) throw Object.assign(new Error('verdict_must_be_pass_or_fail'), { status: 400 });
    this.db.reviews[testId + '|' + runId] = { verdict, note: String(note || '').slice(0, 1000), who: String(who || 'owner').slice(0, 80), at: this.iso() };
    return this.db.reviews[testId + '|' + runId];
  }
  // ---- spend (separate small daily cap for edge runs, by New York day) ----
  day() { return nyDay(this.now()); }
  spentToday() { return Number(this.db.spend[this.day()] || 0); }
  addSpend(usd) { const d = this.day(); this.db.spend[d] = Math.round((Number(this.db.spend[d] || 0) + Math.max(0, Number(usd) || 0)) * 1e6) / 1e6; for (const k of Object.keys(this.db.spend).sort().slice(0, -60)) delete this.db.spend[k]; }
}
function nyDay(ms) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
function semverCmp(a, b) { const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; } return 0; }
function cmpRun(a, b) { return semverCmp(a.product_version, b.product_version) || (a.run_number || 0) - (b.run_number || 0) || String(a.started_at || '').localeCompare(String(b.started_at || '')); }
// "1.0.0 run 3, prompts 1.9.27". With a result, its own recorded prompt version is used (imported runs can mix).
const runLabel = (r, res) => r ? `${r.product_version} run ${r.run_number}, prompts ${(res && res.prompt_version) || r.prompt_version || 'unknown'}` : '';
module.exports = { EdgeStore, SITE_RE, ID_RE, runLabel, nyDay, semverCmp, hash, clone };
