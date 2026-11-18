'use strict';
// Edge testing (John, Nov 17, 2026, 10:36 PM ET): saved edge-case emails, dry-run reruns through the real Mailbox
// pipeline, side-by-side comparison of runs, an agent grade and a human review. See runner.js for why a rerun can
// never send. The host does sign-in (existing admin session) and wraps the page in its admin layout.
const path = require('path');
const { EdgeStore, runLabel } = require('./store');
const I = require('./importer'); const R = require('./runner'); const G = require('./grade'); const V = require('./views');

// Separate small cap for edge runs, per site and New York day. It does not use (or count against) the live Mailbox's
// monthly bot budget, so a rerun can never pause real mail. $15 covers one full rfsafe.app rerun (57 tests) a day.
const DAILY_CAP_USD = 15;
const DEFAULT_PER_TEST_USD = 0.15; // sorter + writer + checker (+ a revise) on the default models, until a finished dry run gives a real average
const GRADE_EST_USD = 0.01;

function liveMods() {
  const B = require('../mailbox/bots'); const S = require('../mailbox/store'); const C = require('../mailbox/crypto');
  return { MailBots: B.MailBots, MailboxStore: S.MailboxStore, Sealer: C.Sealer, newKey: C.newKey };
}

function createEdgeTesting(o) {
  const site = o.site; const now = o.now || (() => Date.now());
  const store = new EdgeStore({ file: o.file || path.join(o.dataDir, 'edge-testing', site + '.json'), now });
  const cap = Number.isFinite(o.dailyCapUsd) ? o.dailyCapUsd : DAILY_CAP_USD;
  const realFetch = o.fetchImpl || ((...a) => fetch(...a));
  const productVersion = typeof o.productVersion === 'function' ? o.productVersion : () => String(o.productVersion || '0.0.0');
  const live = o.live || {}; const log = o.log || (() => {});
  const mods = o.mods || liveMods();
  const blocked = [];
  let job = null;
  // A run cannot survive a restart; mark it so the page does not show a run that is not happening.
  for (const r of store.runs(site)) if (r.status === 'running') { r.status = 'interrupted'; r.finished_at = store.iso(); }
  // Shipped seed (seeds/edge-tests/<site>.json, already PII-redacted): imported once per seed version, idempotently.
  let seed = null;
  if (o.seedFile) { try { const fs = require('fs'); if (fs.existsSync(o.seedFile)) { const raw = fs.readFileSync(o.seedFile, 'utf8'); const h = require('crypto').createHash('sha256').update(raw).digest('hex').slice(0, 16); store.db.seeds ||= {}; if (!store.db.seeds[h]) { seed = I.importRecords(store, [].concat(JSON.parse(raw)), { site }); store.db.seeds[h] = { at: store.iso(), added: seed.added, results_added: seed.results_added }; log('edge.seed_imported', { site, added: seed.added, updated: seed.updated, unchanged: seed.unchanged, refused: seed.refused.length }); } } } catch (e) { log('edge.seed_failed', { site, error: String(e && e.message || e).slice(0, 120) }); } }
  store.save();

  const liveBots = () => (typeof live.bots === 'function' ? live.bots() : live.bots) || null;
  // Read-only copy of the live bot definitions: saved Custom layers are tested as they are (never changed here).
  function defs() {
    const b = liveBots(); const out = {};
    const D = require('../mailbox/bot-defaults').defaults;
    for (const id of ['sorter', 'replier', 'checker']) { const r = b && b.db && b.db.installed ? b.db.installed[id] : null; const eff = r ? (r.custom || r.default) : D[id]; out[id] = { custom: r && r.custom ? JSON.parse(JSON.stringify(r.custom)) : null, version: eff && eff.version, model: eff && eff.limits && eff.limits.model }; }
    return out;
  }
  function promptInfo() { const d = defs(); const custom = Object.entries(d).filter(([, v]) => v.custom).map(([k]) => k); return { prompt_version: (d.replier.version || 'unknown') + (custom.length ? ' (custom ' + custom.join(', ') + ')' : ''), prompt_versions: { sorter: d.sorter.version, replier: d.replier.version, checker: d.checker.version }, custom, grader_model: d.checker.model }; }
  function capInfo() { const spent = store.spentToday(); return { cap, spent, remaining: Math.max(0, cap - spent) }; }
  function estimate() {
    const n = store.tests(site).length;
    const last = store.runs(site).filter(r => r.kind === 'dry_run' && r.status === 'done' && r.done > 0).pop();
    const per = last ? last.test_cost_usd / last.done : DEFAULT_PER_TEST_USD;
    const perAll = Math.round((per + GRADE_EST_USD) * 1e4) / 1e4;
    return { tests: n, per_test: perAll, total: Math.round(perAll * n * 100) / 100, basis: last ? 'average of ' + runLabel(last) : 'starting estimate' };
  }
  function status() { const r = store.running(site); return { running: !!r, run: r ? { id: r.id, label: runLabel(r), done: r.done, total: r.total, cost_usd: r.cost_usd, current: r.current || null } : null, estimate: estimate(), cap: capInfo(), product_version: productVersion() }; }

  function start({ who = 'owner' } = {}) {
    if (job || store.running(site)) return { code: 409, error: 'already_running' };
    const key = (o.env || {}).XAI_API_KEY; if (!key) return { code: 503, error: 'model_key_missing' };
    const tests = store.tests(site); if (!tests.length) return { code: 409, error: 'no_tests' };
    const est = estimate(); const c = capInfo();
    if (est.total > c.remaining + 1e-9) return { code: 409, error: 'daily_edge_cap' };
    const pv = productVersion(); const n = store.nextRunNumber(site, pv); const pi = promptInfo();
    const run = store.putRun({ id: I.runId(site, pv, n), site, kind: 'dry_run', product_version: pv, run_number: n, prompt_version: pi.prompt_version, prompt_versions: pi.prompt_versions, custom_layers: pi.custom,
      is_baseline: false, status: 'running', started_at: store.iso(), finished_at: null, total: tests.length, done: 0, cost_usd: 0, test_cost_usd: 0, grade_cost_usd: 0, est_cost_usd: est.total, blocked_requests: 0, by: String(who).slice(0, 80) });
    store.save(); log('edge.run_started', { site, run: run.id, tests: tests.length });
    job = loop(run.id, tests.map(t => t.id), key, pi).catch((e) => { const r = store.run(run.id); if (r) { r.status = 'error'; r.error = String(e && e.message || e).slice(0, 200); r.finished_at = store.iso(); store.save(); } }).finally(() => { job = null; });
    return { code: 202, run };
  }

  async function loop(runId, ids, key, pi) {
    const run = store.run(runId); const d = defs(); const before = blocked.length; const lb = liveBots() || {};
    const pickFn = (v) => (v !== undefined ? v : undefined);
    const fetchImpl = R.guardFetch(realFetch, blocked);
    const products = typeof o.products === 'function' ? o.products : (q) => R.publicProducts(q, fetchImpl);
    const kb = typeof live.kb === 'function' ? live.kb() : live.kb;
    const tools = R.edgeTools({ kb: kb && kb.kb, kbUrls: kb && kb.kbUrls, kbVersion: kb && kb.kbVersion, entryBySlug: kb && kb.entryBySlug, products });
    let stopped = false;
    for (const id of ids) {
      const t = store.test(id); if (!t) { run.total--; continue; }
      run.current = t.subject; store.save();
      let res;
      if (stopped) res = { source: 'dry_run', reply: '', disposition: 'skipped_cost_cap', hold_reason: 'Not run: the edge-run cap for today was reached.', checker_verdict: null, cost_usd: 0, at: store.iso() };
      else {
        try { res = await R.runOneTest({ test: t, mods, key, fetchImpl, tools, defs: d, capUsd: capInfo().remaining, answerRules: pickFn(live.answerRules) ?? lb.answerRules ?? null, ownDomains: live.ownDomains || lb.ownDomains || [site], siteName: live.siteName ?? lb.siteName ?? null, newsletterJoinUrl: live.newsletterJoinUrl ?? lb.newsletterJoinUrl ?? null, now, maxMs: o.maxMsPerTest, tmpRoot: o.tmpRoot }); }
        catch (e) { res = { source: 'dry_run', reply: '', disposition: 'error', hold_reason: 'Dry run error: ' + String(e && e.message || e).slice(0, 200), checker_verdict: null, cost_usd: 0, at: store.iso() }; }
        if (res.disposition === 'skipped_cost_cap') stopped = true;
      }
      res.prompt_version = pi.prompt_version;
      store.setResult(runId, id, res); store.addSpend(res.cost_usd); run.cost_usd = round(run.cost_usd + (res.cost_usd || 0)); run.test_cost_usd = round(run.test_cost_usd + (res.cost_usd || 0)); run.done++; store.save();
    }
    run.current = 'agent grades'; store.save();
    const base = store.baseline(site);
    if (base && base.id !== runId && !stopped) {
      for (const id of ids) {
        const a = store.result(base.id, id), b = store.result(runId, id); if (!a || !b || store.grade(id, base.id, runId)) continue;
        if (capInfo().remaining < GRADE_EST_USD) break;
        try { const g = await G.gradePair({ fetchImpl, key, model: pi.grader_model || 'grok-4-fast-non-reasoning', test: store.test(id), a, b, aLabel: runLabel(base), bLabel: runLabel(run) }); store.setGrade(id, base.id, runId, g); store.addSpend(g.cost_usd); run.cost_usd = round(run.cost_usd + g.cost_usd); run.grade_cost_usd = round(run.grade_cost_usd + g.cost_usd); }
        catch { /* the owner can grade this pair from the page */ }
        store.save();
      }
    }
    run.blocked_requests = blocked.length - before; run.current = null; run.status = stopped ? 'stopped_cost_cap' : 'done'; run.finished_at = store.iso(); store.save();
    log('edge.run_finished', { site, run: runId, done: run.done, cost_usd: run.cost_usd, blocked: run.blocked_requests });
  }

  async function gradeNow(testId, aId, bId) {
    const t = store.test(testId); const a = store.result(aId, testId), b = store.result(bId, testId);
    if (!t || !a || !b || aId === bId) return { code: 404, error: 'not_found' };
    if (store.grade(testId, aId, bId)) return { code: 200, grade: store.grade(testId, aId, bId) };
    if (capInfo().remaining < GRADE_EST_USD) return { code: 409, error: 'daily_edge_cap' };
    const key = (o.env || {}).XAI_API_KEY; if (!key) return { code: 503, error: 'model_key_missing' };
    const g = await G.gradePair({ fetchImpl: R.guardFetch(realFetch, blocked), key, model: promptInfo().grader_model || 'grok-4-fast-non-reasoning', test: t, a, b, aLabel: runLabel(store.run(aId)), bLabel: runLabel(store.run(bId)) });
    store.setGrade(testId, aId, bId, g); store.addSpend(g.cost_usd); store.save(); return { code: 200, grade: g };
  }

  function rows(filter) {
    const base = store.baseline(site);
    return store.tests(site).map(t => {
      const h = store.history(t.id); const top = h[0] || null;
      const cur = top ? top.result : null; const curRun = top ? top.run : null;
      const grade = cur && base && curRun.id !== base.id ? store.grade(t.id, base.id, curRun.id) : null;
      return { t, cur, curRun, grade, review: curRun ? store.review(t.id, curRun.id) : null };
    }).filter(r => filter === 'fail' ? r.cur && (r.cur.checker_verdict === 'fail' || r.cur.pass_fail === 'fail' || r.cur.pass_fail === 'mixed' || r.cur.disposition === 'error')
      : filter === 'worse' ? r.grade && r.grade.grade === 'worse' : filter === 'review' ? r.cur && !r.review : true);
  }

  // HTTP. ctx: { base, csrf, csrfOk(form), readForm(limit), wrap(title, body), send(code, html, headers), json(code, obj), who }
  async function route(req, res, u, ctx) {
    const rel = u.pathname.slice((ctx.pathBase || ctx.base).length) || '/';
    const back = (qs) => ctx.send(303, '', { location: ctx.base + (qs ? '?' + qs : '') });
    const msgQ = (t, bad) => 'msg=' + encodeURIComponent(t) + (bad ? '&bad=1' : '');
    if (req.method === 'GET' && rel === '/status.json') return ctx.json(200, status());
    if (req.method === 'GET' && rel === '/') {
      const pi = promptInfo(); const running = store.running(site);
      const msg = u.searchParams.get('msg') ? { text: String(u.searchParams.get('msg')).slice(0, 300), bad: u.searchParams.get('bad') === '1' } : null;
      const testId = String(u.searchParams.get('test') || '').slice(0, 200);
      const headers = running ? { refresh: '5' } : {};
      if (testId) {
        const t = store.test(testId); if (!t || t.site !== site) return ctx.send(404, ctx.wrap('Edge testing', '<h1>Test not found</h1><p><a href="' + V.esc(ctx.base) + '">Back to Edge testing</a></p>'));
        const hist = store.history(t.id); const top = hist[0];
        const base = store.baseline(site);
        const vsId = String(u.searchParams.get('vs') || ''); let pick = hist.find(x => x.run.id === vsId) || (top && base && base.id !== top.run.id && hist.find(x => x.run.id === base.id)) || hist[1] || top;
        const cur = top ? top.result : null, curRun = top ? top.run : null;
        const body = V.detailPage({ base: ctx.base, csrf: ctx.csrf, version: productVersion(), t, hist, cur, curRun, vs: pick ? pick.result : null, vsRun: pick ? pick.run : null, grade: pick && curRun && pick.run.id !== curRun.id ? store.grade(t.id, pick.run.id, curRun.id) : null, review: curRun ? store.review(t.id, curRun.id) : null, msg, gradeEst: GRADE_EST_USD });
        return ctx.send(200, ctx.wrap('Edge testing: ' + t.subject, body), headers);
      }
      const filter = ['fail', 'worse', 'review'].includes(u.searchParams.get('f')) ? u.searchParams.get('f') : 'all';
      const body = V.listPage({ base: ctx.base, csrf: ctx.csrf, site, version: productVersion(), prompt: pi.prompt_version, tests: store.tests(site).length, rows: rows(filter), est: estimate(), running, latest: store.runs(site).slice(-1)[0] || null, cap: capInfo(), filter, msg });
      return ctx.send(200, ctx.wrap('Edge testing', body), headers);
    }
    if (req.method !== 'POST') return ctx.json(405, { error: 'method_not_allowed' });
    const f = await ctx.readForm(rel === '/import' ? 4 * 1024 * 1024 : 64 * 1024);
    if (!ctx.csrfOk(f)) return ctx.send(403, ctx.wrap('Request blocked', '<h1>Request blocked</h1><p>Reload the Edge testing page and try again.</p>'));
    if (rel === '/run') { const r = start({ who: ctx.who }); return back(msgQ(r.code === 202 ? 'Rerun started: ' + runLabel(r.run) + '. Dry run: nothing is sent.' : ({ already_running: 'A rerun is already in progress.', daily_edge_cap: "The estimate is over what is left of today's edge-run cap.", no_tests: 'There are no saved tests yet.', model_key_missing: 'The model key is not set on this server.' }[r.error] || r.error), r.code !== 202)); }
    if (rel === '/review') {
      const t = store.test(String(f.test || '')); const run = store.run(String(f.run || ''));
      if (!t || !run || !store.result(run.id, t.id)) return ctx.json(404, { error: 'not_found' });
      try { store.setReview(t.id, run.id, { verdict: String(f.verdict || ''), note: f.note, who: ctx.who }); store.save(); } catch (e) { return back('test=' + encodeURIComponent(t.id) + '&' + msgQ('Pick pass or fail.', true)); }
      return back('test=' + encodeURIComponent(t.id) + '&' + msgQ('Review saved.'));
    }
    if (rel === '/grade') {
      let r; try { r = await gradeNow(String(f.test || ''), String(f.a || ''), String(f.b || '')); } catch (e) { r = { code: 502, error: 'The model could not grade this pair. Try again.' }; }
      if (r.code === 404) return ctx.json(404, { error: 'not_found' });
      return back('test=' + encodeURIComponent(String(f.test || '')) + '&vs=' + encodeURIComponent(String(f.a || '')) + (r.code === 200 ? '' : '&' + msgQ(r.error === 'daily_edge_cap' ? "Today's edge-run cap is used up." : r.error === 'model_key_missing' ? 'The model key is not set on this server.' : r.error, true)));
    }
    if (rel === '/tests') {
      const n = I.normalize({ site, subject: f.subject, question: f.question, expected: f.expected });
      if (!n.ok) return back(msgQ('Not saved: ' + n.reasons.join(', '), true));
      n.test.source = 'manual'; const st = store.upsertTest(n.test); store.save();
      const red = Object.values(n.redactions).reduce((a, b) => a + b, 0);
      return back(msgQ(st === 'unchanged' ? 'That test is already saved.' : 'Test saved' + (red ? ' (' + red + ' personal detail' + (red === 1 ? '' : 's') + ' removed)' : '') + '. It runs on the next rerun.'));
    }
    if (rel === '/import') {
      let recs; try { recs = JSON.parse(String(f.json || '')); } catch { return back(msgQ('Not imported: that is not valid JSON.', true)); }
      const c = I.importRecords(store, [].concat(recs), { site });
      return back(msgQ(`Imported: ${c.added} added, ${c.updated} updated, ${c.unchanged} unchanged, ${c.refused.length} refused, ${c.skipped_other_site} for the other site; ${c.results_added} run results added.`, c.refused.length > 0));
    }
    return ctx.json(404, { error: 'not_found' });
  }
  return { store, route, seed, start, status, estimate, gradeNow, defs, promptInfo, blocked, idle: () => job || Promise.resolve(), importRecords: (recs) => I.importRecords(store, recs, { site }), css: V.EDGE_CSS };
}
const round = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
module.exports = { createEdgeTesting, DAILY_CAP_USD, DEFAULT_PER_TEST_USD, GRADE_EST_USD };
