'use strict';
// Brain box: web research fallback (John, Nov 15 2026, 4:15 PM ET). The Brain box (the knowledge base, managed at /mail/kb)
// OWNS everything editorial about the fallback; the Mailbox only reads it and reports back:
//   DATA_DIR/kb-api/<tenant>/web-research/perspective.json  RF Safe research perspective + instructions (versioned, lockable)
//   DATA_DIR/kb-api/<tenant>/web-research/settings.json     on/off switch (default OFF) and the cost limits
//   DATA_DIR/kb-api/<tenant>/web-research/items/<id>.json   "Answered by web search" review items (one file each)
// Review items are separate from proposals. Nothing here writes to a live KB entry: the only path from a review item into
// the knowledge base is the owner's "Send to proposals" button, which opens an ordinary (unapproved) proposal that still
// needs both reviews and a publish.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SEED = path.join(__dirname, '..', '..', 'kb-agent-prompts', 'web_research.md');
// Defaults: OFF until John approves. Numbers are deliberately small; every one is clamped on save.
const DEFAULTS = Object.freeze({
  enabled: false,
  model: 'grok-4.20-0309-non-reasoning',
  max_subquestions_per_email: 2,
  max_searches_per_lookup: 4,
  max_output_tokens: 2500,
  per_email_cost_usd: 0.25,
  daily_lookups: 20,
  daily_cost_usd: 2,
  hold_for_owner: true
});
// John's production settings (Nov 15 2026, 4:48 PM ET, via Jarvis): "Turn web research on and let replies that pass the
// checker auto-send" and "The limits are fine". Applied once, live mode only, as a seed: settings.json is written only if
// none exists yet, and the write is audited as an owner-approved change. After that the file is the source of truth and
// stays editable in Brain box -> Web research (the seed never overwrites an owner edit).
const APPROVED_SEED = Object.freeze({
  id: 'john-2026-11-15-1648-et',
  note: 'Owner-approved (John, Nov 15 2026 4:48 PM ET): web research ON, auto-send only after a checker pass (hold for owner OFF); limits unchanged',
  settings: Object.freeze({ enabled: true, hold_for_owner: false, model: 'grok-4.20-0309-non-reasoning', max_subquestions_per_email: 2, max_searches_per_lookup: 4, max_output_tokens: 2500, per_email_cost_usd: 0.25, daily_lookups: 20, daily_cost_usd: 2 })
});
const LIMITS = Object.freeze({
  max_subquestions_per_email: [1, 3], max_searches_per_lookup: [1, 8], max_output_tokens: [300, 4000],
  per_email_cost_usd: [0.01, 1], daily_lookups: [0, 200], daily_cost_usd: [0, 20]
});
const MODEL_RE = /^[a-z0-9][a-z0-9.-]{1,59}$/i;
const MAX_PERSPECTIVE = 12000;
const ITEM_RE = /^w_[a-f0-9]{12}$/;

function safeWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, data, { mode: 0o600 }); fs.renameSync(tmp, file);
}
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const writeJson = (f, o) => safeWrite(f, JSON.stringify(o, null, 2) + '\n');
const fail = (status, error, detail) => ({ ok: false, status, error, detail });
const clean = (s, n) => String(s == null ? '' : s).replace(/\r/g, '').trim().slice(0, n);
const tslug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');

function normalizeSettings(cur, patch = {}) {
  const s = { ...DEFAULTS, ...(cur || {}) };
  if (typeof patch.enabled === 'boolean') s.enabled = patch.enabled;
  if (typeof patch.hold_for_owner === 'boolean') s.hold_for_owner = patch.hold_for_owner;
  if (patch.model != null) { const m = String(patch.model).trim(); if (!MODEL_RE.test(m)) return { error: 'bad_model' }; s.model = m; }
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    if (patch[k] == null) continue;
    const n = Number(patch[k]); if (!Number.isFinite(n)) return { error: 'bad_' + k };
    s[k] = Math.min(hi, Math.max(lo, /usd/.test(k) ? Math.round(n * 100) / 100 : Math.round(n)));
  }
  return { settings: s };
}

// store: the Brain box editorial store (src/kbadmin/store.js), used only for the audit log and owner-triggered proposals.
function open({ root, store, now = () => new Date(), seed = null }) {
  const T = (t) => path.join(root, String(t).replace(/[^a-z0-9_-]/gi, ''), 'web-research');
  const F = { perspective: (t) => path.join(T(t), 'perspective.json'), settings: (t) => path.join(T(t), 'settings.json'), items: (t) => path.join(T(t), 'items'), item: (t, id) => path.join(T(t), 'items', id + '.json') };
  const iso = () => now().toISOString();
  const audit = (t, rec) => { try { if (store && store.audit) store.audit(t, rec); } catch {} };
  const OWNER = { type: 'owner', id: 'owner', name: 'John (owner)', role: 'owner' };

  // ---------- perspective (owner-editable, versioned, lockable) ----------
  function doc(t) {
    let d = readJson(F.perspective(t), null);
    if (!d || !Array.isArray(d.versions) || !d.versions.length) {
      let seed = ''; try { seed = fs.readFileSync(SEED, 'utf8').trim(); } catch {}
      d = { locked: false, versions: [{ v: 1, at: iso(), by: 'seed', why: 'Starter text from kb-agent-prompts/web_research.md', text: seed }] };
      writeJson(F.perspective(t), d);
    }
    return d;
  }
  function perspective(t) { const d = doc(t); const c = d.versions[d.versions.length - 1]; return { id: 'web_research', label: 'Web research perspective', version: c.v, text: c.text, updated: c.at, by: c.by, locked: !!d.locked }; }
  function perspectiveHistory(t) { return doc(t).versions.slice().reverse(); }
  function savePerspective(t, text, why, by = 'owner') {
    const d = doc(t); if (d.locked) return fail(423, 'locked', 'The web research perspective is locked. Unlock it first.');
    const tx = String(text || '').replace(/\r/g, '').trim(); if (tx.length < 20 || tx.length > MAX_PERSPECTIVE) return fail(400, 'bad_text', 'Text must be 20-' + MAX_PERSPECTIVE + ' characters.');
    const v = d.versions[d.versions.length - 1].v + 1;
    d.versions.push({ v, at: iso(), by, why: clean(why, 300) || 'Edited by the owner', text: tx }); d.versions = d.versions.slice(-100); writeJson(F.perspective(t), d);
    audit(t, { action: 'web_perspective_saved', actor: OWNER, version: v });
    return { ok: true, perspective: perspective(t) };
  }
  function revertPerspective(t, v) {
    const d = doc(t); const target = d.versions.find((x) => x.v === Number(v)); if (!target) return fail(404, 'version_not_found');
    return savePerspective(t, target.text, 'Reverted to v' + target.v);
  }
  function setLocked(t, locked) {
    const d = doc(t); d.locked = !!locked; writeJson(F.perspective(t), d);
    audit(t, { action: locked ? 'web_perspective_locked' : 'web_perspective_unlocked', actor: OWNER });
    return { ok: true, perspective: perspective(t) };
  }

  // ---------- settings (owner only) ----------
  // One-time, idempotent: only when no settings file exists for this tenant (never overwrites an owner edit).
  function applySeed(t) {
    if (!seed || !seed.settings || fs.existsSync(F.settings(t))) return false;
    const n = normalizeSettings(null, seed.settings); if (n.error) return false;
    writeJson(F.settings(t), { ...n.settings, updated: iso(), seeded: clean(seed.id, 80) });
    audit(t, { action: 'web_research_settings', actor: OWNER, note: 'Seed ' + clean(seed.id, 80) + ': ' + clean(seed.note, 240) });
    return true;
  }
  function settings(t) { applySeed(t); return normalizeSettings(readJson(F.settings(t), null)).settings; }
  function saveSettings(t, patch) {
    applySeed(t); const n = normalizeSettings(readJson(F.settings(t), null), patch || {}); if (n.error) return fail(400, n.error);
    const s = { ...n.settings, updated: iso() }; writeJson(F.settings(t), s);
    audit(t, { action: 'web_research_settings', actor: OWNER, note: (s.enabled ? 'ON' : 'OFF') + ' · ' + s.max_subquestions_per_email + '/email · ' + s.daily_lookups + '/day · $' + s.daily_cost_usd + '/day' });
    return { ok: true, settings: settings(t) };
  }
  // What the Mailbox reads before every lookup (live, never cached in the Mailbox).
  function config(t) { const p = perspective(t); return { settings: settings(t), perspective: { version: p.version, text: p.text } }; }

  // ---------- "Answered by web search" review items ----------
  function list(t) {
    let files = []; try { files = fs.readdirSync(F.items(t)).filter((f) => /^w_[a-f0-9]{12}\.json$/.test(f)); } catch { return []; }
    return files.map((f) => readJson(path.join(F.items(t), f), null)).filter(Boolean).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  }
  function get(t, id) { return ITEM_RE.test(String(id || '')) ? readJson(F.item(t, id), null) : null; }
  const short = (s, n) => clean(s, n);
  const src = (x) => ({ claim: short(x.claim, 600), excerpt: short(x.excerpt, 800), source_url: short(x.source_url, 600), source_title: short(x.source_title, 300), source_kind: short(x.source_kind, 20), publisher: short(x.publisher, 200), paper_title: short(x.paper_title, 300), accessed_at: short(x.accessed_at, 40) });
  function logItem(t, b = {}) {
    const id = 'w_' + crypto.randomBytes(6).toString('hex');
    const it = {
      id, type: 'web_answer', status: 'new', read: false, created: iso(), updated: iso(),
      message_id: short(b.message_id, 200), email_link: short(b.email_link, 300),
      original_question: short(b.original_question, 2000), subquestion: short(b.subquestion, 300),
      outcome: ['answered', 'unresolved', 'failed'].includes(b.outcome) ? b.outcome : 'unresolved', outcome_reason: short(b.outcome_reason, 300),
      proposed_answer: short(b.proposed_answer, 2000), rf_safe_interpretation: short(b.rf_safe_interpretation, 1200),
      findings: (Array.isArray(b.findings) ? b.findings : []).slice(0, 10).map(src),
      contrary_evidence: (Array.isArray(b.contrary_evidence) ? b.contrary_evidence : []).slice(0, 6).map(src),
      directory_links: (Array.isArray(b.directory_links) ? b.directory_links : []).map((x) => short(x, 300)).filter((u) => /^https:\/\/rfsafe\.app\/research\/papers\//.test(u)).slice(0, 6),
      dropped: (Array.isArray(b.dropped) ? b.dropped : []).slice(0, 10).map((x) => ({ reason: short(x.reason, 120), source_url: short(x.source_url, 600) })),
      injection_flags: (Array.isArray(b.injection_flags) ? b.injection_flags : []).map((x) => short(x, 160)).slice(0, 10),
      checker: null, delivery: short(b.delivery, 40) || 'pending',
      search: { model: short(b.model, 60), searches: Number(b.searches) || 0, cost_usd: Math.round((Number(b.cost_usd) || 0) * 1e6) / 1e6, perspective_version: Number(b.perspective_version) || null, accessed_at: short(b.accessed_at, 40), mock: !!b.mock },
      proposal_id: null
    };
    writeJson(F.item(t, id), it);
    audit(t, { action: 'web_answer_logged', actor: { type: 'system', id: 'mailbox', name: 'Mailbox web research', role: 'system' }, note: it.outcome + ': ' + it.subquestion.slice(0, 120) });
    return { ok: true, item: it };
  }
  // The Mailbox reports the checker result and what happened to the reply. Only these fields can change.
  function updateItem(t, id, b = {}) {
    const it = get(t, id); if (!it) return fail(404, 'not_found');
    if (b.checker) it.checker = { verdict: short(b.checker.verdict, 20), notes: short(b.checker.notes, 1000), problems: (Array.isArray(b.checker.problems) ? b.checker.problems : []).map((x) => short(x, 300)).slice(0, 10), at: iso() };
    if (b.delivery) it.delivery = short(b.delivery, 40);
    if (b.draft_id) it.draft_id = short(b.draft_id, 80);
    it.updated = iso(); writeJson(F.item(t, id), it); return { ok: true, item: it };
  }
  function markRead(t, id, read = true) { const it = get(t, id); if (!it) return fail(404, 'not_found'); it.read = !!read; writeJson(F.item(t, id), it); return { ok: true }; }
  function dismiss(t, id, reason) {
    const it = get(t, id); if (!it) return fail(404, 'not_found');
    it.status = 'dismissed'; it.dismissed = { at: iso(), reason: short(reason, 300) }; it.read = true; it.updated = iso(); writeJson(F.item(t, id), it);
    audit(t, { action: 'web_answer_dismissed', actor: OWNER, note: it.subquestion.slice(0, 120) }); return { ok: true, item: it };
  }
  // Owner-only: open an ORDINARY proposal (not owner-approved) from an answered item. It goes through both reviews and a
  // publish like any other suggestion; nothing is written to a live entry here.
  function propose(t, id, b = {}) {
    const it = get(t, id); if (!it) return fail(404, 'not_found');
    if (it.outcome !== 'answered') return fail(409, 'not_answered', 'Only an answered item can become a proposal.');
    if (it.proposal_id) return fail(409, 'already_proposed');
    if (!store || typeof store.propose !== 'function') return fail(503, 'not_available');
    const slug = (b.slug && String(b.slug)) || ('web-' + tslug(it.subquestion)).slice(0, 80).replace(/-+$/, '');
    const sources = it.findings.map((f) => '- ' + (f.source_title || f.source_url) + ' — ' + f.source_url + ' (accessed ' + (f.accessed_at || it.created).slice(0, 10) + '): "' + f.excerpt + '"').join('\n');
    const text = clean(b.text, 8000) || (it.proposed_answer + '\n\nSources (found by web search, check before approving):\n' + sources + (it.contrary_evidence.length ? '\n\nContrary or complicating evidence:\n' + it.contrary_evidence.map((f) => '- ' + (f.source_title || f.source_url) + ': "' + f.excerpt + '"').join('\n') : ''));
    const actor = { type: 'system', id: 'web-research', name: 'Answered by web search', role: 'propose' };
    const r = store.propose(t, actor, { slug, title: clean(b.title, 200) || it.subquestion, text, source: (it.findings[0] && it.findings[0].source_url) || '', rationale: 'From an "answered by web search" review item (' + it.id + ') for email ' + it.message_id + '. Proposed by the owner for review.', summary: 'Web-search answer: ' + it.subquestion.slice(0, 100) });
    if (!r.ok) return r;
    it.status = 'proposed'; it.proposal_id = r.proposal.id; it.read = true; it.updated = iso(); writeJson(F.item(t, id), it);
    return { ok: true, item: it, proposal: r.proposal };
  }
  return { perspective, perspectiveHistory, savePerspective, revertPerspective, setLocked, settings, saveSettings, config, list, get, logItem, updateItem, markRead, dismiss, propose };
}

module.exports = { APPROVED_SEED, open, DEFAULTS, LIMITS, normalizeSettings, ITEM_RE };
