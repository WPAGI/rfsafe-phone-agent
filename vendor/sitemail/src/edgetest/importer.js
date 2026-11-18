'use strict';
// Edge testing importer: validates saved edge-test records (Jarvis's /workspace/edge_tests library format, or a
// simple { site, subject, question, expected } record), redacts customer PII, and loads them into the EdgeStore.
// Idempotent: importing the same records again changes nothing. A missing prompt version is stored as "unknown";
// it is never guessed. A record whose sender is not a test address is refused (real customer mail is never a test).
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const PII = require('./pii'); const { SITE_RE, ID_RE, semverCmp } = require('./store');
const siteOf = (v) => { const s = String(v || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''); return SITE_RE.test(s) ? s : null; };
const SEMVER = /^\d+\.\d+\.\d+$/;
const LIM = { subject: 400, question: 12000, expected: 4000, intent: 1000, reply: 20000, notes: 4000 };
const str = (v, n) => String(v == null ? '' : v).slice(0, n);

function clean(v, n, counts) { const r = PII.redact(str(v, n)); for (const [k, c] of Object.entries(r.counts)) counts[k] = (counts[k] || 0) + c; return r.text; }

function normalize(raw) {
  const reasons = []; const counts = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, id: null, reasons: ['not_an_object'] };
  const site = siteOf(raw.site);
  if (!site) reasons.push('unknown_site');
  const question = raw.body != null ? raw.body : (raw.question != null ? raw.question : raw.text);
  if (!String(question || '').trim()) reasons.push('missing_question');
  if (String(question || '').length > LIM.question) reasons.push('question_too_long');
  const from = raw.from ? String(raw.from).trim() : '';
  if (from && !PII.isSafeEmail(from)) reasons.push('sender_is_not_a_test_address');
  const id = raw.id != null ? String(raw.id) : 'edge.' + crypto.createHash('sha256').update((site || '') + '|' + (raw.subject || '') + '|' + (question || '')).digest('hex').slice(0, 16);
  if (!ID_RE.test(id)) reasons.push('bad_id');
  if (reasons.length) return { ok: false, id: ID_RE.test(id) ? id : null, reasons };
  const test = {
    id, site, from: from || null,
    subject: clean(raw.subject || '(no subject)', LIM.subject, counts),
    question: clean(question, LIM.question, counts),
    intent: clean(raw.intent || raw.intent_slug || '', LIM.intent, counts),
    expected: clean(raw.expected_behavior != null ? raw.expected_behavior : raw.expected, LIM.expected, counts),
    source: 'import',
  };
  // Runs: the record's runs[], else its last_known_result / baseline as one run.
  let list = Array.isArray(raw.runs) && raw.runs.length ? raw.runs : [];
  if (!list.length && (raw.last_known_result || raw.baseline)) list = [{ ...(raw.last_known_result || raw.baseline), product_version: raw.product_version, run_number: raw.run_number, is_baseline: raw.is_baseline, prompt_version: raw.prompt_version, pass_fail: raw.pass_fail, pass_fail_notes: raw.pass_fail_notes }];
  const runs = []; const runErrors = [];
  for (const r of list) {
    const pv = String(r.product_version || raw.product_version || '');
    const n = Number(r.run_number != null ? r.run_number : raw.run_number);
    if (!SEMVER.test(pv) || !Number.isInteger(n) || n < 1) { runErrors.push('run_missing_product_version_or_run_number'); continue; }
    const pvRaw = r.prompt_version != null && String(r.prompt_version).trim() ? String(r.prompt_version).trim() : (raw.prompt_version != null && String(raw.prompt_version).trim() ? String(raw.prompt_version).trim() : '');
    const reply = r.reply_text != null ? r.reply_text : (r.reply != null ? r.reply : '');
    const disp = String(r.disposition || (reply ? 'sent' : 'held')).toLowerCase();
    runs.push({ product_version: pv, run_number: n, is_baseline: !!(r.is_baseline != null ? r.is_baseline : raw.is_baseline),
      prompt_version: /^[\w.-]{1,40}$/.test(pvRaw) ? pvRaw : 'unknown', prompt_version_note: str(r.prompt_version_note || raw.prompt_version_note || '', 400),
      result: { source: 'import', reply: clean(reply, LIM.reply, counts), disposition: ['sent', 'held', 'would_send', 'no_reply', 'spam', 'archive', 'error'].includes(disp) ? disp : 'held',
        hold_reason: disp === 'held' ? clean(r.reason || r.hold_reason || '', LIM.notes, counts) : '', checker_verdict: ['pass', 'fail', 'unsure'].includes(String(r.checker_verdict)) ? r.checker_verdict : null,
        checker_notes: clean(r.checker_notes || '', LIM.notes, counts), pass_fail: ['pass', 'fail', 'mixed'].includes(String(r.pass_fail)) ? r.pass_fail : null,
        pass_fail_notes: clean(r.pass_fail_notes || '', LIM.notes, counts), at: /^\d{4}-\d\d-\d\dT/.test(String(r.date_utc || raw.date_utc || '')) ? String(r.date_utc || raw.date_utc) : null,
        prompt_version: /^[\w.-]{1,40}$/.test(pvRaw) ? pvRaw : 'unknown' } });
  }
  test.redactions = counts;
  return { ok: true, id, site, test, runs, runErrors, redactions: counts };
}

// Loads every record file under dir: <dir>/<site>/*.json and <dir>/*.json (index.json is the manifest, not a record).
function loadDir(dir) {
  const files = []; const walk = (d, depth) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory() && depth < 1) walk(p, depth + 1); else if (e.isFile() && /\.json$/i.test(e.name) && !(depth === 0 && e.name === 'index.json')) files.push(p); } };
  walk(dir, 0); files.sort();
  const records = []; const errors = [];
  for (const f of files) { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); for (const r of [].concat(j)) records.push(r); } catch (e) { errors.push({ file: path.relative(dir, f), error: 'invalid_json' }); } }
  let index = null; try { index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch { index = null; }
  return { records, errors, index };
}

function runId(site, pv, n) { return 'run.' + site + '.' + pv + '.' + n; }
// Import into one site's store. Records for the other site are counted and skipped.
function importRecords(store, records, { site }) {
  if (!SITE_RE.test(String(site || ''))) throw new Error('unknown_site');
  const c = { read: 0, added: 0, updated: 0, unchanged: 0, skipped_other_site: 0, refused: [], runs_added: 0, results_added: 0, results_updated: 0, results_unchanged: 0, run_errors: 0, redactions: {} };
  const runPrompts = {};
  for (const raw of records) {
    c.read++;
    const n = normalize(raw);
    if (!n.ok) { c.refused.push({ id: n.id, reasons: n.reasons }); continue; }
    if (n.site !== site) { c.skipped_other_site++; continue; }
    c[store.upsertTest(n.test)]++;
    for (const [k, v] of Object.entries(n.redactions)) c.redactions[k] = (c.redactions[k] || 0) + v;
    c.run_errors += n.runErrors.length;
    for (const r of n.runs) {
      const id = runId(site, r.product_version, r.run_number);
      if (!store.run(id)) { store.putRun({ id, site, kind: 'import', product_version: r.product_version, run_number: r.run_number, is_baseline: r.is_baseline, prompt_version: r.prompt_version, prompt_version_note: r.prompt_version_note, status: 'done', started_at: r.result.at, finished_at: r.result.at, total: 0, done: 0, cost_usd: 0 }); c.runs_added++; }
      const rr = store.run(id); if (r.is_baseline && !rr.is_baseline) rr.is_baseline = true;
      (runPrompts[id] ||= new Set()).add(r.prompt_version);
      if (rr.kind === 'import') { if (r.prompt_version_note && !rr.prompt_version_note) rr.prompt_version_note = r.prompt_version_note; if (r.result.at && (!rr.started_at || r.result.at < rr.started_at)) rr.started_at = r.result.at; if (r.result.at && (!rr.finished_at || r.result.at > rr.finished_at)) rr.finished_at = r.result.at; }
      c['results_' + store.setResult(id, n.id, r.result)]++;
    }
  }
  for (const [id, set] of Object.entries(runPrompts)) { const r = store.run(id); if (r.kind !== 'import') continue; const all = [...set]; r.prompt_version = all.length === 1 ? all[0] : (all.filter(x => x !== 'unknown').length ? 'mixed' : 'unknown'); r.total = r.done = Object.keys(store.db.results[id] || {}).length; }
  store.save();
  return c;
}
module.exports = { normalize, loadDir, importRecords, runId, siteOf, semverCmp };
