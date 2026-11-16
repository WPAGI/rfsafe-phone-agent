'use strict';
// Knowledge Base Admin store (KB editorial swarm v2). Flat JSON files next to the owner KB API data:
//   DATA_DIR/kb-api/<tenant>/swarm/keys.json       bot keys (SHA-256 hash only, never the raw key)
//   DATA_DIR/kb-api/<tenant>/swarm/settings.json   kill switch, auto-publish flag, per-entry lock / suggestions
//   DATA_DIR/kb-api/<tenant>/swarm/queue/<id>.json proposals (one file each)
//   DATA_DIR/kb-api/<tenant>/versions/<slug>.json  wiki version history per entry
//   DATA_DIR/kb-api/<tenant>/prompts/<id>.json     versioned role prompts (seeded from kb-agent-prompts/*.md)
//   DATA_DIR/kb-api/<tenant>/audit.jsonl           shared audit log (rows here carry kind:"swarm")
// Live writes go through the owner KB API store (kbapi.put), so every change still takes a backup there.
// Every rule is enforced here, on the server. Nothing in a prompt, an entry or a proposal can widen a key's role.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kbapi = require('../kbapi');

const ROLES = ['read', 'propose', 'review_improvement', 'review_accuracy', 'publish'];
const PROMPT_IDS = ['rules', 'propose', 'review_improvement', 'review_accuracy', 'publish'];
const ROLE_LABEL = { read: 'Reader', propose: 'Proposer', review_improvement: 'Improvement reviewer', review_accuracy: 'Accuracy reviewer', publish: 'Publisher', rules: 'Shared rules' };
const SLOTS = { propose: 'proposer', review_improvement: 'improvement', review_accuracy: 'accuracy', publish: 'publisher' };
const OPEN = new Set(['in_review', 'ready', 'for_owner']);
const LIMITS = { all: { perMinute: 30, perDay: 2000 }, propose: { perMinute: 10, perDay: 200 }, global: { perMinute: 600, perDay: 50000 } };
const LEASE_MIN = 10; const LEASE_MAX = 30;
const AUTO_PAUSE = { reverts: 3, fails: 10, windowMs: 24 * 3600 * 1000 };
const MAX_PROMPT = 20000; const MAX_REASON = 1000; const MAX_OPEN = 500;
const PROMPT_DIR = path.join(__dirname, '..', '..', 'kb-agent-prompts');
const KEY_RE = /^Bearer\s+(kbk_([a-z0-9-]{1,40})_[A-Za-z0-9_-]{30,})\s*$/;
const OWNER = { type: 'owner', id: 'owner', name: 'John (owner)', role: 'owner' };

const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const tslug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const clean = (s, n) => String(s == null ? '' : s).replace(/\r/g, '').trim().slice(0, n);
const OWNER_PREFIX = /^Owner-approved (?:answer|refund policy)[^\n]*:\s*\n+/i;
function safeWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, data, { mode: 0o600 }); fs.renameSync(tmp, file);
}
function readJson(file, fb) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fb; } }
const writeJson = (file, obj) => safeWrite(file, JSON.stringify(obj, null, 2) + '\n');
const fail = (status, error, detail) => ({ ok: false, status, error, detail });
const who = (a) => a ? { type: a.type, id: a.id, name: a.name, role: a.role } : null;

// liveLookup(tenant, slug) -> live entry { slug, title, text, aliases, source, owner_approved, enabled } or null
// listLive(tenant) -> [{ slug, title, topic, kind, owner_approved, updated }]
// gaps() -> open KB gaps [{ id, question, count, channels, last_at }]; resolveGap(id, who) marks one resolved.
function open({ dataDir, kbApiStore, liveLookup, listLive, gaps = () => [], resolveGap = () => {}, now = () => new Date(), limits = LIMITS, autoPause = AUTO_PAUSE }) {
  limits = { ...LIMITS, ...(limits || {}) };
  const root = path.join(dataDir, 'kb-api');
  const T = (t) => path.join(root, String(t).replace(/[^a-z0-9_-]/gi, ''));
  const F = {
    keys: (t) => path.join(T(t), 'swarm', 'keys.json'),
    usage: (t) => path.join(T(t), 'swarm', 'usage.json'),
    gapClaims: (t) => path.join(T(t), 'swarm', 'gap-claims.json'),
    settings: (t) => path.join(T(t), 'swarm', 'settings.json'),
    queue: (t) => path.join(T(t), 'swarm', 'queue'),
    prop: (t, id) => path.join(T(t), 'swarm', 'queue', id + '.json'),
    versions: (t, slug) => path.join(T(t), 'versions', slug + '.json'),
    prompt: (t, id) => path.join(T(t), 'prompts', id + '.json'),
    audit: (t) => path.join(T(t), 'audit.jsonl')
  };
  const iso = () => now().toISOString();
  const ms = () => now().getTime();
  const hits = new Map();

  // ---------- audit ----------
  // Change listeners (live updates in Knowledge Base Admin). A listener error never breaks a write.
  const listeners = new Set(); let seq = 0;
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function emit(t, ev) { seq++; for (const fn of listeners) { try { fn({ seq, tenant: t, at: iso(), ...ev }); } catch {} } }
  function audit(t, rec) {
    const row = { at: iso(), tenant: t, kind: 'swarm', ...rec, actor: who(rec.actor) };
    fs.mkdirSync(T(t), { recursive: true }); fs.appendFileSync(F.audit(t), JSON.stringify(row) + '\n', { mode: 0o600 });
    emit(t, { type: 'activity', action: row.action, slug: row.slug || '', proposal_id: row.proposal_id || '', actor: row.actor ? { id: row.actor.id, name: row.actor.name, role: row.actor.role } : null });
  }
  function activity(t, { limit = 200, slug, proposal, actor, before } = {}) {
    let lines = []; try { lines = fs.readFileSync(F.audit(t), 'utf8').split('\n').filter(Boolean); } catch { return []; }
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      let r; try { r = JSON.parse(lines[i]); } catch { continue; }
      if (!r || (r.kind !== 'swarm' && !r.slug)) continue;
      if (slug && r.slug !== slug) continue;
      if (proposal && r.proposal_id !== proposal) continue;
      if (before && !(String(r.at) < String(before))) continue;
      if (actor && !(r.actor && r.actor.id === actor)) continue;
      if (r.kind !== 'swarm') r = { at: r.at, kind: 'owner_api', action: r.action, slug: r.slug, actor: { type: 'owner', id: 'owner-api', name: 'Owner KB API', role: 'owner' } };
      out.push(r);
    }
    return out;
  }

  // ---------- settings ----------
  function settings(t) {
    const s = readJson(F.settings(t), null) || {};
    return { paused: !!s.paused, paused_reason: s.paused_reason || '', paused_at: s.paused_at || null, unpaused_at: s.unpaused_at || null, auto_publish: s.auto_publish === true, entries: s.entries && typeof s.entries === 'object' ? s.entries : {} };
  }
  const saveSettings = (t, s) => writeJson(F.settings(t), s);
  // Lock defaults: owner-approved entries are locked with suggestions allowed until John changes them.
  function entrySetting(t, slug, live) {
    const e = settings(t).entries[slug];
    const dflt = !!(live && live.owner_approved);
    return { locked: e && typeof e.locked === 'boolean' ? e.locked : dflt, suggestions_allowed: e && typeof e.suggestions_allowed === 'boolean' ? e.suggestions_allowed : true, is_public: e && typeof e.is_public === 'boolean' ? e.is_public : null, explicit: !!e };
  }
  // is_public (owner only): the owner's "Public on rfsafe.app/kb" toggle. It wins over the entry's own is_public flag.
  function setEntry(t, slug, { locked, suggestions_allowed, is_public }, actor = OWNER) {
    if (!kbapi.validateSlug(slug)) return fail(400, 'bad_slug');
    const s = settings(t); const cur = s.entries[slug] || {};
    if (typeof locked === 'boolean') cur.locked = locked;
    if (typeof suggestions_allowed === 'boolean') cur.suggestions_allowed = suggestions_allowed;
    if (typeof is_public === 'boolean') cur.is_public = is_public;
    cur.updated = iso(); s.entries[slug] = cur; saveSettings(t, s);
    audit(t, { action: 'entry_settings', slug, actor, locked: cur.locked, suggestions_allowed: cur.suggestions_allowed, is_public: typeof cur.is_public === 'boolean' ? cur.is_public : undefined });
    return { ok: true, slug, ...entrySetting(t, slug, liveLookup(t, slug)) };
  }
  function setPaused(t, on, actor = OWNER, reason = '') {
    const s = settings(t); s.paused = !!on;
    if (on) { s.paused_at = iso(); s.paused_reason = clean(reason, 200) || 'Paused by the owner'; } else { s.unpaused_at = iso(); s.paused_reason = ''; }
    saveSettings(t, s); audit(t, { action: on ? 'pause' : 'unpause', actor, note: s.paused_reason });
    return { ok: true, paused: s.paused, paused_reason: s.paused_reason };
  }
  function setAutoPublish(t, on, actor = OWNER) {
    const s = settings(t); s.auto_publish = !!on; saveSettings(t, s);
    audit(t, { action: on ? 'auto_publish_on' : 'auto_publish_off', actor });
    return { ok: true, auto_publish: s.auto_publish };
  }

  // ---------- keys ----------
  const keysDb = (t) => readJson(F.keys(t), {}) || {};
  const publicKey = (r) => { const { hash, ...rest } = r; return rest; };
  function createKey(t, { name, role, per_minute, daily_cost_cap, rotated_from, origin, runner }) {
    const nm = String(name || '').trim().replace(/[^\w .@-]/g, '').slice(0, 60); if (!nm) return fail(400, 'name_required');
    if (!ROLES.includes(role)) return fail(400, 'bad_role');
    const site = tslug(t); if (!site) return fail(400, 'bad_tenant');
    const db = keysDb(t);
    const id = 'kk_' + crypto.randomBytes(6).toString('hex');
    const key = 'kbk_' + site + '_' + crypto.randomBytes(24).toString('base64url');
    const pm = Number(per_minute); const cap = Number(daily_cost_cap);
    db[id] = { id, name: nm, role, tenant: t, hash: sha(key), hint: key.slice(-4), created: iso(), revoked: null, last_used: null, paused: false, disabled: false, origin: origin === 'local' ? 'local' : 'api', runner: runner ? true : undefined, model: '', per_minute: Number.isFinite(pm) && pm >= 1 && pm <= limits.all.perMinute ? Math.floor(pm) : null, daily_cost_cap: Number.isFinite(cap) && cap > 0 ? Math.round(cap * 100) / 100 : null, rotated_from: rotated_from || null };
    writeJson(F.keys(t), db);
    audit(t, { action: rotated_from ? 'key_rotated' : 'key_created', actor: OWNER, key_id: id, role, note: nm + (rotated_from ? ' (replaces ' + rotated_from + ')' : '') });
    return { ok: true, id, key, record: publicKey(db[id]) };
  }
  function rotateKey(t, id) {
    const old = keysDb(t)[id]; if (!old) return fail(404, 'not_found'); if (old.revoked) return fail(409, 'revoked');
    const r = createKey(t, { name: old.name, role: old.role, per_minute: old.per_minute, daily_cost_cap: old.daily_cost_cap, rotated_from: id, origin: old.origin });
    if (!r.ok) return r; revokeKey(t, id); return r;
  }
  function updateKey(t, id, { paused, enabled, per_minute, daily_cost_cap }) {
    const db = keysDb(t); const r = db[id]; if (!r) return fail(404, 'not_found');
    if (typeof enabled === 'boolean') { if (r.revoked) return fail(409, 'revoked', 'A revoked key stays off for good. Create a new key instead.'); r.disabled = !enabled; writeJson(F.keys(t), db); audit(t, { action: enabled ? 'key_enabled' : 'key_disabled', actor: OWNER, key_id: id, role: r.role, note: r.name }); return { ok: true, record: publicKey(r) }; }
    if (typeof paused === 'boolean') r.paused = paused;
    if (per_minute !== undefined) { const pm = Number(per_minute); r.per_minute = per_minute === null || per_minute === '' ? null : (Number.isFinite(pm) && pm >= 1 ? Math.min(Math.floor(pm), limits.all.perMinute) : r.per_minute); }
    if (daily_cost_cap !== undefined) { const c = Number(daily_cost_cap); r.daily_cost_cap = daily_cost_cap === null || daily_cost_cap === '' ? null : (Number.isFinite(c) && c > 0 ? Math.round(c * 100) / 100 : r.daily_cost_cap); }
    writeJson(F.keys(t), db); audit(t, { action: typeof paused === 'boolean' ? (paused ? 'agent_paused' : 'agent_resumed') : 'key_settings', actor: OWNER, key_id: id, role: r.role, note: r.name });
    return { ok: true, record: publicKey(r) };
  }
  function listKeys(t) { return Object.values(keysDb(t)).map(publicKey).sort((a, b) => String(b.created).localeCompare(a.created)); }
  function revokeKey(t, id) {
    const db = keysDb(t); const r = db[id]; if (!r) return fail(404, 'not_found');
    if (!r.revoked) { r.revoked = iso(); writeJson(F.keys(t), db); audit(t, { action: 'key_revoked', actor: OWNER, key_id: id, role: r.role }); }
    return { ok: true, record: publicKey(r) };
  }
  // A valid, unrevoked key of this tenant -> actor { type:'key', id, name, role }; anything else -> null.
  function verify(t, header) {
    const m = String(header || '').match(KEY_RE); if (!m || m[2] !== tslug(t)) return null;
    const h = Buffer.from(sha(m[1]), 'hex'); let found = null;
    for (const r of Object.values(keysDb(t))) { const x = Buffer.from(String(r.hash || ''), 'hex'); if (x.length === h.length && crypto.timingSafeEqual(x, h)) found = r; }
    if (!found || found.revoked || !ROLES.includes(found.role)) return null;
    return { type: 'key', id: found.id, name: found.name, role: found.role, origin: found.origin || 'api', disabled: !!found.disabled, paused: !!found.paused, per_minute: found.per_minute || null, daily_cost_cap: found.daily_cost_cap || null };
  }
  function touch(t, id) { const db = keysDb(t); if (db[id]) { db[id].last_used = iso(); writeJson(F.keys(t), db); } }
  // Sliding windows per key: every request counts toward "all"; proposals also count toward "propose".
  function allow(id, bucket = 'all', perMinute) {
    const lim = { ...(limits[bucket] || limits.all) }; if (perMinute) lim.perMinute = Math.min(lim.perMinute, perMinute); const k = bucket + ':' + id; const t = ms();
    const a = (hits.get(k) || []).filter((x) => t - x < 86400000);
    if (a.filter((x) => t - x < 60000).length >= lim.perMinute || a.length >= lim.perDay) { hits.set(k, a); return false; }
    a.push(t); hits.set(k, a); return true;
  }

  // ---------- self-reported usage (tokens and cost per day) ----------
  const today = () => iso().slice(0, 10);
  function reportUsage(t, actor, b = {}) {
    const n = (x) => { const v = Number(x); return Number.isFinite(v) && v >= 0 ? v : 0; };
    const tin = Math.min(n(b.tokens_in), 1e8); const tout = Math.min(n(b.tokens_out), 1e8); const cost = Math.min(n(b.cost_usd), 1000);
    const db = readJson(F.usage(t), {}) || {}; const d = (db[actor.id] = db[actor.id] || {}); const day = (d[today()] = d[today()] || { tokens_in: 0, tokens_out: 0, cost_usd: 0, reports: 0 });
    day.tokens_in += tin; day.tokens_out += tout; day.cost_usd = Math.round((day.cost_usd + cost) * 1e6) / 1e6; day.reports++;
    for (const k of Object.keys(d).sort().slice(0, -31)) delete d[k];
    writeJson(F.usage(t), db);
    const model = clean(b.model, 80).replace(/[^\w .:/@+-]/g, '');
    if (model) { const kd = keysDb(t); if (kd[actor.id]) { kd[actor.id].model = model; writeJson(F.keys(t), kd); } }
    return { ok: true, today: day };
  }
  function usageToday(t, id) { const db = readJson(F.usage(t), {}) || {}; return (db[id] && db[id][today()]) || { tokens_in: 0, tokens_out: 0, cost_usd: 0, reports: 0 }; }
  function usageDays(t, id, days = 14) { const db = readJson(F.usage(t), {}) || {}; const d = db[id] || {}; return Object.keys(d).sort().reverse().slice(0, days).map((k) => ({ date: k, ...d[k] })); }
  function capReached(t, actor) { return !!(actor.daily_cost_cap && usageToday(t, actor.id).cost_usd >= actor.daily_cost_cap); }
  // Agents page: one row per key with status, today's actions, pass/reject rates and self-reported usage.
  function agents(t) {
    const rows = activity(t, { limit: 5000 }); const day = today(); const stat = new Map();
    for (const r of rows) {
      if (!r.actor || r.actor.type !== 'key') continue;
      const x = stat.get(r.actor.id) || { today: 0, total: 0, passes: 0, fails: 0, published: 0, rejected: 0, blocked: 0 };
      x.total++; if (String(r.at).slice(0, 10) === day) x.today++;
      if (r.pass === true) x.passes++; if (r.pass === false) x.fails++;
      if (r.action === 'publish') x.published++; if (r.action === 'reject') x.rejected++; if (r.fail && r.pass === undefined) x.blocked++;
      stat.set(r.actor.id, x);
    }
    const props = listProposals(t); const byProposer = new Map();
    for (const p of props) { const id = p.actors.proposer && p.actors.proposer.id; if (!id) continue; const x = byProposer.get(id) || { proposed: 0, published: 0, rejected: 0 }; x.proposed++; if (p.status === 'published') x.published++; if (p.status === 'rejected') x.rejected++; byProposer.set(id, x); }
    return listKeys(t).map((k) => { const s = stat.get(k.id) || { today: 0, total: 0, passes: 0, fails: 0, published: 0, rejected: 0, blocked: 0 }; const bp = byProposer.get(k.id); const reviews = s.passes + s.fails;
      return { ...k, origin: k.origin || 'api', enabled: !k.disabled && !k.revoked, status: k.revoked ? 'revoked' : k.disabled ? 'disabled' : k.paused ? 'paused' : 'active', actions_today: s.today, actions_total: s.total,
        pass_rate: reviews ? Math.round(100 * s.passes / reviews) : null, reject_rate: reviews ? Math.round(100 * s.fails / reviews) : null,
        proposals: bp || null, published: s.published, rejected: s.rejected, blocked: s.blocked, usage_today: usageToday(t, k.id), cap_reached: !!(k.daily_cost_cap && usageToday(t, k.id).cost_usd >= k.daily_cost_cap) }; });
  }

  // ---------- claims (leases) ----------
  const leaseMs = (m) => Math.max(1, Math.min(LEASE_MAX, Number(m) || LEASE_MIN)) * 60000;
  const live_ = (c) => c && Date.parse(c.until) > ms();
  function slotFor(role) { return role === 'review_improvement' ? 'improvement' : role === 'review_accuracy' ? 'accuracy' : role === 'publish' ? 'publisher' : null; }
  function needsRole(p, role, st) {
    if (role === 'review_improvement' || role === 'review_accuracy') { const sl = slotFor(role); const rv = p.reviews[sl]; return p.status === 'in_review' && !(rv && rv.rev === p.rev); }
    if (role === 'publish') return p.status === 'ready' && st.auto_publish;
    return false;
  }
  function claim(t, actor, id, minutes) {
    const p = getProposal(t, id); if (!p) return fail(404, 'not_found');
    if (!needsRole(p, actor.role, settings(t))) return fail(409, 'nothing_to_do', 'This proposal does not need a ' + ROLE_LABEL[actor.role] + ' right now.');
    if (holdsOtherSlot(p, actor, slotFor(actor.role))) return fail(403, 'same_key_two_roles', 'One key cannot fill two roles on the same change.');
    p.claims = p.claims || {}; const c = p.claims[actor.role];
    if (live_(c) && c.by.id !== actor.id) return fail(409, 'claimed', 'Claimed by another agent until ' + c.until);
    // The decision lease covers every competing suggestion in the thread, so two decision bots never race.
    if (actor.role === 'publish') for (const x of siblings(t, p)) { const xc = x.claims && x.claims.publish; if (live_(xc) && xc.by.id !== actor.id) return fail(409, 'claimed', 'Another decision bot holds this thread until ' + xc.until); }
    const lease = { by: who(actor), until: new Date(ms() + leaseMs(minutes)).toISOString() };
    p.claims[actor.role] = lease; writeJson(F.prop(t, p.id), p);
    if (actor.role === 'publish') for (const x of siblings(t, p)) { x.claims = x.claims || {}; x.claims.publish = lease; writeJson(F.prop(t, x.id), x); } audit(t, { action: 'claim', slug: p.slug, proposal_id: id, actor, note: 'until ' + p.claims[actor.role].until });
    return { ok: true, claim: p.claims[actor.role], proposal: p };
  }
  function claimBlock(p, actor) { const c = p.claims && p.claims[actor.role]; return live_(c) && c.by.id !== actor.id ? fail(409, 'claimed', 'Another agent holds the claim until ' + c.until) : null; }
  function release(p, role) { if (p.claims) delete p.claims[role]; }
  function available(t, actor, { limit = 50 } = {}) {
    const st = settings(t);
    if (actor.role === 'propose') { const gc = readJson(F.gapClaims(t), {}) || {}; return { gaps: openGaps(t).filter((g) => !live_(gc[g.id]) || gc[g.id].by.id === actor.id).slice(0, limit), proposals: [] }; }
    return { gaps: [], proposals: listProposals(t).filter((p) => needsRole(p, actor.role, st) && !claimBlock(p, actor) && !holdsOtherSlot(p, actor, slotFor(actor.role))).reverse().slice(0, limit) };
  }
  // KB gaps (unanswered questions) open and not already covered by an open proposal.
  function openGaps(t) {
    let list = []; try { list = gaps(t) || []; } catch { list = []; }
    const covered = new Set(listProposals(t).filter((p) => p.gap_id && OPEN.has(p.status)).map((p) => p.gap_id));
    const gc = readJson(F.gapClaims(t), {}) || {};
    return list.filter((g) => g.status === 'open' && !covered.has(g.id)).map((g) => ({ id: g.id, question: g.question, count: g.count, channels: g.channels || [], last_at: g.last_at, first_at: g.first_at, claim: live_(gc[g.id]) ? gc[g.id] : null }));
  }
  function claimGap(t, actor, gapId, minutes) {
    if (actor.role !== 'propose') return fail(403, 'wrong_role');
    if (!openGaps(t).some((g) => g.id === gapId)) return fail(404, 'not_found');
    const gc = readJson(F.gapClaims(t), {}) || {}; const c = gc[gapId];
    if (live_(c) && c.by.id !== actor.id) return fail(409, 'claimed', 'Claimed by another agent until ' + c.until);
    gc[gapId] = { by: who(actor), until: new Date(ms() + leaseMs(minutes)).toISOString() };
    for (const k of Object.keys(gc)) if (!live_(gc[k])) delete gc[k];
    writeJson(F.gapClaims(t), gc); audit(t, { action: 'claim_gap', actor, gap_id: gapId, note: 'until ' + gc[gapId].until });
    return { ok: true, claim: gc[gapId] };
  }

  // ---------- versions ----------
  function versions(t, slug) { return (readJson(F.versions(t, slug), null) || { versions: [] }).versions; }
  function snapshotOf(e) { return { title: e.title || '', text: String(e.text || '').replace(OWNER_PREFIX, ''), aliases: e.aliases || '', source: e.source || '', owner_approved: !!e.owner_approved, enabled: e.enabled !== false }; }
  function recordVersion(t, slug, after, meta = {}, before) {
    const doc = readJson(F.versions(t, slug), null) || { slug, versions: [] };
    if (!doc.versions.length && before) doc.versions.push({ v: 1, at: iso(), action: 'baseline', ...snapshotOf(before), why: 'Live wording before the first tracked change', published_by: null });
    const v = (doc.versions.length ? doc.versions[doc.versions.length - 1].v : 0) + 1;
    const rec = { v, at: iso(), ...snapshotOf(after), backup: after.backup || null, ...meta };
    doc.versions.push(rec); writeJson(F.versions(t, slug), doc);
    return rec;
  }

  // ---------- proposals ----------
  function getProposal(t, id) { return /^p_[a-f0-9]{12}$/.test(String(id || '')) ? readJson(F.prop(t, id), null) : null; }
  function listProposals(t) {
    let names = []; try { names = fs.readdirSync(F.queue(t)).filter((n) => n.endsWith('.json')); } catch { return []; }
    return names.map((n) => readJson(path.join(F.queue(t), n), null)).filter(Boolean).sort((a, b) => String(b.updated).localeCompare(a.updated));
  }
  const saveProposal = (t, p) => { p.updated = iso(); writeJson(F.prop(t, p.id), p); };
  function pendingFor(t, slug) { return listProposals(t).filter((p) => p.slug === slug && OPEN.has(p.status)).length; }
  const thread = (p, action, actor, extra = {}) => { p.thread.push({ at: iso(), action, by: who(actor), ...extra }); if (!actor || actor.type !== 'owner') p.read = false; };

  // Count recent reverts and failures; switch the kill switch on when either spikes.
  function autoPauseCheck(t) {
    const s = settings(t); if (s.paused) return false;
    const since = Math.max(ms() - autoPause.windowMs, s.unpaused_at ? Date.parse(s.unpaused_at) : 0);
    let reverts = 0; let fails = 0;
    for (const r of activity(t, { limit: 2000 })) {
      if (Date.parse(r.at) <= since) break;
      if (r.kind !== 'swarm') continue;
      if (r.action === 'revert') reverts++;
      if (r.fail) fails++;
    }
    const why = reverts >= autoPause.reverts ? reverts + ' reverts' : fails >= autoPause.fails ? fails + ' failed or blocked agent actions' : '';
    if (!why) return false;
    s.paused = true; s.paused_at = iso(); s.paused_reason = 'Auto-paused: ' + why + ' in 24 hours'; saveSettings(t, s);
    audit(t, { action: 'auto_pause', actor: { type: 'system', id: 'auto-pause', name: 'Auto-pause', role: 'system' }, note: s.paused_reason });
    return true;
  }
  function failed(t, rec) { audit(t, { ...rec, fail: true }); autoPauseCheck(t); }

  // slug -> owner's public toggle (only entries where the owner set one). Read by the public page at /kb.
  function visibility(t) { const out = {}; const e = settings(t).entries || {}; for (const k of Object.keys(e)) if (e[k] && typeof e[k].is_public === 'boolean') out[k] = e[k].is_public; return out; }
  function lockState(t, slug) { const live = liveLookup(t, slug); return { live, ...entrySetting(t, slug, live) }; }

  function propose(t, actor, body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'invalid_json');
    const slug = String(body.slug || '').trim();
    if (!kbapi.validateSlug(slug)) return fail(400, 'bad_slug', 'slug must be 2-80 chars, lowercase letters, digits and hyphens');
    const { live, locked, suggestions_allowed } = lockState(t, slug);
    if (locked && !suggestions_allowed) { failed(t, { action: 'propose_blocked', slug, actor, note: 'entry_locked' }); return fail(403, 'entry_locked', 'This entry is locked and does not accept suggestions.'); }
    const base = live ? snapshotOf(live) : null;
    const n = kbapi.normalizeEntry({ ...body, owner_approved: false, enabled: true }, { slug, existing: base ? { ...base, slug } : null });
    if (n.error) return fail(400, n.error, n.detail);
    const visChange = typeof n.entry.is_public === 'boolean' && n.entry.is_public !== (live && typeof live.is_public === 'boolean' ? live.is_public : true);
    if (base && !visChange && n.entry.text === base.text && n.entry.title === base.title && n.entry.aliases === base.aliases && n.entry.source === base.source) return fail(400, 'no_change', 'The proposal matches the live entry.');
    if (listProposals(t).filter((p) => OPEN.has(p.status)).length >= MAX_OPEN) return fail(429, 'queue_full');
    if (n.entry.gap_id) { const gc = readJson(F.gapClaims(t), {}) || {}; const c = gc[n.entry.gap_id]; if (live_(c) && c.by.id !== actor.id) return fail(409, 'claimed', 'Another agent is answering this gap.'); if (c) { delete gc[n.entry.gap_id]; writeJson(F.gapClaims(t), gc); } }
    const id = 'p_' + crypto.randomBytes(6).toString('hex');
    const p = {
      id, slug, kind: base ? 'edit' : 'new', title: n.entry.title, text: n.entry.text, aliases: n.entry.aliases, source: n.entry.source,
      ...(typeof n.entry.is_public === 'boolean' ? { is_public: n.entry.is_public } : {}),
      gap_id: n.entry.gap_id, rationale: clean(body.rationale, MAX_REASON), summary: clean(body.summary, 140).replace(/\n+/g, ' ') || clean(String(body.rationale || '').split(/(?<=[.!?])\s/)[0], 140).replace(/\n+/g, ' ') || (base ? 'Wording change' : 'New entry'),
      read: false, claims: {}, thread_key: slug + ':' + (base ? kbapi.textHash(base.text) : 'new'),
      base: base ? { ...base, hash: kbapi.textHash(base.text) } : null,
      status: locked ? 'for_owner' : 'in_review', locked_entry: !!locked, rev: 1,
      actors: { proposer: who(actor), improvement: null, accuracy: null, publisher: null },
      reviews: { improvement: null, accuracy: null }, decision: null, created: iso(), updated: iso(), thread: []
    };
    thread(p, 'propose', actor, { rev: 1, note: p.rationale });
    saveProposal(t, p); audit(t, { action: 'propose', slug, proposal_id: id, actor, rev: 1, text_hash: kbapi.textHash(p.text), note: locked ? 'for_owner' : '' });
    return { ok: true, proposal: p };
  }
  function update(t, actor, id, body = {}) {
    const p = getProposal(t, id); if (!p) return fail(404, 'not_found');
    if (!OPEN.has(p.status)) return fail(409, 'not_open', 'Only open proposals can be updated.');
    if (actor.type === 'key' && (!p.actors.proposer || p.actors.proposer.id !== actor.id)) return fail(403, 'not_your_proposal', p.kind === 'merge' ? 'A merge cannot be edited; merge again instead.' : undefined);
    const { locked, suggestions_allowed } = lockState(t, p.slug);
    if (actor.type === 'key' && locked && !suggestions_allowed) return fail(403, 'entry_locked');
    const n = kbapi.normalizeEntry({ ...body, slug: p.slug, owner_approved: false, enabled: true }, { slug: p.slug, existing: { ...p } });
    if (n.error) return fail(400, n.error, n.detail);
    Object.assign(p, { title: n.entry.title, text: n.entry.text, aliases: n.entry.aliases, source: n.entry.source, rev: p.rev + 1, status: locked ? 'for_owner' : 'in_review', locked_entry: !!locked });
    if (typeof n.entry.is_public === 'boolean') p.is_public = n.entry.is_public;
    if (body.rationale != null) p.rationale = clean(body.rationale, MAX_REASON);
    p.reviews = { improvement: null, accuracy: null }; p.actors.improvement = null; p.actors.accuracy = null; p.claims = {};
    if (body.summary != null) p.summary = clean(body.summary, 140).replace(/\n+/g, ' ') || p.summary;
    thread(p, 'update', actor, { rev: p.rev, note: clean(body.note || body.rationale, MAX_REASON) });
    saveProposal(t, p); audit(t, { action: 'update', slug: p.slug, proposal_id: id, actor, rev: p.rev, text_hash: kbapi.textHash(p.text) });
    return { ok: true, proposal: p };
  }
  // Separation of duties: the acting key may not hold any other slot on this proposal.
  // The decision bot that wrote a merge may still publish it (merging is part of deciding); it may not review it.
  function holdsOtherSlot(p, actor, slot) {
    return Object.entries(p.actors).some(([s, a]) => s !== slot && !(s === 'merger' && slot === 'publisher') && a && a.type === 'key' && a.id === actor.id);
  }
  // Competing suggestions: open proposals on the same entry opened against the same live wording.
  const keyOf = (p) => p.thread_key || (p.slug + ':' + (p.base ? p.base.hash : 'new'));
  function siblings(t, p, { open = true } = {}) { const k = keyOf(p); return listProposals(t).filter((x) => x.id !== p.id && keyOf(x) === k && (!open || OPEN.has(x.status))); }
  const passed = (x) => x.status === 'ready' && x.reviews.improvement && x.reviews.accuracy && x.reviews.improvement.pass && x.reviews.accuracy.pass && x.reviews.improvement.rev === x.rev && x.reviews.accuracy.rev === x.rev;
  // After one suggestion is published, every other open suggestion in the thread is closed as not chosen.
  function supersede(t, chosen, actor, reason) {
    for (const x of siblings(t, chosen)) {
      x.status = 'rejected'; x.claims = {}; x.decision = { action: 'superseded', by: who(actor), at: iso(), chosen: chosen.id, reason: 'Not chosen. ' + (chosen.id) + ' was published' + (reason ? ': ' + clean(reason, 600) : '.') };
      thread(x, 'superseded', actor, { rev: x.rev, note: x.decision.reason, chosen: chosen.id }); if (actor.type === 'owner') x.read = true;
      saveProposal(t, x); audit(t, { action: 'superseded', slug: x.slug, proposal_id: x.id, actor, note: 'chosen ' + chosen.id });
    }
  }
  // Decision bot merge: a new suggestion built from two or more passed suggestions. It inherits their improvement
  // passes but needs a fresh accuracy review on its own text before it can be published.
  function merge(t, actor, body = {}) {
    if (actor.role !== 'publish') return fail(403, 'wrong_role');
    const ids = Array.isArray(body.from) ? [...new Set(body.from.map(String))].slice(0, 10) : [];
    if (ids.length < 2) return fail(400, 'from_required', 'List two or more passed suggestions in "from".');
    const src = ids.map((id) => getProposal(t, id)); if (src.some((x) => !x)) return fail(404, 'not_found');
    const k = keyOf(src[0]); if (src.some((x) => keyOf(x) !== k)) return fail(400, 'different_threads', 'Merged suggestions must be on the same entry and the same live wording.');
    if (!src.every(passed)) return fail(409, 'reviews_incomplete', 'Only suggestions that passed both reviews can be merged.');
    if (src.some((x) => holdsOtherSlot(x, actor, 'publisher'))) return fail(403, 'same_key_two_roles', 'One key cannot fill two roles on the same change.');
    const { live, locked } = lockState(t, src[0].slug);
    if (locked) { failed(t, { action: 'merge_blocked', slug: src[0].slug, actor, note: 'entry_locked' }); return fail(403, 'entry_locked'); }
    const liveHash = live ? kbapi.textHash(snapshotOf(live).text) : null;
    if ((src[0].base ? src[0].base.hash : null) !== liveHash) return fail(409, 'live_changed');
    const reason = clean(body.reason, MAX_REASON); if (reason.length < 10) return fail(400, 'reason_required', 'Explain what the merge keeps from each suggestion.');
    const first = src[0];
    const n = kbapi.normalizeEntry({ title: body.title ?? first.title, text: body.text, aliases: body.aliases ?? first.aliases, source: body.source ?? first.source, slug: first.slug, owner_approved: false, enabled: true, gap_id: first.gap_id || '' }, { slug: first.slug });
    if (n.error) return fail(400, n.error, n.detail);
    const id = 'p_' + crypto.randomBytes(6).toString('hex');
    const p = {
      id, slug: first.slug, kind: 'merge', merged_from: ids, title: n.entry.title, text: n.entry.text, aliases: n.entry.aliases, source: n.entry.source, gap_id: first.gap_id || '',
      rationale: reason, summary: 'Merge of ' + ids.length + ' suggestions', read: false, claims: {}, thread_key: k, base: first.base, status: 'in_review', locked_entry: false, rev: 1,
      actors: { proposer: null, merger: who(actor), improvement: null, accuracy: null, publisher: null },
      reviews: { improvement: { pass: true, inherited: true, reason: 'Inherited from the passed suggestions ' + ids.join(', '), rev: 1, at: iso(), by: who(actor) }, accuracy: null },
      decision: null, created: iso(), updated: iso(), thread: []
    };
    thread(p, 'merge', actor, { rev: 1, note: reason, from: ids });
    saveProposal(t, p); audit(t, { action: 'merge', slug: p.slug, proposal_id: id, actor, rev: 1, note: 'from ' + ids.join(','), text_hash: kbapi.textHash(p.text) });
    return { ok: true, proposal: p };
  }
  function review(t, actor, id, body = {}) {
    const p = getProposal(t, id); if (!p) return fail(404, 'not_found');
    const role = actor.role; const slot = SLOTS[role];
    if (slot !== 'improvement' && slot !== 'accuracy') return fail(403, 'wrong_role');
    if (p.status === 'for_owner') return fail(403, 'owner_only', 'Suggestions on locked entries go to the owner only.');
    if (!['in_review', 'ready'].includes(p.status)) return fail(409, 'not_open');
    if (holdsOtherSlot(p, actor, slot)) { failed(t, { action: 'review_blocked', slug: p.slug, proposal_id: id, actor, note: 'same_key_two_roles' }); return fail(403, 'same_key_two_roles', 'One key cannot fill two roles on the same change.'); }
    if (body.rev != null && Number(body.rev) !== p.rev) return fail(409, 'stale_rev', 'The proposal changed. Read rev ' + p.rev + ' and review again.');
    { const cb = claimBlock(p, actor); if (cb) return cb; }
    { const rv = p.reviews[slot]; if (rv && rv.rev === p.rev && !rv.inherited) return fail(409, 'already_reviewed', 'This rev already has its ' + slot + ' review.'); }
    if (slot === 'improvement' && p.kind === 'merge') return fail(409, 'nothing_to_do', 'A merge inherits its improvement passes; it needs only the accuracy check.');
    if (typeof body.pass !== 'boolean') return fail(400, 'pass_required', 'pass must be true or false');
    const reason = clean(body.reason, MAX_REASON); if (reason.length < 3) return fail(400, 'reason_required');
    const { locked } = lockState(t, p.slug);
    if (locked) return fail(403, 'entry_locked', 'The entry was locked after this proposal was opened.');
    p.actors[slot] = who(actor);
    p.reviews[slot] = { pass: body.pass, reason, rev: p.rev, at: iso(), by: who(actor) }; release(p, role);
    thread(p, role, actor, { rev: p.rev, pass: body.pass, note: reason });
    if (!body.pass) { p.status = 'rejected'; p.decision = { action: 'rejected', by: who(actor), at: iso(), reason: (slot === 'improvement' ? 'Improvement review failed: ' : 'Accuracy review failed: ') + reason }; }
    else if (p.reviews.improvement && p.reviews.accuracy && p.reviews.improvement.pass && p.reviews.accuracy.pass && p.reviews.improvement.rev === p.rev && p.reviews.accuracy.rev === p.rev) p.status = 'ready';
    saveProposal(t, p);
    if (body.pass) audit(t, { action: role, slug: p.slug, proposal_id: id, actor, rev: p.rev, pass: true, note: reason });
    else failed(t, { action: role, slug: p.slug, proposal_id: id, actor, rev: p.rev, pass: false, note: reason });
    return { ok: true, proposal: p };
  }
  // Writes the proposal live through the owner KB API store (backup + entry file); the caller resets the KB index.
  function writeLive(t, p, actor, ownerApproved, why) {
    const live = liveLookup(t, p.slug);
    const r = kbApiStore.put(t, { slug: p.slug, title: p.title, text: p.text, aliases: p.aliases, source: p.source, gap_id: p.gap_id || '', owner_approved: ownerApproved, enabled: true, ...(typeof p.is_public === 'boolean' ? { is_public: p.is_public } : {}) }, p.slug);
    if (!r.ok) return r;
    const ver = recordVersion(t, p.slug, { ...r.entry, backup: null }, {
      action: actor.type === 'owner' ? 'owner_publish' : 'publish', proposal_id: p.id, rev: p.rev,
      proposed_by: p.actors.proposer, improvement_review: p.reviews.improvement, accuracy_review: p.reviews.accuracy,
      published_by: who(actor), why: clean(why, MAX_REASON) || clean(p.rationale, MAX_REASON)
    }, live);
    return { ok: true, entry: r.entry, version: ver };
  }
  function publish(t, actor, id, body = {}) {
    const p = getProposal(t, id); if (!p) return fail(404, 'not_found');
    if (actor.role !== 'publish') return fail(403, 'wrong_role');
    if (!settings(t).auto_publish) return fail(403, 'auto_publish_off', 'Agent publishing is off. The owner publishes from Knowledge Base Admin.');
    if (p.status === 'for_owner') return fail(403, 'owner_only');
    if (holdsOtherSlot(p, actor, 'publisher')) { failed(t, { action: 'publish_blocked', slug: p.slug, proposal_id: id, actor, note: 'same_key_two_roles' }); return fail(403, 'same_key_two_roles', 'One key cannot fill two roles on the same change.'); }
    if (body.rev != null && Number(body.rev) !== p.rev) return fail(409, 'stale_rev');
    { const cb = claimBlock(p, actor); if (cb) return cb; }
    const ri = p.reviews.improvement; const ra = p.reviews.accuracy;
    if (p.status !== 'ready' || !ri || !ra || !ri.pass || !ra.pass || ri.rev !== p.rev || ra.rev !== p.rev) return fail(409, 'reviews_incomplete', 'Both reviews must pass on the same rev before publishing.');
    const { live, locked } = lockState(t, p.slug);
    if (locked) { failed(t, { action: 'publish_blocked', slug: p.slug, proposal_id: id, actor, note: 'entry_locked' }); return fail(403, 'entry_locked'); }
    const liveHash = live ? kbapi.textHash(snapshotOf(live).text) : null;
    if ((p.base ? p.base.hash : null) !== liveHash) return fail(409, 'live_changed', 'The live entry changed after this proposal was opened. Reject it and propose again.');
    const rivals = siblings(t, p).filter(passed);
    const why = clean(body.reason || body.note, MAX_REASON);
    if ((rivals.length || p.kind === 'merge') && why.length < 10) return fail(400, 'reason_required', 'Other suggestions passed too. Say why this one is better (reason).');
    p.actors.publisher = who(actor);
    const w = writeLive(t, p, actor, false, why);
    if (!w.ok) return w;
    p.status = 'published'; release(p, 'publish'); p.decision = { action: 'published', by: who(actor), at: iso(), reason: why, version: w.version.v, compared: rivals.map((x) => x.id), merged_from: p.merged_from || [] };
    supersede(t, p, actor, why);
    if (p.gap_id) { try { resolveGap(p.gap_id, 'kb-admin ' + actor.id); } catch {} }
    thread(p, 'publish', actor, { rev: p.rev, note: why, version: w.version.v, compared: p.decision.compared });
    saveProposal(t, p); audit(t, { action: 'publish', slug: p.slug, proposal_id: id, actor, rev: p.rev, version: w.version.v, text_hash: kbapi.textHash(p.text) });
    return { ok: true, proposal: p, entry: w.entry, version: w.version };
  }
  function reject(t, actor, id, body = {}) {
    const p = getProposal(t, id); if (!p) return fail(404, 'not_found');
    if (!OPEN.has(p.status)) return fail(409, 'not_open');
    if (actor.type === 'key') {
      if (actor.role !== 'publish') return fail(403, 'wrong_role');
      if (p.status === 'for_owner') return fail(403, 'owner_only');
      if (holdsOtherSlot(p, actor, 'publisher')) return fail(403, 'same_key_two_roles', 'One key cannot fill two roles on the same change.');
      { const cb = claimBlock(p, actor); if (cb) return cb; }
      p.actors.publisher = who(actor);
    }
    const reason = clean(body.reason, MAX_REASON); if (actor.type === 'key' && reason.length < 3) return fail(400, 'reason_required');
    p.status = 'rejected'; p.claims = {}; if (actor.type === 'owner') p.read = true; p.decision = { action: 'rejected', by: who(actor), at: iso(), reason };
    thread(p, 'reject', actor, { rev: p.rev, note: reason });
    saveProposal(t, p);
    if (actor.type === 'key') failed(t, { action: 'reject', slug: p.slug, proposal_id: id, actor, rev: p.rev, note: reason });
    else audit(t, { action: 'reject', slug: p.slug, proposal_id: id, actor, rev: p.rev, note: reason });
    return { ok: true, proposal: p };
  }
  // Owner "Update": optionally edit the text, then publish now (bypasses reviews and locks; owner-approved).
  function ownerPublish(t, id, body = {}) {
    const p = getProposal(t, id); if (!p) return fail(404, 'not_found');
    if (!OPEN.has(p.status)) return fail(409, 'not_open');
    if (body.text != null || body.title != null || body.aliases != null || body.source != null) {
      const n = kbapi.normalizeEntry({ title: body.title ?? p.title, text: body.text ?? p.text, aliases: body.aliases ?? p.aliases, source: body.source ?? p.source, slug: p.slug }, { slug: p.slug });
      if (n.error) return fail(400, n.error, n.detail);
      if (n.entry.text !== p.text || n.entry.title !== p.title || n.entry.aliases !== p.aliases || n.entry.source !== p.source) {
        Object.assign(p, { title: n.entry.title, text: n.entry.text, aliases: n.entry.aliases, source: n.entry.source, rev: p.rev + 1 });
        thread(p, 'owner_edit', OWNER, { rev: p.rev, note: 'Edited by the owner before publishing' });
      }
    }
    p.actors.publisher = OWNER;
    const w = writeLive(t, p, OWNER, body.owner_approved !== false, body.note || 'Approved by the owner');
    if (!w.ok) return w;
    p.status = 'published'; p.claims = {}; p.read = true; p.decision = { action: 'published', by: OWNER, at: iso(), reason: clean(body.note, MAX_REASON) || 'Approved by the owner', version: w.version.v, compared: siblings(t, p).filter(passed).map((x) => x.id), merged_from: p.merged_from || [] };
    supersede(t, p, OWNER, p.decision.reason);
    if (p.gap_id) { try { resolveGap(p.gap_id, 'kb-admin owner'); } catch {} }
    thread(p, 'publish', OWNER, { rev: p.rev, note: p.decision.reason, version: w.version.v });
    saveProposal(t, p); audit(t, { action: 'publish', slug: p.slug, proposal_id: id, actor: OWNER, rev: p.rev, version: w.version.v, text_hash: kbapi.textHash(p.text) });
    return { ok: true, proposal: p, entry: w.entry, version: w.version };
  }
  // Revert = a new version whose content equals version v. Agents need the publish role, auto-publish on, and an unlocked entry.
  function revert(t, actor, slug, v, reason) {
    if (!kbapi.validateSlug(slug)) return fail(400, 'bad_slug');
    if (actor.type === 'key') {
      if (actor.role !== 'publish') return fail(403, 'wrong_role');
      if (!settings(t).auto_publish) return fail(403, 'auto_publish_off');
      if (lockState(t, slug).locked) { failed(t, { action: 'revert_blocked', slug, actor, note: 'entry_locked' }); return fail(403, 'entry_locked'); }
      if (clean(reason, MAX_REASON).length < 3) return fail(400, 'reason_required');
    }
    const list = versions(t, slug); const target = list.find((x) => x.v === Number(v));
    if (!target) return fail(404, 'version_not_found');
    const r = kbApiStore.put(t, { slug, title: target.title, text: target.text, aliases: target.aliases, source: target.source, owner_approved: target.owner_approved, enabled: target.enabled !== false }, slug);
    if (!r.ok) return r;
    const ver = recordVersion(t, slug, { ...r.entry, enabled: target.enabled !== false }, { action: 'revert', reverted_to: target.v, published_by: who(actor), why: clean(reason, MAX_REASON) || 'Reverted to v' + target.v });
    audit(t, { action: 'revert', slug, actor, version: ver.v, note: 'reverted to v' + target.v + (reason ? ': ' + clean(reason, 200) : '') });
    autoPauseCheck(t);
    return { ok: true, entry: r.entry, version: ver };
  }

  // One-click undo of a published proposal: a new version restoring the wording from just before it.
  function undo(t, id, reason) {
    const p = getProposal(t, id); if (!p) return fail(404, 'not_found');
    if (p.status !== 'published' || !p.decision || !p.decision.version) return fail(409, 'not_published');
    if (p.undone) return fail(409, 'already_undone');
    const list = versions(t, p.slug); const prev = list.filter((x) => x.v < p.decision.version).pop();
    if (!prev) return fail(409, 'no_earlier_version', 'This was the first version of the entry; disable it instead.');
    const r = revert(t, OWNER, p.slug, prev.v, clean(reason, 300) || 'Undo of ' + id);
    if (!r.ok) return r;
    p.undone = { at: iso(), version: r.version.v, restored: prev.v };
    thread(p, 'undo', OWNER, { version: r.version.v, note: 'Undone: restored v' + prev.v + ' as v' + r.version.v });
    p.read = true; writeJson(F.prop(t, p.id), p); p.updated = iso();
    return { ok: true, proposal: p, version: r.version, entry: r.entry };
  }
  function markRead(t, id, read = true) { const p = getProposal(t, id); if (!p) return fail(404, 'not_found'); if (p.read !== read) { p.read = read; writeJson(F.prop(t, p.id), p); } return { ok: true }; }

  // ---------- prompts ----------
  function seedText(id) { try { return fs.readFileSync(path.join(PROMPT_DIR, id + '.md'), 'utf8').trim(); } catch { return ''; } }
  function promptDoc(t, id) {
    if (!PROMPT_IDS.includes(id)) return null;
    let doc = readJson(F.prompt(t, id), null);
    if (!doc || !Array.isArray(doc.versions) || !doc.versions.length) {
      doc = { id, versions: [{ v: 1, at: iso(), by: 'seed', why: 'Starter prompt from kb-agent-prompts/' + id + '.md', text: seedText(id) }] };
      writeJson(F.prompt(t, id), doc);
    }
    return doc;
  }
  function prompt(t, id) { const d = promptDoc(t, id); if (!d) return null; const c = d.versions[d.versions.length - 1]; return { id, label: ROLE_LABEL[id], version: c.v, text: c.text, updated: c.at, by: c.by }; }
  function savePrompt(t, id, text, why, by = 'owner') {
    const d = promptDoc(t, id); if (!d) return fail(400, 'bad_prompt');
    const tx = String(text || '').replace(/\r/g, '').trim(); if (tx.length < 20 || tx.length > MAX_PROMPT) return fail(400, 'bad_text', 'Prompt must be 20-' + MAX_PROMPT + ' characters.');
    const v = d.versions[d.versions.length - 1].v + 1;
    d.versions.push({ v, at: iso(), by, why: clean(why, 300) || 'Edited by the owner', text: tx }); writeJson(F.prompt(t, id), d);
    audit(t, { action: 'prompt_saved', actor: OWNER, prompt: id, version: v, text_hash: kbapi.textHash(tx) });
    return { ok: true, prompt: prompt(t, id) };
  }
  function revertPrompt(t, id, v) {
    const d = promptDoc(t, id); if (!d) return fail(400, 'bad_prompt');
    const target = d.versions.find((x) => x.v === Number(v)); if (!target) return fail(404, 'version_not_found');
    return savePrompt(t, id, target.text, 'Reverted to v' + target.v);
  }
  function promptHistory(t, id) { const d = promptDoc(t, id); return d ? d.versions.slice().reverse() : []; }

  // What a key can do. This list describes the server's checks; it does not grant anything.
  const ALL = 'Report your own token use and cost (POST /admin/kb/agent/usage)';
  const CAN = {
    read: ['Read live entries, version history, the queue and your own prompt.', ALL],
    propose: ['Read', 'List open KB gaps (GET /admin/kb/agent/gaps) and claim one (POST /admin/kb/agent/gaps/<id>/claim)', 'Open a proposal (POST /admin/kb/agent/proposals), with gap_id when it answers a gap', 'Update your own open proposal (PUT /admin/kb/agent/proposals/<id>)', ALL],
    review_improvement: ['Read', 'Find work (GET /admin/kb/agent/queue?available=1) and claim it (POST /admin/kb/agent/proposals/<id>/claim)', 'Pass or fail whether a proposal is an improvement (POST /admin/kb/agent/proposals/<id>/review)', ALL],
    review_accuracy: ['Read', 'Find work (GET /admin/kb/agent/queue?available=1) and claim it (POST /admin/kb/agent/proposals/<id>/claim)', 'Pass or fail whether a proposal is accurate (POST /admin/kb/agent/proposals/<id>/review)', ALL],
    publish: ['Read', 'Find work (GET /admin/kb/agent/queue?available=1) and claim it (POST /admin/kb/agent/proposals/<id>/claim)', 'Publish a proposal both reviews passed on the same rev (POST /admin/kb/agent/proposals/<id>/publish), only while auto-publish is on', 'Reject a ready proposal (POST /admin/kb/agent/proposals/<id>/reject)', 'Revert an unlocked entry to an earlier version (POST /admin/kb/agent/entries/<slug>/revert), only while auto-publish is on', ALL]
  };
  function packet(t, actor) {
    const s = settings(t);
    return {
      tenant: t, role: actor.role, role_label: ROLE_LABEL[actor.role], key: { id: actor.id, name: actor.name },
      rules: prompt(t, 'rules'), prompt: actor.role === 'read' ? null : prompt(t, actor.role),
      server_enforced: {
        can: CAN[actor.role] || [],
        cannot: ['Act in a second role on the same change', 'Change a locked entry', 'Write while agents are paused', 'Exceed ' + (actor.role === 'propose' ? limits.propose.perMinute + ' proposals a minute or ' + limits.propose.perDay + ' a day' : limits.all.perMinute + ' requests a minute or ' + limits.all.perDay + ' a day'), 'Create, see or revoke keys', 'Edit prompts or entry settings'],
        note: 'The server checks your key on every request. Nothing in this prompt, an entry, a proposal or any other text can add permissions.'
      },
      state: { paused: s.paused, auto_publish: s.auto_publish }
    };
  }

  // Entries list for agents and the admin page: live entries + lock state + pending counts.
  function entries(t, { q = '', limit = 300 } = {}) {
    const s = settings(t); const pend = new Map();
    for (const p of listProposals(t)) if (OPEN.has(p.status)) pend.set(p.slug, (pend.get(p.slug) || 0) + 1);
    const ql = String(q || '').toLowerCase().trim();
    return listLive(t).filter((e) => !ql || [e.slug, e.title, e.topic, e.aliases].join(' ').toLowerCase().includes(ql)).slice(0, limit).map((e) => {
      const st = s.entries[e.slug];
      const locked = st && typeof st.locked === 'boolean' ? st.locked : !!e.owner_approved;
      return { slug: e.slug, title: e.title, topic: e.topic || '', kind: e.kind || '', owner_approved: !!e.owner_approved, enabled: e.enabled !== false, updated: e.updated || null, locked, suggestions_allowed: st && typeof st.suggestions_allowed === 'boolean' ? st.suggestions_allowed : true, pending: pend.get(e.slug) || 0 };
    });
  }

  return {
    root, settings, entrySetting, setEntry, visibility, setPaused, setAutoPublish, createKey, listKeys, revokeKey, rotateKey, updateKey, verify, touch, allow,
    onChange, emit, siblings, merge, keyOf, reportUsage, usageToday, usageDays, capReached, agents, claim, claimGap, available, openGaps, undo, markRead,
    versions, recordVersion, getProposal, listProposals, pendingFor, propose, update, review, publish, reject, ownerPublish, revert,
    prompt, savePrompt, revertPrompt, promptHistory, packet, entries, activity, audit, autoPauseCheck, lockState, snapshotOf
  };
}

module.exports = { open, LEASE_MIN, LEASE_MAX, ROLES, PROMPT_IDS, ROLE_LABEL, LIMITS, AUTO_PAUSE, OWNER, sha };
