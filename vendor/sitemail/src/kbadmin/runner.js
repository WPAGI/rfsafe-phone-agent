'use strict';
// Local runner: four built-in bots (proposer, improvement reviewer, accuracy reviewer, publisher) that run on this
// server but go through exactly the same agent API as outside bots: their own kbk_ keys (one role each, marked
// "Local"), the same /admin/kb/agent/* routes over HTTP to this server, the same rate limits, locks and kill switch.
// It needs its own model key in KB_RUNNER_API_KEY, set by the owner. It never reads the phone line's or the
// mailbox's model key, and it is off until the owner presses Start. The raw runner keys live only in memory; Stop
// (or a restart) revokes them and the next Start makes fresh ones.
const S = require('./store');

const ROLES_ORDER = ['review_accuracy', 'review_improvement', 'publish', 'propose'];
const LABEL = { propose: 'Proposer', review_improvement: 'Improvement reviewer', review_accuracy: 'Accuracy reviewer', publish: 'Publisher' };

function createRunner({ store, tenant, config = {}, fetchImpl = globalThis.fetch, log = () => {}, now = () => new Date(), intervalMs = 60000 }) {
  // Read on every use so the owner's KB_RUNNER_API_KEY applies without code changes (it is set in the server env).
  const build = () => (typeof config === 'function' ? config() : config) || {};
  let cfg = mk(build());
  function mk(config) { return { apiKey: String(config.apiKey || ''), model: String(config.model || 'grok-4.7'), baseUrl: String(config.baseUrl || 'https://api.x.ai/v1').replace(/\/+$/, ''), selfBase: String(config.selfBase || ''), costIn: Number(config.costIn) || 0, costOut: Number(config.costOut) || 0 }; }
  const configured = () => !!(cfg.apiKey && cfg.selfBase);
  let state = { running: false, started_at: null, stopped_at: null, last_tick: null, last_error: '', steps: 0, tenant: null };
  let timer = null; let busy = false; const keys = new Map(); // role -> { id, key } (memory only)

  function cleanup(t) { for (const k of store.listKeys(t)) if (k.runner && !k.revoked && ![...keys.values()].some((x) => x.id === k.id)) store.revokeKey(t, k.id); }
  function status(t) {
    if (!state.running) cfg = mk(build());
    if (!state.running && t) cleanup(t);
    return { configured: configured(), why_not: cfg.apiKey ? (cfg.selfBase ? '' : 'Server address unknown') : 'Not configured: set KB_RUNNER_API_KEY (its own model key) on the server to use the local runner.', model: configured() ? cfg.model : '', running: state.running, started_at: state.started_at, stopped_at: state.stopped_at, last_tick: state.last_tick, last_error: state.last_error, steps: state.steps, interval_seconds: Math.round(intervalMs / 1000), keys: [...keys.entries()].map(([role, k]) => ({ role, id: k.id })) };
  }
  function start(t) {
    if (!state.running) cfg = mk(build());
    if (!configured()) return { ok: false, status: 409, error: 'not_configured', detail: status(t).why_not };
    if (state.running) return { ok: true, runner: status(t) };
    cleanup(t);
    for (const role of ['propose', 'review_improvement', 'review_accuracy', 'publish']) {
      const r = store.createKey(t, { name: 'Local runner ' + LABEL[role], role, origin: 'local', runner: true });
      if (!r.ok) { stop(t); return r; }
      keys.set(role, { id: r.id, key: r.key });
    }
    state = { ...state, running: true, started_at: now().toISOString(), last_error: '', steps: 0, tenant: t };
    timer = setInterval(() => { tick().catch(() => {}); }, intervalMs); if (timer.unref) timer.unref();
    store.audit(t, { action: 'runner_started', actor: S.OWNER, note: 'model ' + cfg.model });
    log('kb.runner_started', { keys: [...keys.values()].map((k) => k.id) });
    return { ok: true, runner: status(t) };
  }
  function stop(t) {
    if (timer) clearInterval(timer); timer = null;
    for (const k of keys.values()) store.revokeKey(t, k.id);
    keys.clear();
    if (state.running) store.audit(t, { action: 'runner_stopped', actor: S.OWNER });
    state = { ...state, running: false, stopped_at: now().toISOString() };
    log('kb.runner_stopped', {});
    return { ok: true, runner: status(t) };
  }

  // Same API path as outside bots.
  async function call(role, path, body, method) {
    const k = keys.get(role); if (!k) throw new Error('no key');
    const r = await fetchImpl(cfg.selfBase + '/admin/kb/agent' + path, { method: method || (body ? 'POST' : 'GET'), headers: { authorization: 'Bearer ' + k.key, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let j = {}; try { j = await r.json(); } catch {}
    return { status: r.status, j };
  }
  async function model(role, packet, task) {
    const sys = [packet.rules && packet.rules.text, packet.prompt && packet.prompt.text, 'Server rules (enforced): ' + JSON.stringify(packet.server_enforced || {}), 'Answer with one JSON object only.'].filter(Boolean).join('\n\n');
    const r = await fetchImpl(cfg.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + cfg.apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ model: cfg.model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }, { role: 'user', content: task }] }) });
    if (!r.ok) throw new Error('model http ' + r.status);
    const j = await r.json(); const u = j.usage || {};
    const tin = Number(u.prompt_tokens) || 0; const tout = Number(u.completion_tokens) || 0;
    await call(role, '/usage', { tokens_in: tin, tokens_out: tout, cost_usd: (tin * cfg.costIn + tout * cfg.costOut) / 1e6, model: cfg.model });
    const txt = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
    try { return JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)); } catch { throw new Error('model gave no JSON'); }
  }
  const brief = (p) => ({ id: p.id, rev: p.rev, slug: p.slug, title: p.title, text: p.text, source: p.source, rationale: p.rationale, live_text: p.base ? p.base.text : null, reviews: p.reviews });

  async function step(role) {
    const me = await call(role, '/me'); if (me.status !== 200 || me.j.state.paused || me.j.key.paused) return 'idle';
    const packet = (await call(role, '/prompt')).j;
    if (role === 'propose') {
      const g = (await call(role, '/gaps')).j.gaps || []; const gap = g.find((x) => !x.claim); if (!gap) return 'idle';
      if ((await call(role, '/gaps/' + gap.id + '/claim', { minutes: 10 })).status !== 200) return 'idle';
      const out = await model(role, packet, 'Customers asked this and the knowledge base had no answer:\n' + JSON.stringify({ question: gap.question, times_asked: gap.count }) + '\nWrite a new entry. Reply as JSON: {"slug":"lowercase-hyphen-slug","title":"...","text":"...","source":"https://rfsafe.app/...","rationale":"why and which sources"}');
      const r = await call(role, '/proposals', { slug: String(out.slug || ''), title: out.title, text: out.text, source: out.source, rationale: out.rationale, gap_id: gap.id });
      return r.status === 201 ? 'proposed' : 'refused:' + r.j.error;
    }
    const av = (await call(role, '/queue?available=1')).j.proposals || []; if (!av.length) return 'idle';
    const id = av[0].id;
    if ((await call(role, '/proposals/' + id + '/claim', { minutes: 10 })).status !== 200) return 'idle';
    const full = (await call(role, '/proposals/' + id)).j; const p = full.proposal; if (!p) return 'idle';
    if (role === 'publish') {
      const rivals = (full.competing || []).filter((x) => x.status === 'ready');
      const out = await model(role, packet, 'Decide this change. Candidates (all passed both reviews):\n' + JSON.stringify([brief(p)].concat(rivals.map(brief))) + '\nReply as JSON: {"publish":true|false,"choice":"<candidate id>","reason":"why this one is the best, or why none should go live"}');
      const pick = [p].concat(rivals).find((x) => x.id === out.choice) || p;
      if (out.publish === false) { const r = await call(role, '/proposals/' + p.id + '/reject', { reason: String(out.reason || 'Not good enough to publish') }); return r.status === 200 ? 'rejected' : 'refused:' + r.j.error; }
      if (pick.id !== p.id) await call(role, '/proposals/' + pick.id + '/claim', { minutes: 10 });
      const r = await call(role, '/proposals/' + pick.id + '/publish', { rev: pick.rev, reason: String(out.reason || '') });
      return r.status === 200 ? 'published' : 'refused:' + r.j.error;
    }
    const what = role === 'review_improvement' ? 'Is this change an improvement over the live text (clearer, more complete, plain language)?' : 'Is every fact in this text correct and backed by its source? Check names, numbers, dates and law quotes.';
    const out = await model(role, packet, what + '\n' + JSON.stringify(brief(p)) + '\nReply as JSON: {"pass":true|false,"reason":"specific reason"}');
    const r = await call(role, '/proposals/' + id + '/review', { rev: p.rev, pass: out.pass === true, reason: String(out.reason || 'No reason given') });
    return r.status === 200 ? 'reviewed' : 'refused:' + r.j.error;
  }
  async function tick() {
    if (!state.running || busy) return null; busy = true; const done = [];
    try {
      for (const role of ROLES_ORDER) {
        if (!state.running) break;
        try { const x = await step(role); done.push(role + ':' + x); if (x !== 'idle') state.steps++; } catch (e) { state.last_error = LABEL[role] + ': ' + String(e.message || e).slice(0, 160); done.push(role + ':error'); }
      }
      state.last_tick = now().toISOString();
      return done;
    } finally { busy = false; }
  }
  return { status, start, stop, tick, configured };
}
module.exports = { createRunner };
