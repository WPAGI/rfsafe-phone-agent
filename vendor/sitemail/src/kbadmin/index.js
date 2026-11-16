'use strict';
// Knowledge Base Admin: the owner's mail-style page at /mail/kb (same magic-link session as /mail) and the
// agent API at /admin/kb/agent/* (Bearer kbk_… keys, one role each). See docs/KB_ADMIN.md.
// Raw keys are returned once, in the JSON response to the owner's create call, and never logged or stored.
const { readBody } = require('../util');
const kbapi = require('../kbapi');
const S = require('./store');

const AGENT_RE = /^\/(?:bizinator\/)?admin\/kb\/agent(?:\/(me|prompt|entries|queue|proposals|gaps|usage|merges)(?:\/([a-z0-9]+(?:-[a-z0-9]+)*|p_[a-f0-9]{12})(?:\/(versions|review|publish|reject|revert|claim))?)?)?$/;
const PER_PAGE = 50;
const MAX_JSON = 48 * 1024;

function labelsFor(p, st) {
  const L = [];
  if (p.locked_entry) L.push('Locked');
  if (p.status === 'published') L.push(p.undone ? 'Undone' : 'Updated');
  else if (p.status === 'rejected') L.push(p.decision && p.decision.action === 'superseded' ? 'Not chosen' : 'Rejected');
  else if (p.status === 'for_owner') L.push('Needs John');
  else if (p.status === 'ready') L.push(st.auto_publish ? 'Ready to publish' : 'Needs John');
  else {
    const ri = p.reviews.improvement; const ra = p.reviews.accuracy;
    if (!ri && !ra) L.push('Proposed');
    else if (ri && !ra) L.push('Accuracy check');
    else L.push('In debate');
  }
  return L;
}
function folderOf(p, st) {
  if (p.status === 'published') return 'updated';
  if (p.status === 'rejected') return 'rejected';
  if (p.status === 'for_owner') return 'locked';
  if (p.status === 'ready' && !st.auto_publish) return 'needs';
  return 'inbox';
}
const FOLDERS = ['inbox', 'needs', 'locked', 'updated', 'rejected', 'all'];
const STAGE = { published: 5, ready: 4, in_review: 3, for_owner: 3, rejected: 1 };
// One inbox row per thread: competing suggestions on the same entry (same live wording) share one row.
function groupThreads(list) {
  const by = new Map(); const out = [];
  for (const x of list) {
    if (x.type !== 'proposal') { out.push(x); continue; }
    const g = by.get(x.thread); if (!g) { const row = { ...x, suggestions: 1, thread_ids: [x.id] }; by.set(x.thread, row); out.push(row); continue; }
    g.suggestions++; g.thread_ids.push(x.id); if (!g.read || !x.read) g.read = g.read && x.read;
    if ((STAGE[x.status] || 0) > (STAGE[g.status] || 0)) { const keep = { suggestions: g.suggestions, thread_ids: g.thread_ids, read: g.read }; Object.assign(g, x, keep); }
  }
  for (const g of out) if (g.suggestions > 1 && !g.labels.includes('Competing')) g.labels = g.labels.concat(['Competing']);
  return out;
}
const page = (list, u) => { const per = Math.min(200, Math.max(1, parseInt(u.searchParams.get('per') || PER_PAGE, 10) || PER_PAGE)); const pg = Math.max(1, parseInt(u.searchParams.get('page') || '1', 10) || 1); return { items: list.slice((pg - 1) * per, pg * per), page: pg, per, total: list.length, pages: Math.max(1, Math.ceil(list.length / per)) }; };

// Live updates: server-sent events. Owner-only, capped, heartbeat every 20 s (Render's proxy keeps idle
// streams open while bytes flow), each stream closed after 10 minutes (the browser reconnects by itself).
// Streams only wait on timers and change events, so they never hold the event loop, a call or a mail run.
const SSE = { max: 8, heartbeatMs: 20000, maxAgeMs: 10 * 60000 };
function createKbAdmin({ dataDir, kbApiStore, tenant, kbReset, publicReset = () => {}, catalog, gapFile, log = () => {}, now = () => new Date(), limits, autoPause, sse = {}, runner: runnerCfg = {}, runnerFetch, runnerIntervalMs, webResearchSeed = null }) {
  const SS = { ...SSE, ...sse };
  if (!dataDir || !kbApiStore) return null;
  let cache = null; // { at, id, entries }
  const cat = (t) => {
    const at = now().getTime();
    if (!cache || cache.id !== t || at - cache.at > 15000) cache = { at, id: t, entries: catalog().entries || [] };
    return cache.entries;
  };
  const invalidate = (t) => { cache = null; try { if (kbReset) kbReset(t); } catch {} try { publicReset(t); } catch {} };
  const liveLookup = (t, slug) => {
    const a = kbApiStore.get(t, slug); if (a) return a;
    const e = cat(t).find((x) => x.slug === slug); return e ? { slug: e.slug, title: e.title, text: e.text, aliases: e.aliases, source: e.source, owner_approved: !!e.owner_approved, enabled: e.enabled !== false } : null;
  };
  const G = require('../kbgaps');
  const gaps = (t) => gapFile ? G.list(gapFile, { status: 'open' }).filter((g) => !g.tenant || g.tenant === t) : [];
  const resolveGap = (id, by) => { if (gapFile) G.resolve({ gapFile, dataDir, id, who: by, markOnly: true, note: 'Answered in Knowledge Base Admin', now }); };
  const store = S.open({ dataDir, kbApiStore, liveLookup, listLive: (t) => cat(t), gaps, resolveGap, now, limits, autoPause });
  const tid = () => { const t = tenant(); return t ? t.id : null; };
  // Web research fallback (Brain box side): perspective, settings and "Answered by web search" review items. See
  // docs/MAILBOX_WEB_RESEARCH.md. The Mailbox reads config() and reports items through webResearchFor() below.
  const web = require('./webresearch').open({ root: require('path').join(dataDir, 'kb-api'), store, now, seed: webResearchSeed });
  const webItem = (it) => ({ type: 'web_answer', id: it.id, title: it.subquestion, summary: (it.outcome === 'answered' ? 'Proposed answer: ' + it.proposed_answer : 'Not answered: ' + (it.outcome_reason || it.outcome)).slice(0, 200), labels: ['Answered by web search'].concat(it.outcome === 'answered' ? [] : ['Not answered']).concat(it.checker ? ['Checker ' + it.checker.verdict] : []).concat(it.status === 'proposed' ? ['Sent to proposals'] : []), folder: 'inbox', proposer: { type: 'system', id: 'web-research', name: 'Answered by web search', role: 'system' }, updated: it.updated, created: it.created, read: !!it.read, messages: 0, outcome: it.outcome, status: it.status });
  const runner = require('./runner').createRunner({ store, tenant: tid, config: runnerCfg, fetchImpl: runnerFetch || globalThis.fetch, log, now, intervalMs: runnerIntervalMs || 60000 });

  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex' }); res.end(JSON.stringify(obj)); return true; };
  const out = (res, r, ok = 200) => r.ok ? json(res, ok, r) : json(res, r.status || 400, { error: r.error, detail: r.detail || undefined });
  async function body(req) {
    const ctype = String(req.headers['content-type'] || '');
    if (!/application\/json/i.test(ctype)) { const e = new Error('json_only'); e.status = 415; throw e; }
    try { return JSON.parse(await readBody(req, MAX_JSON) || '{}'); } catch (e) { if (e.status) throw e; const err = new Error('invalid_json'); err.status = 400; throw err; }
  }
  const summary = (p, st) => ({ type: 'proposal', id: p.id, thread: store.keyOf(p), merged_from: p.merged_from || undefined, slug: p.slug, title: p.title, summary: p.summary || '', kind: p.kind, status: p.status, rev: p.rev, labels: labelsFor(p, st), folder: folderOf(p, st), proposer: p.actors.proposer, updated: p.updated, created: p.created, read: !!p.read, gap_id: p.gap_id || '', reviews: { improvement: p.reviews.improvement ? p.reviews.improvement.pass : null, accuracy: p.reviews.accuracy ? p.reviews.accuracy.pass : null }, messages: p.thread.length, claims: Object.fromEntries(Object.entries(p.claims || {}).filter(([, c]) => c && Date.parse(c.until) > now().getTime())) });
  const gapItem = (g) => ({ type: 'gap', id: 'g_' + g.id, gap_id: g.id, title: g.question, summary: 'Asked ' + g.count + ' time' + (g.count === 1 ? '' : 's') + (g.channels.length ? ' by ' + g.channels.join(', ') : ''), labels: ['KB gap'].concat(g.claim ? ['Claimed'] : []), folder: 'inbox', proposer: { type: 'system', id: 'kb-gaps', name: 'Unanswered question', role: 'system' }, updated: g.last_at, created: g.first_at, read: true, messages: 0, claim: g.claim });

  // ---------------- agent API (Bearer kbk_ key) ----------------
  const isAgentPath = (p) => AGENT_RE.test(String(p || '').split('?')[0]);
  async function agentRoute(req, res, u) {
    const m = u.pathname.match(AGENT_RE); if (!m) return false;
    const t = tid(); if (!t) return json(res, 404, { error: 'not_found' });
    const actor = store.verify(t, req.headers.authorization);
    if (!actor) return json(res, 401, { error: 'unauthorized' });
    if (actor.disabled) return json(res, 403, { error: 'key_disabled', detail: 'The owner turned this key off in Knowledge Base Admin.' });
    if (!store.allow('all-agents', 'global')) { log('kb.agent_rate_limited', { scope: 'global' }); return json(res, 429, { error: 'too_many_requests', detail: 'All agents together are over the site limit. Try again in a minute.' }); }
    if (!store.allow(actor.id, 'all', actor.per_minute)) { log('kb.agent_rate_limited', { key: actor.id }); return json(res, 429, { error: 'too_many_requests' }); }
    store.touch(t, actor.id);
    const [, res1 = '', id = '', sub = ''] = m; const method = req.method;
    const st = store.settings(t);
    const write = method !== 'GET';
    const need = (roles) => { if (!roles.includes(actor.role)) { store.audit(t, { action: 'denied', actor, fail: true, note: 'wrong_role:' + method + ' ' + res1 + (sub ? '/' + sub : '') }); store.autoPauseCheck(t); json(res, 403, { error: 'wrong_role', detail: 'Your key is a ' + S.ROLE_LABEL[actor.role] + ' key.' }); return false; } return true; };
    try {
      if (res1 === 'usage' && method === 'POST' && !id) return out(res, store.reportUsage(t, actor, await body(req)));
      if (write && st.paused) return json(res, 403, { error: 'agents_paused', detail: st.paused_reason || 'Agents are paused by the owner.' });
      if (write && actor.paused) return json(res, 403, { error: 'agent_paused', detail: 'The owner paused this agent.' });
      if (write && store.capReached(t, actor)) return json(res, 429, { error: 'daily_cap_reached', detail: 'This key reached its daily cost cap of $' + actor.daily_cost_cap + '.' });
      if (!write) {
        if (method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
        if (res1 === 'usage') return json(res, 200, { today: store.usageToday(t, actor.id), days: store.usageDays(t, actor.id), daily_cost_cap: actor.daily_cost_cap });
        if (res1 === 'gaps' && !id) return json(res, 200, { gaps: store.openGaps(t).slice(0, 200) });
        if (!res1 || res1 === 'me') return json(res, 200, { key: { id: actor.id, name: actor.name, role: actor.role, paused: actor.paused, daily_cost_cap: actor.daily_cost_cap }, state: { paused: st.paused, auto_publish: st.auto_publish }, limits: actor.role === 'propose' ? { requests: (limits || S.LIMITS).all, proposals: (limits || S.LIMITS).propose } : { requests: (limits || S.LIMITS).all } });
        if (res1 === 'prompt' && !id) return json(res, 200, store.packet(t, actor));
        if (res1 === 'entries' && !id) return json(res, 200, { entries: store.entries(t, { q: (u.searchParams.get('q') || '').slice(0, 120), limit: Math.min(1000, parseInt(u.searchParams.get('limit') || '300', 10) || 300) }) });
        if (res1 === 'entries' && id && !sub) {
          const live = liveLookup(t, id); if (!live) return json(res, 404, { error: 'not_found' });
          const s = store.entrySetting(t, id, live);
          return json(res, 200, { entry: { ...store.snapshotOf(live), slug: id }, locked: s.locked, suggestions_allowed: s.suggestions_allowed, pending: store.pendingFor(t, id), versions: store.versions(t, id).map((v) => ({ v: v.v, at: v.at, action: v.action, why: v.why || '' })) });
        }
        if (res1 === 'entries' && id && sub === 'versions') return json(res, 200, { slug: id, versions: store.versions(t, id) });
        if (res1 === 'queue' && u.searchParams.get('available') === '1') { const av = store.available(t, actor, { limit: 50 }); return json(res, 200, { gaps: av.gaps, proposals: av.proposals.map((p) => summary(p, st)) }); }
        if (res1 === 'queue') {
          const status = String(u.searchParams.get('status') || '');
          let list = store.listProposals(t); if (status) list = list.filter((p) => p.status === status);
          return json(res, 200, { proposals: list.slice(0, 200).map((p) => summary(p, st)) });
        }
        if (res1 === 'proposals' && id && !sub) { const p = store.getProposal(t, id); return p ? json(res, 200, { proposal: p, competing: store.siblings(t, p) }) : json(res, 404, { error: 'not_found' }); }
        return json(res, 404, { error: 'not_found' });
      }
      // writes
      if (res1 === 'proposals' && !id && method === 'POST') {
        if (!need(['propose'])) return true;
        if (!store.allow(actor.id, 'propose')) return json(res, 429, { error: 'too_many_proposals' });
        const r = store.propose(t, actor, await body(req)); if (r.ok) log('kb.agent_propose', { key: actor.id, slug: r.proposal.slug, id: r.proposal.id });
        return out(res, r, 201);
      }
      if (res1 === 'proposals' && id && !sub && method === 'PUT') {
        if (!need(['propose'])) return true;
        if (!store.allow(actor.id, 'propose')) return json(res, 429, { error: 'too_many_proposals' });
        return out(res, store.update(t, actor, id, await body(req)));
      }
      if (res1 === 'proposals' && id && sub === 'claim' && method === 'POST') { if (!need(['review_improvement', 'review_accuracy', 'publish'])) return true; const b = await body(req).catch(() => ({})); return out(res, store.claim(t, actor, id, b.minutes)); }
      if (res1 === 'gaps' && id && sub === 'claim' && method === 'POST') { if (!need(['propose'])) return true; const b = await body(req).catch(() => ({})); return out(res, store.claimGap(t, actor, id, b.minutes)); }
      if (res1 === 'proposals' && id && sub === 'review' && method === 'POST') { if (!need(['review_improvement', 'review_accuracy'])) return true; return out(res, store.review(t, actor, id, await body(req))); }
      if (res1 === 'proposals' && id && sub === 'publish' && method === 'POST') {
        if (!need(['publish'])) return true;
        const r = store.publish(t, actor, id, await body(req));
        if (r.ok) { invalidate(t); log('kb.agent_publish', { key: actor.id, slug: r.proposal.slug, version: r.version.v, text_hash: kbapi.textHash(r.proposal.text) }); }
        return out(res, r);
      }
      if (res1 === 'merges' && !id && method === 'POST') { if (!need(['publish'])) return true; const r = store.merge(t, actor, await body(req)); if (r.ok) log('kb.agent_merge', { key: actor.id, slug: r.proposal.slug, id: r.proposal.id }); return out(res, r, 201); }
      if (res1 === 'proposals' && id && sub === 'reject' && method === 'POST') { if (!need(['publish'])) return true; return out(res, store.reject(t, actor, id, await body(req))); }
      if (res1 === 'entries' && id && sub === 'revert' && method === 'POST') {
        if (!need(['publish'])) return true;
        const b = await body(req); const r = store.revert(t, actor, id, b.version, b.reason);
        if (r.ok) { invalidate(t); log('kb.agent_revert', { key: actor.id, slug: id, version: r.version.v }); }
        return out(res, r);
      }
      return json(res, 405, { error: 'method_not_allowed' });
    } catch (e) {
      if (e.status) return json(res, e.status, { error: e.message });
      log('kb.agent_error', { err: String(e.message || e).slice(0, 200) });
      return json(res, 500, { error: 'internal_error' });
    }
  }

  const streams = new Set();
  function events(req, res, t) {
    if (streams.size >= SS.max) { res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '30', 'cache-control': 'no-store' }); res.end('{"error":"too_many_streams"}'); return true; }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex' });
    try { req.socket.setNoDelay(true); req.socket.setTimeout(0); } catch {}
    res.write('retry: 5000\n\nevent: hello\ndata: {"ok":true}\n\n');
    const s = { res };
    const off = store.onChange((ev) => { if (ev.tenant !== t) return; try { res.write('id: ' + ev.seq + '\nevent: kb\ndata: ' + JSON.stringify({ seq: ev.seq, at: ev.at, type: ev.type, action: ev.action, slug: ev.slug, proposal_id: ev.proposal_id, actor: ev.actor }) + '\n\n'); } catch {} });
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, SS.heartbeatMs); if (hb.unref) hb.unref();
    const age = setTimeout(() => { try { res.end(); } catch {} }, SS.maxAgeMs); if (age.unref) age.unref();
    const done = () => { if (!streams.has(s)) return; streams.delete(s); off(); clearInterval(hb); clearTimeout(age); };
    s.close = () => { done(); try { res.end(); } catch {} };
    streams.add(s); req.on('close', done); res.on('close', done); res.on('error', done);
    return true;
  }
  const closeStreams = () => { for (const s of [...streams]) s.close(); };

  // ---------------- owner API (/mail/kb/api/*, mail session + CSRF checked by the mail module) ----------------
  async function ownerRoute(req, res, sub, u) {
    const t = tid(); if (!t) return json(res, 404, { error: 'not_found' });
    const path = sub.replace(/^\/kb\/api/, '') || '/'; const method = req.method; const st = store.settings(t);
    let m;
    try {
      if (method === 'GET' && path === '/events') return events(req, res, t);
      if (method === 'GET' && path === '/state') {
        const all = store.listProposals(t); const counts = Object.fromEntries(FOLDERS.map((f) => [f, 0])); const unread = Object.fromEntries(FOLDERS.map((f) => [f, 0]));
        for (const p of all) { const f = folderOf(p, st); counts[f]++; counts.all++; if (!p.read) { unread[f]++; unread.all++; } }
        const og = store.openGaps(t).length; counts.inbox += og; counts.gaps = og;
        const wa = web.list(t).filter((x) => x.status === 'new'); counts.inbox += wa.length; counts.web = wa.length; if (wa.some((x) => !x.read)) { unread.inbox += wa.filter((x) => !x.read).length; }
        const prompts = S.PROMPT_IDS.map((id) => store.prompt(t, id));
        return json(res, 200, { tenant: t, settings: { paused: st.paused, paused_reason: st.paused_reason, auto_publish: st.auto_publish }, counts, unread, keys: store.listKeys(t).filter((k) => !k.revoked).length, prompts_ready: prompts.every((x) => x && x.text.length > 20), roles: S.ROLES.map((r) => ({ id: r, label: S.ROLE_LABEL[r] })) });
      }
      if (method === 'GET' && path === '/folder') {
        const f = FOLDERS.includes(u.searchParams.get('f')) ? u.searchParams.get('f') : 'inbox';
        const q = String(u.searchParams.get('q') || '').toLowerCase().slice(0, 120); const label = String(u.searchParams.get('label') || '').slice(0, 40);
        let list = store.listProposals(t).filter((p) => f === 'all' || folderOf(p, st) === f).map((p) => summary(p, st));
        if (f === 'inbox' || f === 'all') list = list.concat(store.openGaps(t).map(gapItem));
        if (f === 'inbox') list = list.concat(web.list(t).filter((x) => x.status === 'new').map(webItem));
        if (f === 'all') list = list.concat(web.list(t).map(webItem));
        list.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
        if (u.searchParams.get('group') !== '0') list = groupThreads(list);
        if (label) list = list.filter((x) => x.labels.includes(label));
        if (q) list = list.filter((x) => [x.title, x.summary, x.slug, x.proposer && x.proposer.name, x.labels.join(' ')].join(' ').toLowerCase().includes(q));
        return json(res, 200, { folder: f, ...page(list, u) });
      }
      if (method === 'GET' && path === '/activity') {
        const lim = Math.min(300, parseInt(u.searchParams.get('limit') || '100', 10) || 100);
        const rows = store.activity(t, { limit: lim, before: u.searchParams.get('before') || undefined, actor: u.searchParams.get('actor') || undefined, slug: u.searchParams.get('slug') || undefined });
        return json(res, 200, { activity: rows, next_before: rows.length === lim ? rows[rows.length - 1].at : null });
      }
      if ((m = path.match(/^\/gap\/g_([a-f0-9]{16})$/)) && method === 'GET') { const g = store.openGaps(t).find((x) => x.id === m[1]); return g ? json(res, 200, { gap: g, item: gapItem(g) }) : json(res, 404, { error: 'not_found' }); }
      // ---- web research fallback (owner only) ----
      if (method === 'GET' && path === '/web-research') return json(res, 200, { settings: web.settings(t), defaults: require('./webresearch').DEFAULTS, limits: require('./webresearch').LIMITS, perspective: web.perspective(t), history: web.perspectiveHistory(t), items: web.list(t).slice(0, 200).map(webItem) });
      if (method === 'POST' && path === '/web-research/settings') { const b = await body(req); return out(res, web.saveSettings(t, b)); }
      if (method === 'POST' && path === '/web-research/perspective') { const b = await body(req); return out(res, web.savePerspective(t, b.text, b.why)); }
      if (method === 'POST' && path === '/web-research/perspective/revert') { const b = await body(req); return out(res, web.revertPerspective(t, b.version)); }
      if (method === 'POST' && path === '/web-research/perspective/lock') { const b = await body(req); return out(res, web.setLocked(t, b.locked !== false)); }
      if ((m = path.match(/^\/web-answer\/(w_[a-f0-9]{12})(?:\/(propose|dismiss|read))?$/))) {
        if (method === 'GET' && !m[2]) { const it = web.get(t, m[1]); if (!it) return json(res, 404, { error: 'not_found' }); if (!it.read) web.markRead(t, it.id, true); return json(res, 200, { item: it, summary: webItem(it) }); }
        if (method === 'POST' && m[2] === 'propose') { const b = await body(req); return out(res, web.propose(t, m[1], b), 201); }
        if (method === 'POST' && m[2] === 'dismiss') { const b = await body(req); return out(res, web.dismiss(t, m[1], b.reason)); }
        if (method === 'POST' && m[2] === 'read') { const b = await body(req); return out(res, web.markRead(t, m[1], b.read !== false)); }
      }
      if (method === 'GET' && path === '/agents') return json(res, 200, { agents: store.agents(t), limits: limits || S.LIMITS, runner: runner.status(t) });
      if (method === 'GET' && path === '/runner') return json(res, 200, { runner: runner.status(t) });
      if (method === 'POST' && path === '/runner/tick') { if (!runner.status(t).running) return json(res, 409, { error: 'not_running' }); const done = await runner.tick(); return json(res, 200, { ok: true, done, runner: runner.status(t) }); }
      if (method === 'POST' && path === '/runner') { const b = await body(req); return out(res, b.action === 'start' ? runner.start(t) : b.action === 'stop' ? runner.stop(t) : { ok: false, status: 400, error: 'bad_action' }); }
      if ((m = path.match(/^\/agents\/(kk_[a-f0-9]{12})$/)) && method === 'GET') { const a = store.agents(t).find((x) => x.id === m[1]); if (!a) return json(res, 404, { error: 'not_found' }); return json(res, 200, { agent: a, usage: store.usageDays(t, m[1]), activity: store.activity(t, { limit: 100, actor: m[1] }), threads: store.listProposals(t).filter((p) => Object.values(p.actors).some((x) => x && x.id === m[1])).slice(0, 100).map((p) => summary(p, st)) }); }
      if ((m = path.match(/^\/proposal\/(p_[a-f0-9]{12})(?:\/(publish|reject|undo|read))?$/))) {
        const id = m[1];
        if (method === 'GET' && !m[2]) {
          const p = store.getProposal(t, id); if (!p) return json(res, 404, { error: 'not_found' });
          const live = liveLookup(t, p.slug); const s = store.entrySetting(t, p.slug, live);
          if (!p.read) store.markRead(t, id, true);
          const sib = store.siblings(t, p, { open: false }).sort((a, b) => String(a.created).localeCompare(String(b.created)));
          return json(res, 200, { proposal: p, summary: summary(p, st), competing: sib.map((x) => ({ proposal: x, summary: summary(x, st) })), live: live ? store.snapshotOf(live) : null, locked: s.locked, suggestions_allowed: s.suggestions_allowed });
        }
        if (method === 'POST' && m[2] === 'publish') { const r = store.ownerPublish(t, id, await body(req)); if (r.ok) { invalidate(t); log('kb.admin_publish', { slug: r.proposal.slug, version: r.version.v }); } return out(res, r); }
        if (method === 'POST' && m[2] === 'reject') { const b = await body(req); return out(res, store.reject(t, S.OWNER, id, b)); }
        if (method === 'POST' && m[2] === 'undo') { const b = await body(req); const r = store.undo(t, id, b.reason); if (r.ok) { invalidate(t); log('kb.admin_undo', { id, version: r.version.v }); } return out(res, r); }
        if (method === 'POST' && m[2] === 'read') { const b = await body(req); return out(res, store.markRead(t, id, b.read !== false)); }
      }
      if (method === 'GET' && path === '/entries') {
        let list = store.entries(t, { q: (u.searchParams.get('q') || '').slice(0, 120), limit: 100000 });
        const topics = [...new Set(list.map((e) => e.topic || 'General'))].sort();
        const topic = u.searchParams.get('topic'); if (topic) list = list.filter((e) => (e.topic || 'General') === topic);
        if (u.searchParams.get('filter') === 'pending') list = list.filter((e) => e.pending); if (u.searchParams.get('filter') === 'locked') list = list.filter((e) => e.locked);
        return json(res, 200, { topics, ...page(list, u), entries: undefined });
      }
      if ((m = path.match(/^\/entry\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/(settings|edit|revert))?$/))) {
        const slug = m[1];
        if (method === 'GET' && !m[2]) {
          const live = liveLookup(t, slug); const s = store.entrySetting(t, slug, live);
          if (!live && !store.versions(t, slug).length) return json(res, 404, { error: 'not_found' });
          const meta = kbApiStore.get(t, slug);
          const isPublic = require('../publickb/data').effectivePublic({ slug, title: live && live.title, meta, override: s.is_public == null ? undefined : s.is_public });
          return json(res, 200, { slug, live: live ? store.snapshotOf(live) : null, locked: s.locked, suggestions_allowed: s.suggestions_allowed, is_public: isPublic, public_listed: !!(meta && meta.enabled && isPublic), versions: store.versions(t, slug).slice().reverse(), proposals: store.listProposals(t).filter((p) => p.slug === slug).map((p) => summary(p, st)) });
        }
        if (method === 'POST' && m[2] === 'settings') { const b = await body(req); const r = store.setEntry(t, slug, { locked: typeof b.locked === 'boolean' ? b.locked : undefined, suggestions_allowed: typeof b.suggestions_allowed === 'boolean' ? b.suggestions_allowed : undefined, is_public: typeof b.is_public === 'boolean' ? b.is_public : undefined }); if (r.ok && typeof b.is_public === 'boolean') { try { publicReset(t); } catch {} } return out(res, r); }
        if (method === 'POST' && m[2] === 'edit') {
          const b = await body(req); const before = liveLookup(t, slug);
          const n = kbapi.normalizeEntry({ ...b, slug, owner_approved: b.owner_approved !== false, enabled: true }, { slug, existing: before ? { ...store.snapshotOf(before), slug } : null });
          if (n.error) return json(res, 400, { error: n.error, detail: n.detail });
          const r = kbApiStore.put(t, n.entry, slug); if (!r.ok) return out(res, r);
          const v = store.recordVersion(t, slug, r.entry, { action: 'owner_edit', published_by: S.OWNER, why: String(b.note || 'Edited by the owner').slice(0, 1000) }, before);
          store.audit(t, { action: 'owner_edit', slug, actor: S.OWNER, version: v.v, text_hash: kbapi.textHash(r.entry.text) });
          invalidate(t); return json(res, 200, { ok: true, entry: r.entry, version: v });
        }
        if (method === 'POST' && m[2] === 'revert') { const b = await body(req); const r = store.revert(t, S.OWNER, slug, b.version, b.reason); if (r.ok) invalidate(t); return out(res, r); }
      }
      if (method === 'GET' && path === '/keys') return json(res, 200, { keys: store.listKeys(t), roles: S.ROLES.map((r) => ({ id: r, label: S.ROLE_LABEL[r] })) });
      if ((m = path.match(/^\/keys\/(kk_[a-f0-9]{12})\/rotate$/)) && method === 'POST') { const r = store.rotateKey(t, m[1]); if (!r.ok) return out(res, r); log('kb.key_rotated', { id: r.id, from: m[1] }); return json(res, 201, { ok: true, id: r.id, key: r.key, record: r.record, note: 'Shown once. The old key is turned off.' }); }
      if ((m = path.match(/^\/keys\/(kk_[a-f0-9]{12})$/)) && method === 'POST') { const b = await body(req); return out(res, store.updateKey(t, m[1], { paused: typeof b.paused === 'boolean' ? b.paused : undefined, enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined, per_minute: b.per_minute, daily_cost_cap: b.daily_cost_cap })); }
      if (method === 'POST' && path === '/keys/new') {
        const b = await body(req); const r = store.createKey(t, { name: b.name, role: b.role, origin: b.origin, per_minute: b.per_minute, daily_cost_cap: b.daily_cost_cap });
        if (!r.ok) return out(res, r);
        log('kb.key_created', { id: r.id, role: r.record.role }); // never the key
        return json(res, 201, { ok: true, id: r.id, key: r.key, record: r.record, note: 'Shown once. Only a hash is stored.' });
      }
      if ((m = path.match(/^\/keys\/(kk_[a-f0-9]{12})\/revoke$/)) && method === 'POST') { const r = store.revokeKey(t, m[1]); if (r.ok) log('kb.key_revoked', { id: m[1] }); return out(res, r); }
      if (method === 'GET' && path === '/prompts') return json(res, 200, { prompts: S.PROMPT_IDS.map((id) => store.prompt(t, id)) });
      if ((m = path.match(/^\/prompts\/(rules|propose|review_improvement|review_accuracy|publish)(?:\/(revert))?$/))) {
        if (method === 'GET' && !m[2]) return json(res, 200, { prompt: store.prompt(t, m[1]), history: store.promptHistory(t, m[1]) });
        if (method === 'POST' && !m[2]) { const b = await body(req); return out(res, store.savePrompt(t, m[1], b.text, b.why)); }
        if (method === 'POST' && m[2] === 'revert') { const b = await body(req); return out(res, store.revertPrompt(t, m[1], b.version)); }
      }
      if (method === 'POST' && path === '/settings') {
        const b = await body(req); let r = { ok: true };
        if (typeof b.paused === 'boolean') r = store.setPaused(t, b.paused, S.OWNER, b.reason);
        if (typeof b.auto_publish === 'boolean') r = store.setAutoPublish(t, b.auto_publish, S.OWNER);
        const s2 = store.settings(t); return json(res, 200, { ok: !!r.ok, settings: { paused: s2.paused, paused_reason: s2.paused_reason, auto_publish: s2.auto_publish } });
      }
      return json(res, 404, { error: 'not_found' });
    } catch (e) {
      if (e.status) return json(res, e.status, { error: e.message });
      log('kb.admin_error', { err: String(e.message || e).slice(0, 200) });
      return json(res, 500, { error: 'internal_error' });
    }
  }

  // Owner KB API (PR #32) writes become wiki versions too.
  function recordOwnerApi(t, slug, entry, action, before) {
    try { store.recordVersion(t, slug, entry, { action: 'owner_api_' + action, published_by: { type: 'owner', id: 'owner-api', name: 'Owner KB API', role: 'owner' }, why: 'Owner KB API ' + action }, before); cache = null; } catch (e) { log('kb.version_error', { err: String(e.message || e).slice(0, 200) }); }
  }

  // What the Mailbox may use (read the live config, log or update a review item). Never a KB write.
  const webResearchFor = () => {
    const t = tid(); if (!t) return null;
    return { config: () => web.config(t), logItem: (b) => { const r = web.logItem(t, b); if (r.ok) store.emit(t, { type: 'web_answer', action: 'web_answer_logged', slug: '', proposal_id: r.item.id }); return r; }, updateItem: (id, b) => web.updateItem(t, id, b) };
  };
  return { store, web, webResearchFor, runner, streamCount: () => streams.size, closeStreams, isAgentPath, agentRoute, ownerRoute, recordOwnerApi, liveLookup, labelsFor, folderOf };
}

// Deploy stages (checklist section 8): stage A ships the API, data and keys with the owner page switched off;
// stage B turns the page on. Code constant, not an env var.
const UI = true;
module.exports = { createKbAdmin, labelsFor, folderOf, AGENT_RE, UI };
