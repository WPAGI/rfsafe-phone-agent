'use strict';
// The site's own mailbox database: one JSON file on the persistent disk (mode 600, atomic replace).
// Folder state, the move log, bot keys (hashes only), the bot call log and settings are plain; message copies,
// drafts and sent copies are sealed with MAILBOX_ENC_KEY. Nothing here ever deletes mail at Resend.
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const FOLDERS = ['inbox', 'spam', 'archive', 'drafts', 'sent', 'trash'];
const MOVABLE = ['inbox', 'spam', 'archive', 'trash'];
const DEFAULT_SETTINGS = { auto_send: false, kill_switch: false, daily_cap: 10, auto_sort_promo: true, staff_names: ['John', 'Coates'] };
const MAX_LOG = 5000;
const rid = (p) => p + crypto.randomBytes(9).toString('base64url');
class MailboxStore {
  constructor({ file, sealer, now = () => Date.now() }) {
    this.file = file; this.sealer = sealer; this.now = now;
    this.db = { v: 1, meta: {}, copies: {}, moves: [], drafts: {}, sent: {}, keys: {}, calls: [], settings: { ...DEFAULT_SETTINGS }, autosent: [], settings_log: [] };
    if (file && fs.existsSync(file)) { const d = JSON.parse(fs.readFileSync(file, 'utf8')); this.db = { ...this.db, ...d, settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) } }; }
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.db), { mode: 0o600 }); fs.renameSync(tmp, this.file);
  }
  iso() { return new Date(this.now()).toISOString(); }
  // ---- folders ----
  state(id) { const m = this.db.meta[id]; return { folder: (m && m.folder) || 'inbox', read: !!(m && m.read), sorted_by: m && m.by || null }; }
  move(id, folder, { who, why }) {
    if (!MOVABLE.includes(folder)) throw Object.assign(new Error('bad_folder'), { status: 400 });
    const prev = this.state(id); if (prev.folder === folder) return null;
    const mv = { id: rid('mv_'), msg: id, from: prev.folder, to: folder, who: String(who).slice(0, 80), why: String(why || '').slice(0, 300), at: this.iso(), undone: null };
    this.db.meta[id] = { ...(this.db.meta[id] || {}), folder, by: mv.who };
    this.db.moves.push(mv); if (this.db.moves.length > MAX_LOG) this.db.moves.splice(0, this.db.moves.length - MAX_LOG);
    this.save(); return mv;
  }
  undo(moveId, { who }) {
    const mv = this.db.moves.find(m => m.id === moveId); if (!mv) return { ok: false, reason: 'not_found' };
    if (mv.undone) return { ok: false, reason: 'already_undone' };
    if (this.state(mv.msg).folder !== mv.to) return { ok: false, reason: 'moved_since' };
    this.db.meta[mv.msg] = { ...(this.db.meta[mv.msg] || {}), folder: mv.from, by: String(who) };
    mv.undone = { who: String(who).slice(0, 80), at: this.iso() };
    const back = { id: rid('mv_'), msg: mv.msg, from: mv.to, to: mv.from, who: String(who).slice(0, 80), why: 'Undo of ' + mv.id, at: this.iso(), undone: null, undo_of: mv.id };
    this.db.moves.push(back); this.save(); return { ok: true, move: back };
  }
  markRead(id, read) { this.db.meta[id] = { ...(this.db.meta[id] || {}), read: !!read }; this.save(); }
  moves(limit = 200) { return this.db.moves.slice(-limit).reverse(); }
  // ---- sealed copies ----
  putCopy(id, msg) { this.db.copies[id] = this.sealer.seal(msg); this.save(); }
  copy(id) { const c = this.db.copies[id]; return c ? this.sealer.open(c) : null; }
  // ---- drafts ----
  createDraft(d) {
    const id = rid('d_'); const rec = { id, status: 'draft', created: this.iso(), updated: this.iso(), author: d.author, reply_to_id: d.reply_to_id || null };
    this.db.drafts[id] = { ...rec, box: this.sealer.seal({ to: d.to, subject: d.subject, body: d.body, reason: d.reason || '', notes: [] }) }; this.save(); return this.draft(id);
  }
  draft(id) { const r = this.db.drafts[id]; if (!r) return null; const { box, ...rest } = r; return { ...rest, ...this.sealer.open(box) }; }
  drafts() { return Object.keys(this.db.drafts).map(id => this.draft(id)).filter(d => d.status === 'draft' || d.status === 'held').sort((a, b) => b.updated.localeCompare(a.updated)); }
  updateDraft(id, patch, status) {
    const cur = this.draft(id); if (!cur) return null;
    const { id: _i, status: st, created, updated, author, reply_to_id, ...content } = cur;
    const next = { ...content, ...patch };
    if (patch && patch.body && cur.body && patch.body !== cur.body) {
      next.versions = [...(cur.versions || []), { at: this.iso(), body: cur.body, reason: cur.reason || null, status: cur.status }].slice(-20);
    }
    // A draft the owner discarded stays discarded: a bot step (held, sent) never brings it back.
    const keep = st === 'discarded' && status !== 'discarded';
    this.db.drafts[id] = { id, status: keep ? st : (status || st), created, updated: this.iso(), author, reply_to_id, box: this.sealer.seal(next) }; this.save(); return this.draft(id);
  }
  // ---- sent copies ----
  addSent(s) { const id = rid('s_'); this.db.sent[id] = { id, at: this.iso(), via: s.via, box: this.sealer.seal({ to: s.to, from: s.from, subject: s.subject, body: s.body, approved_by: s.approved_by, grade: s.grade || null, resend_id: s.resend_id || null, reply_to_id: s.reply_to_id || null }) }; this.save(); return this.sentCopy(id); }
  sentCopy(id) { const r = this.db.sent[id]; if (!r) return null; return { id: r.id, at: r.at, via: r.via, ...this.sealer.open(r.box) }; }
  sentList() { return Object.keys(this.db.sent).map(id => this.sentCopy(id)).sort((a, b) => b.at.localeCompare(a.at)); }
  // ---- settings ----
  settings() { return { ...this.db.settings }; }
  setSettings(patch, who) {
    const before = this.settings(); this.db.settings = { ...before, ...patch };
    this.db.settings_log.push({ at: this.iso(), who: String(who).slice(0, 80), change: patch }); this.save(); return this.settings();
  }
  autoSentToday() { const day = this.iso().slice(0, 10); this.db.autosent = this.db.autosent.filter(t => t.slice(0, 10) >= day); return this.db.autosent.filter(t => t.slice(0, 10) === day).length; }
  noteAutoSent() { this.db.autosent.push(this.iso()); this.save(); }
  // ---- bot call log ----
  logCall(c) { this.db.calls.push({ at: this.iso(), ...c }); if (this.db.calls.length > MAX_LOG) this.db.calls.splice(0, this.db.calls.length - MAX_LOG); this.save(); }
}
module.exports = { MailboxStore, FOLDERS, MOVABLE, DEFAULT_SETTINGS };
