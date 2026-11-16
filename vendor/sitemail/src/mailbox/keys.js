'use strict';
// Bot keys: one per bot and site. The raw key is shown once; only its SHA-256 is stored. Scopes: read, sort, draft.
// No scope can send, delete, see other keys, or reach the owner page (those routes do not accept bot keys at all).
const crypto = require('crypto');
const SCOPES = ['read', 'sort', 'draft'];
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const slugOf = (domain) => String(domain || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
class BotKeys {
  constructor({ store, site, now = () => Date.now(), perMinute = 30, perDay = 2000 }) { this.store = store; this.site = slugOf(site); this.now = now; this.perMinute = perMinute; this.perDay = perDay; this.hits = new Map(); }
  get db() { return this.store.db.keys; }
  create({ name, scopes }) {
    const nm = String(name || '').trim().replace(/[^\w .@-]/g, '').slice(0, 60); if (!nm) return { ok: false, reason: 'name_required' };
    const sc = [...new Set((Array.isArray(scopes) ? scopes : String(scopes || '').split(',')).map(s => String(s).trim()).filter(Boolean))];
    if (!sc.length || sc.some(s => !SCOPES.includes(s))) return { ok: false, reason: 'bad_scopes' };
    if (!this.site) return { ok: false, reason: 'no_site' };
    const id = 'bk_' + crypto.randomBytes(6).toString('hex');
    const key = 'mbk_' + this.site + '_' + crypto.randomBytes(24).toString('base64url');
    this.db[id] = { id, name: nm, site: this.site, scopes: sc, hash: sha(key), hint: key.slice(-4), created: new Date(this.now()).toISOString(), revoked: null, last_used: null };
    this.store.save(); return { ok: true, id, key, record: this.public(this.db[id]) };
  }
  public(r) { const { hash, ...rest } = r; return rest; }
  list() { return Object.values(this.db).map(r => this.public(r)).sort((a, b) => b.created.localeCompare(a.created)); }
  revoke(id) { const r = this.db[id]; if (!r) return false; if (!r.revoked) { r.revoked = new Date(this.now()).toISOString(); this.store.save(); } return true; }
  // Returns the key record for a valid, unrevoked key of THIS site; null otherwise.
  verify(header) {
    const m = String(header || '').match(/^Bearer\s+(mbk_([a-z0-9-]+)_[A-Za-z0-9_-]{20,})\s*$/); if (!m) return null;
    if (m[2] !== this.site) return null;
    const h = Buffer.from(sha(m[1]), 'hex'); let found = null;
    for (const r of Object.values(this.db)) { const x = Buffer.from(r.hash, 'hex'); if (x.length === h.length && crypto.timingSafeEqual(x, h)) found = r; }
    if (!found || found.revoked || found.site !== this.site) return null;
    return found;
  }
  touch(r) { r.last_used = new Date(this.now()).toISOString(); this.store.save(); }
  // Sliding window per key: perMinute and perDay.
  allow(id) {
    const t = this.now(); const a = (this.hits.get(id) || []).filter(x => t - x < 86400000);
    if (a.filter(x => t - x < 60000).length >= this.perMinute || a.length >= this.perDay) { this.hits.set(id, a); return false; }
    a.push(t); this.hits.set(id, a); return true;
  }
  history(id, limit = 100) { return this.store.db.calls.filter(c => c.key === id).slice(-limit).reverse(); }
}
module.exports = { BotKeys, SCOPES, sha, slugOf };
