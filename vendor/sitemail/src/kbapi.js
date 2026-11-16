'use strict';
// Owner-only knowledge-base update API. The repo's demo/kb/rfsafe-live (and curated) cards stay the base.
// API entries live under DATA_DIR/kb-api/<tenant>/ so a redeploy does not wipe them. After each change the
// shared KB index (kbFor, used by the 291-0006 phone line and the mailbox) is reset, no restart needed.
//
// Auth: Authorization: Bearer <write key>. The server stores only SHA-256(key) in KB_API_WRITE_TOKEN_HASH
// and compares hashes with a constant-time compare. When that env is unset, every route returns 401.
//
// owner_approved defaults to true: only owner-approved entries are posted through this API. Set
// owner_approved: false on an entry if its wording should not be treated as verbatim owner-approved
// (the "Owner-approved answer (source:…):" prefix is then omitted). An explicit true or false is stored.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const symptoms = require('./kb-symptoms');

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TENANT = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const MAX_JSON = 32 * 1024;
const MAX_TITLE = 200;
const MAX_TEXT = 8000;
const MIN_TEXT = 10;
const MAX_ALIASES = 600;
const RATE_MAX = 30;
const RATE_MS = 60 * 1000;

function hashToken(raw) { return crypto.createHash('sha256').update(String(raw), 'utf8').digest(); }
function hashHex(raw) { return hashToken(raw).toString('hex'); }
function textHash(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }
function authorized(header, hashHexStored) {
  const stored = String(hashHexStored || '').trim();
  if (!stored || !/^[0-9a-f]{64}$/i.test(stored)) return false;
  const h = String(header || '');
  if (!h.startsWith('Bearer ')) return false;
  const presented = h.slice(7).trim();
  if (!presented) return false;
  const a = hashToken(presented);
  const b = Buffer.from(stored, 'hex');
  return a.length === 32 && b.length === 32 && crypto.timingSafeEqual(a, b);
}

function safeWrite(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }

function validateSlug(s) { return typeof s === 'string' && SLUG.test(s) && s.length >= 2 && s.length <= 80; }
function validateTenant(s) { return typeof s === 'string' && TENANT.test(s); }

function normalizeEntry(body, { slug, existing } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid_json', detail: 'object required' };
  const sl = String(body.slug || body.id || slug || '').trim();
  if (!validateSlug(sl)) return { error: 'bad_slug', detail: 'slug must be 2-80 chars, lowercase letters, digits and hyphens' };
  const title = String(body.title != null ? body.title : (existing && existing.title) || '').replace(/[\r\n]+/g, ' ').trim();
  if (!title || title.length > MAX_TITLE) return { error: 'bad_title', detail: 'title is required, max ' + MAX_TITLE + ' characters' };
  const text = String(body.text != null ? body.text : (existing && existing.text) || '').replace(/\r/g, '').trim();
  if (text.length < MIN_TEXT || text.length > MAX_TEXT) return { error: 'bad_text', detail: 'text must be ' + MIN_TEXT + '-' + MAX_TEXT + ' characters' };
  const aliases = String(body.aliases != null ? body.aliases : (existing && existing.aliases) || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_ALIASES);
  const source = body.source != null ? String(body.source).trim() : (existing && existing.source) || '';
  if (source && !/^https:\/\/[^\s"<>]+$/.test(source)) return { error: 'bad_source', detail: 'source must be an https URL' };
  const gapId = body.gap_id != null ? String(body.gap_id).trim() : (existing && existing.gap_id) || '';
  if (gapId && !/^[A-Za-z0-9._:-]{4,80}$/.test(gapId)) return { error: 'bad_gap_id', detail: 'gap_id must be 4-80 letters, digits, dots, underscores, colons or hyphens' };
  const sourceQuestion = body.source_question != null ? String(body.source_question).replace(/[\r\n]+/g, ' ').trim().slice(0, 300) : (existing && existing.source_question) || '';
  // Default true: only owner-approved entries are posted. An explicit boolean is stored as given.
  let ownerApproved = existing && existing.owner_approved;
  if (typeof body.owner_approved === 'boolean') ownerApproved = body.owner_approved;
  if (ownerApproved == null) ownerApproved = true;
  let enabled = existing && existing.enabled;
  if (typeof body.enabled === 'boolean') enabled = body.enabled;
  if (enabled == null) enabled = true;
  // is_public: shown on the public knowledge base at /kb (docs/PUBLIC_KB.md). Missing means public (the public page
  // still hides built-in internal entries); an explicit boolean is stored as given and kept on later updates.
  let isPublic = existing && typeof existing.is_public === 'boolean' ? existing.is_public : undefined;
  if (body.is_public != null && typeof body.is_public !== 'boolean') return { error: 'bad_is_public', detail: 'is_public must be true or false' };
  if (typeof body.is_public === 'boolean') isPublic = body.is_public;
  // Brain box symptom map (src/kb-symptoms.js): the text must parse, and the entry is off the public /kb pages unless set.
  if (symptoms.isSymptomSlug(sl)) {
    const bad = symptoms.validate(text);
    if (bad.length) return { error: 'bad_symptom_map', detail: bad.join('; ') };
    if (typeof isPublic !== 'boolean') isPublic = false;
  }
  const entry = { slug: sl, id: sl, title, text, aliases, source, owner_approved: !!ownerApproved, enabled: !!enabled, gap_id: gapId, source_question: sourceQuestion };
  if (typeof isPublic === 'boolean') entry.is_public = isPublic;
  return { entry };
}

function toMarkdown(e) {
  const fm = ['---', 'title: ' + JSON.stringify(e.title)];
  if (e.source) fm.push('source: ' + e.source);
  if (e.aliases) fm.push('aliases: ' + e.aliases);
  const map = symptoms.isSymptomSlug(e.slug);
  fm.push('page_type: ' + (map ? symptoms.TYPE : 'answer'), 'slug: ' + e.slug, 'owner_approved: ' + (e.owner_approved ? 'true' : 'false'), '---');
  const body = e.owner_approved && !map
    ? 'Owner-approved answer (source: owner-approved knowledge base entry):\n\n' + e.text
    : e.text;
  return fm.join('\n') + '\n' + body + (body.endsWith('\n') ? '' : '\n');
}

function publicEntry(e) {
  if (!e) return null;
  return { slug: e.slug, id: e.id || e.slug, title: e.title, text: e.text, aliases: e.aliases || '', source: e.source || '', owner_approved: !!e.owner_approved, enabled: !!e.enabled, updated: e.updated || null, gap_id: e.gap_id || '', source_question: e.source_question || '', is_public: typeof e.is_public === 'boolean' ? e.is_public : null };
}

function open({ dataDir, now = () => new Date() } = {}) {
  const root = path.join(dataDir, 'kb-api');
  const tenantRoot = (tenant) => path.join(root, String(tenant));
  const metaFile = (tenant, slug) => path.join(tenantRoot(tenant), 'meta', slug + '.json');
  const mdFile = (tenant, slug) => path.join(tenantRoot(tenant), 'entries', slug + '.md');
  const backupDir = (tenant, slug) => path.join(tenantRoot(tenant), 'backups', slug);
  const auditFile = (tenant) => path.join(tenantRoot(tenant), 'audit.jsonl');

  function entriesDir(tenant) { return path.join(tenantRoot(tenant), 'entries'); }
  function loadMeta(tenant, slug) { return readJson(metaFile(tenant, slug), null); }
  function listMeta(tenant) {
    const dir = path.join(tenantRoot(tenant), 'meta');
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
    return names.map((n) => loadMeta(tenant, n.slice(0, -5))).filter(Boolean).sort((a, b) => String(a.slug).localeCompare(b.slug));
  }
  function stamp(d) { return d.toISOString().replace(/[:.]/g, '-'); }
  function writeAudit(tenant, rec) {
    const line = JSON.stringify({
      at: now().toISOString(), tenant, slug: rec.slug, action: rec.action,
      text_hash: rec.text_hash || textHash(rec.text || ''),
      backup: rec.backup || null,
      gap_id: rec.gap_id || '',
      source_question: rec.source_question || ''
    }) + '\n';
    fs.mkdirSync(path.dirname(auditFile(tenant)), { recursive: true });
    fs.appendFileSync(auditFile(tenant), line, { mode: 0o600 });
  }
  function backupCurrent(tenant, slug) {
    const cur = loadMeta(tenant, slug);
    const dir = backupDir(tenant, slug);
    fs.mkdirSync(dir, { recursive: true });
    const id = stamp(now());
    const snap = cur ? { ...cur, backup_of: slug } : { slug, absent: true };
    safeWrite(path.join(dir, id + '.json'), JSON.stringify(snap, null, 2) + '\n');
    return id;
  }
  function persist(tenant, entry, action) {
    const prevBackup = backupCurrent(tenant, entry.slug);
    const rec = { ...entry, updated: now().toISOString(), backup: prevBackup };
    safeWrite(metaFile(tenant, entry.slug), JSON.stringify(rec, null, 2) + '\n');
    if (rec.enabled) safeWrite(mdFile(tenant, rec.slug), toMarkdown(rec));
    else try { fs.unlinkSync(mdFile(tenant, rec.slug)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    writeAudit(tenant, { slug: rec.slug, action, text: rec.text, backup: prevBackup, gap_id: rec.gap_id, source_question: rec.source_question });
    return rec;
  }


  function history(tenant, { limit = 100 } = {}) {
    let lines = [];
    try { lines = fs.readFileSync(auditFile(tenant), 'utf8').split('\n').filter(Boolean); } catch { return []; }
    const rows = [];
    for (const line of lines) {
      try { rows.push(JSON.parse(line)); } catch { /* skip bad line */ }
    }
    const bySlug = new Map();
    for (const r of rows) {
      if (!r || !r.slug || r.kind === 'swarm') continue; // Knowledge Base Admin rows have their own views
      const list = bySlug.get(r.slug) || [];
      list.push(r);
      bySlug.set(r.slug, list);
    }
    const current = new Map(listMeta(tenant).map((e) => [e.slug, e]));
    const out = [];
    for (const [slug, events] of bySlug) {
      const loadSnap = (id) => id ? readJson(path.join(backupDir(tenant, slug), id + '.json'), null) : null;
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const oldSnap = ev.backup ? loadSnap(ev.backup) : null;
        const later = events.slice(i + 1).find((x) => x.backup);
        const newSnap = later ? loadSnap(later.backup) : current.get(slug);
        const oldText = oldSnap && !oldSnap.absent ? String(oldSnap.text || '') : '';
        const newText = newSnap && !newSnap.absent ? String(newSnap.text || '') : (current.get(slug) && current.get(slug).text) || '';
        out.push({
          at: ev.at, slug, action: ev.action, text_hash: ev.text_hash || '',
          gap_id: ev.gap_id || (newSnap && newSnap.gap_id) || '',
          source_question: ev.source_question || (newSnap && newSnap.source_question) || '',
          title: (newSnap && newSnap.title) || (oldSnap && oldSnap.title) || slug,
          old_text: oldText, new_text: ev.action === 'disable' && !newText ? oldText : newText,
          backup: ev.backup || null
        });
      }
    }
    out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return out.slice(0, limit);
  }

  return {
    root,
    entriesDir,
    history,
    list(tenant) { return listMeta(tenant).map(publicEntry); },
    get(tenant, slug) {
      if (!validateSlug(slug)) return null;
      const e = loadMeta(tenant, slug);
      return e ? publicEntry(e) : null;
    },
    put(tenant, body, slug) {
      if (!validateTenant(tenant)) return { ok: false, status: 400, error: 'bad_tenant' };
      const existing = slug && validateSlug(slug) ? loadMeta(tenant, slug) : null;
      const n = normalizeEntry(body, { slug, existing });
      if (n.error) return { ok: false, status: 400, error: n.error, detail: n.detail };
      if (slug && n.entry.slug !== slug) return { ok: false, status: 400, error: 'slug_mismatch' };
      const action = existing ? 'update' : 'add';
      const rec = persist(tenant, n.entry, action);
      return { ok: true, action, entry: publicEntry(rec) };
    },
    disable(tenant, slug) {
      if (!validateSlug(slug)) return { ok: false, status: 400, error: 'bad_slug' };
      const existing = loadMeta(tenant, slug);
      if (!existing) return { ok: false, status: 404, error: 'not_found' };
      const rec = persist(tenant, { ...existing, enabled: false }, 'disable');
      return { ok: true, action: 'disable', entry: publicEntry(rec) };
    },
    backups(tenant, slug) {
      if (!validateSlug(slug)) return [];
      let names = [];
      try { names = fs.readdirSync(backupDir(tenant, slug)).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
      return names.map((n) => n.slice(0, -5));
    },
    undo(tenant, slug, backupId) {
      if (!validateSlug(slug)) return { ok: false, status: 400, error: 'bad_slug' };
      const ids = this.backups(tenant, slug);
      if (!ids.length) return { ok: false, status: 404, error: 'no_backup' };
      const id = backupId ? String(backupId) : ids[ids.length - 1];
      if (!ids.includes(id)) return { ok: false, status: 404, error: 'backup_not_found' };
      const snap = readJson(path.join(backupDir(tenant, slug), id + '.json'), null);
      if (!snap) return { ok: false, status: 404, error: 'backup_not_found' };
      if (snap.absent) {
        backupCurrent(tenant, slug);
        try { fs.unlinkSync(mdFile(tenant, slug)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        const disabled = { slug, id: slug, title: snap.title || slug, text: snap.text || '(removed)', aliases: '', source: '', owner_approved: true, enabled: false, updated: now().toISOString(), restored_from: id };
        safeWrite(metaFile(tenant, slug), JSON.stringify(disabled, null, 2) + '\n');
        writeAudit(tenant, { slug, action: 'undo', text: disabled.text });
        return { ok: true, action: 'undo', entry: publicEntry(disabled), restored_from: id };
      }
      const rec = persist(tenant, { ...snap, slug, id: slug }, 'undo');
      rec.restored_from = id;
      return { ok: true, action: 'undo', entry: publicEntry(rec), restored_from: id };
    }
  };
}

// Simple per-address rate limit (in process). Returns true if the request is allowed.
function rateLimit(map, key, { max = RATE_MAX, windowMs = RATE_MS, now = Date.now() } = {}) {
  const t = +now;
  const hits = (map.get(key) || []).filter((x) => t - x < windowMs);
  if (hits.length >= max) { map.set(key, hits); return false; }
  hits.push(t); map.set(key, hits); return true;
}

module.exports = {
  open, authorized, hashHex, hashToken, textHash, toMarkdown, normalizeEntry, validateSlug,
  publicEntry, rateLimit, MAX_JSON, MAX_TEXT, MIN_TEXT, RATE_MAX, RATE_MS
};
