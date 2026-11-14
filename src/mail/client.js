'use strict';
// Server-side Resend reader. Two sources, merged and deduped:
//   1. Received emails  GET /emails/receiving
//   2. Inboxes          GET /inboxes -> /inboxes/{id}/threads -> /threads/{t}/emails (inbound only)
// Every message, from either source, is kept only if a to/cc/bcc recipient's domain is exactly in MAIL_DOMAINS.
const API = 'https://api.resend.com';
const FOLDERS = 'inbox,archive,spam,trash';
function domains(value) { return new Set(String(value || '').split(',').map(x => x.trim().toLowerCase()).filter(x => /^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(x))); }
function addrDomain(x) { const m = String(x || '').trim().match(/^(?:[^<>]*<)?([^<>\s@]+)@([^<>\s@]+?)>?$/); return m ? m[2].toLowerCase() : null; }
function recipients(m, allowed) { return [...(m.to || []), ...(m.cc || []), ...(m.bcc || [])].filter(x => allowed.has(addrDomain(x))).map(x => { const a = String(x).match(/([^<>\s@]+@[^<>\s@]+?)>?$/); return (a ? a[1] : String(x)).toLowerCase(); }); }
const normMid = (s) => String(s || '').trim().replace(/^<|>$/g, '').toLowerCase();
function dedupeKey(m) { return m.message_id ? 'mid:' + normMid(m.message_id) : 'fst:' + String(m.from || '').toLowerCase() + '|' + String(m.subject || '') + '|' + String(m.created_at || '').slice(0, 16); }
// Merge rows from both sources: same Resend email id, else same Message-ID, else sender+subject+minute.
function merge(rows) {
  const out = []; const byId = new Map(); const byKey = new Map();
  for (const r of rows) {
    const hit = (r.resend_id && byId.get(r.resend_id)) || byKey.get(dedupeKey(r));
    if (hit) { hit.sources = [...new Set([...hit.sources, ...r.sources])]; continue; }
    out.push(r); if (r.resend_id) byId.set(r.resend_id, r); byKey.set(dedupeKey(r), r);
  }
  return out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}
class ReceivedMail {
  constructor({ key, allowed, inboxIds, fetchImpl = globalThis.fetch, maxPages = 5, maxThreads = 100 }) {
    this.key = key; this.allowed = domains(allowed); this.fetch = fetchImpl; this.maxPages = maxPages; this.maxThreads = maxThreads;
    this.inboxIds = String(inboxIds || '').split(',').map(s => s.trim()).filter(s => /^[A-Za-z0-9-]{8,80}$/.test(s));
    this.inboxes = null; // id -> address, only inboxes whose own address is on an allowed domain
  }
  async request(path) {
    if (!this.key) throw new Error('mail_not_configured');
    const r = await this.fetch(API + path, { headers: { authorization: 'Bearer ' + this.key }, signal: AbortSignal.timeout(15000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('mail_provider_unavailable');
    return r.json();
  }
  async pages(path, limit = this.maxPages) {
    const all = []; let after = null;
    for (let i = 0; i < limit; i++) {
      const j = await this.request(path + (path.includes('?') ? '&' : '?') + 'limit=100' + (after ? '&after=' + encodeURIComponent(after) : ''));
      const d = j && Array.isArray(j.data) ? j.data : []; all.push(...d);
      if (!j || !j.has_more || !d.length) break; after = d[d.length - 1].id;
    }
    return all;
  }
  async allowedInboxes() {
    if (this.inboxes && Date.now() - this.inboxes.at < 300000) return this.inboxes.map;
    const map = new Map();
    const list = this.inboxIds.length ? await Promise.all(this.inboxIds.map(id => this.request('/inboxes/' + encodeURIComponent(id)).catch(() => null))) : await this.pages('/inboxes', 2);
    for (const ib of list) if (ib && ib.id && this.allowed.has(addrDomain(ib.email_address))) map.set(ib.id, String(ib.email_address).toLowerCase());
    this.inboxes = { at: Date.now(), map }; return map;
  }
  row(m, source, id, extra = {}) { const to = recipients(m, this.allowed); return to.length ? { id, resend_id: m.id, message_id: m.message_id || null, from: m.from || '', to, subject: m.subject || '', created_at: m.created_at || m.received_at, sources: [source], ...extra } : null; }
  async listReceived() { return (await this.pages('/emails/receiving')).map(m => this.row(m, 'received', 'r.' + m.id)).filter(Boolean); }
  async listInboxes() {
    const rows = [];
    for (const [ib] of await this.allowedInboxes()) {
      const threads = (await this.pages('/inboxes/' + ib + '/threads?folders=' + FOLDERS, 2)).slice(0, this.maxThreads);
      for (const t of threads) {
        const emails = await this.pages('/inboxes/' + ib + '/threads/' + t.id + '/emails', 2);
        for (const e of emails) if (e.direction !== 'outbound') { const r = this.row(e, 'inbox', 'i.' + ib + '.' + t.id + '.' + e.id); if (r) rows.push(r); }
      }
    }
    return rows;
  }
  // Returns { messages, errors } ; one failing source does not hide the other.
  async list() {
    if (!this.allowed.size) return { messages: [], errors: [] };
    const errors = []; const got = await Promise.all([this.listReceived(), this.listInboxes()].map(p => p.catch(e => { errors.push(e.message); return []; })));
    return { messages: merge([...got[0], ...got[1]]), errors };
  }
  async get(id) {
    if (!this.allowed.size) return null;
    let m; let p = String(id).split('.');
    if (p[0] === 'r' && p.length === 2) m = await this.request('/emails/receiving/' + encodeURIComponent(p[1]));
    else if (p[0] === 'i' && p.length === 4) {
      if (!(await this.allowedInboxes()).has(p[1])) return null;
      m = await this.request('/inboxes/' + p.slice(1, 3).map(encodeURIComponent).join('/threads/') + '/emails/' + encodeURIComponent(p[3]));
      if (m && m.direction === 'outbound') return null;
    } else return null;
    if (!m) return null;
    const to = recipients(m, this.allowed);
    return to.length ? { id, from: m.from || '', to, subject: m.subject || '', created_at: m.created_at || m.received_at, html: m.html || '', text: m.text || '' } : null;
  }
}
module.exports = { domains, recipients, addrDomain, merge, dedupeKey, ReceivedMail };
