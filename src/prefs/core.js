'use strict';
// PREFERENCES CORE - v1.0
// Site-agnostic subscription-preferences engine: magic links (email), one-time codes (SMS), sessions, rate limits
// and an append-only consent audit log. Tokens, codes and session ids are stored only as HMAC hashes, single-use,
// short-lived. No site wording lives here; see sites/<id>.js for branding, topics and legal text.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const CODE_MAX_TRIES = 5;
const LIMITS = { ip: { max: 10, windowMs: 15 * 60 * 1000 }, id: { max: 3, windowMs: 15 * 60 * 1000 } };
const FREQS = ['sales', 'monthly', 'up4']; // never more than 4 msgs/mo
const EMAIL_RE = /^[^@\s<>"',;]+@[^@\s<>"',;]+\.[a-z]{2,}$/i;
const normEmail = (e) => { const s = String(e || '').trim().toLowerCase(); return s.length <= 254 && EMAIL_RE.test(s) ? s : null; };
const normPhone = (p) => { const d = String(p || '').replace(/[^\d+]/g, ''); return /^\+[1-9]\d{7,14}$/.test(d) ? d : /^\d{10}$/.test(d) ? '+1' + d : /^1\d{10}$/.test(d) ? '+' + d : null; };
// US mobile format (NANP): 10 digits or 1+10, area code and exchange start 2-9. Returns E.164 or null.
const normUsPhone = (p) => { const raw = String(p || '').trim(); if (!/^[\d\s().+-]{10,20}$/.test(raw)) return null; let d = raw.replace(/\D/g, ''); if (d.length === 11 && d[0] === '1') d = d.slice(1); return /^[2-9]\d{2}[2-9]\d{6}$/.test(d) ? '+1' + d : null; };
// Names: strip control chars and line breaks, collapse spaces, trim, max 50. Output is always HTML-escaped by the pages.
const NAME_MAX = 80; // one "Name" field (first, or first and last)
const cleanPersonName = (v) => String(v == null ? '' : v).normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
const rnd = (n = 32) => crypto.randomBytes(n).toString('base64url');

// Signing key: PREFS_SECRET from env/config, else generated once on the data disk at install time (never in git).
function loadSecret(env, dir) {
  if (env && env.PREFS_SECRET && String(env.PREFS_SECRET).length >= 32) return String(env.PREFS_SECRET);
  const f = path.join(dir, 'prefs-secret.key');
  try { const s = fs.readFileSync(f, 'utf8').trim(); if (s.length >= 32) return s; } catch { /* first run */ }
  fs.mkdirSync(dir, { recursive: true }); const s = rnd(48); fs.writeFileSync(f, s, { mode: 0o600, flag: 'wx' }); return s;
}

class RateLimit {
  constructor({ now }) { this.now = now; this.hits = new Map(); }
  allow(kind, key) {
    const L = LIMITS[kind]; const k = kind + '|' + key; const t = this.now();
    const arr = (this.hits.get(k) || []).filter((x) => t - x < L.windowMs);
    if (arr.length >= L.max) { this.hits.set(k, arr); return false; }
    arr.push(t); this.hits.set(k, arr); if (this.hits.size > 20000) this.hits.delete(this.hits.keys().next().value); return true;
  }
}

class PrefsCore {
  // dir: data directory (Render disk). site: config from sites/<id>.js.
  constructor({ dir, site, env = process.env, now = () => Date.now() }) {
    this.dir = path.join(dir, 'prefs', site.id); fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.site = site; this.now = now; this.secret = loadSecret(env, this.dir);
    this.stateFile = path.join(this.dir, 'state.json'); this.auditFile = path.join(this.dir, 'audit.jsonl');
    this.rate = new RateLimit({ now }); this.state = this._load();
  }
  hash(kind, v) { return crypto.createHmac('sha256', this.secret).update(kind + '\0' + v).digest('hex'); }
  _load() { try { const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); return { tokens: s.tokens || {}, codes: s.codes || {}, sessions: s.sessions || {}, people: s.people || {} }; } catch { return { tokens: {}, codes: {}, sessions: {}, people: {} }; } }
  _save() {
    const t = this.now(); for (const b of ['tokens', 'codes', 'sessions']) for (const [k, v] of Object.entries(this.state[b])) if (v.exp < t) delete this.state[b][k];
    const tmp = this.stateFile + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 }); fs.renameSync(tmp, this.stateFile);
  }
  allowIp(ip) { return this.rate.allow('ip', String(ip || '-')); }
  allowId(id) { return this.rate.allow('id', this.hash('rl', id)); }
  // Magic link token for an email. Returns the raw token (only ever placed in the email), stores its hash.
  issueToken(email) { const tok = rnd(32); this.state.tokens[this.hash('tok', tok)] = { email, exp: this.now() + TOKEN_TTL_MS }; this._save(); return tok; }
  consumeToken(tok) {
    if (typeof tok !== 'string' || tok.length < 20 || tok.length > 100) return null;
    const h = this.hash('tok', tok); const r = this.state.tokens[h]; if (!r) return null;
    delete this.state.tokens[h]; this._save(); return r.exp >= this.now() ? r.email : null;
  }
  // SMS one-time code (6 digits) for a phone. Hash binds phone + code; max 5 tries; single use.
  issueCode(phone) { const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0'); this.state.codes[this.hash('ph', phone)] = { h: this.hash('code', phone + '|' + code), exp: this.now() + TOKEN_TTL_MS, tries: 0 }; this._save(); return code; }
  consumeCode(phone, code) {
    const k = this.hash('ph', phone); const r = this.state.codes[k]; if (!r || r.exp < this.now()) { if (r) { delete this.state.codes[k]; this._save(); } return false; }
    const ok = crypto.timingSafeEqual(Buffer.from(r.h), Buffer.from(this.hash('code', phone + '|' + String(code || '').trim())));
    if (ok || ++r.tries >= CODE_MAX_TRIES) delete this.state.codes[k]; this._save(); return ok;
  }
  // Sessions: random id in an HttpOnly cookie; only its hash is stored. Carries the verified email and/or phone.
  newSession(ids) { const sid = rnd(32); const csrf = rnd(18); this.state.sessions[this.hash('sid', sid)] = { ...ids, csrf, exp: this.now() + SESSION_TTL_MS }; this._save(); return { sid, csrf }; }
  session(sid) { if (!sid) return null; const r = this.state.sessions[this.hash('sid', sid)]; return r && r.exp >= this.now() ? r : null; }
  endSession(sid) { if (sid) { delete this.state.sessions[this.hash('sid', sid)]; this._save(); } }
  // Per-person settings this module owns (text frequency, support-texts choice). Consent itself lives in the site's stores.
  personKey(s) { return s.email ? 'e:' + s.email : 'p:' + s.phone; }
  person(s) { return this.state.people[this.personKey(s)] || { news_freq: 'monthly', support_sms: false }; }
  setPerson(s, patch) { const k = this.personKey(s); this.state.people[k] = { ...this.person(s), ...patch, updated_at: new Date(this.now()).toISOString() }; this._save(); }
  // Append-only consent audit: time, what changed, method (web | sms | call | email-link), source.
  audit(rec) { fs.appendFileSync(this.auditFile, JSON.stringify({ at: new Date(this.now()).toISOString(), site: this.site.id, ...rec }) + '\n', { mode: 0o600 }); }
  auditLog() { try { return fs.readFileSync(this.auditFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }
}
const firstWord = (v) => cleanPersonName(v).split(' ')[0] || '';
module.exports = { normUsPhone, cleanPersonName, firstWord, NAME_MAX, PrefsCore, RateLimit, loadSecret, normEmail, normPhone, FREQS, TOKEN_TTL_MS, SESSION_TTL_MS, CODE_MAX_TRIES, LIMITS };
