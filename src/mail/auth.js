'use strict';
// Owner magic-link sign-in for hosts that have none. Same interface as the phone-agent AdminAuth, which
// host wiring can pass in instead. Raw link tokens exist only in the email; only hashes are stored.
const crypto = require('crypto');
const LINK_TTL_MS = 15 * 60 * 1000; const SESSION_MS = 12 * 3600 * 1000; const MAX_LINKS = 3;
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const rnd = (n = 32) => crypto.randomBytes(n).toString('base64url');
const eq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
class MagicAuth {
  constructor({ secret, email, now = () => Date.now() }) {
    if (!secret) throw new Error('MagicAuth needs a secret');
    if (!email) throw new Error('MagicAuth needs the owner email');
    this.secret = secret; this.email = String(email).trim().toLowerCase(); this.now = now; this.links = new Map(); this.sends = []; this.revoked = new Map();
  }
  mac(s) { return crypto.createHmac('sha256', this.secret).update(s).digest('base64url'); }
  issueLink() {
    const t = this.now(); this.sends = this.sends.filter(x => t - x < LINK_TTL_MS);
    if (this.sends.length >= MAX_LINKS) return null;
    for (const [h, e] of this.links) if (e < t) this.links.delete(h);
    const tok = rnd(32); this.links.set(sha(tok), t + LINK_TTL_MS); this.sends.push(t); return tok;
  }
  consumeLink(tok) { const h = sha(tok || ''); const e = this.links.get(h); if (!e) return false; this.links.delete(h); return e >= this.now(); }
  newSession() { const sid = rnd(18); const p = sid + '.' + (this.now() + SESSION_MS); return p + '.' + this.mac('s|' + p); }
  session(cookie) {
    const [sid, exp, m] = String(cookie || '').split('.'); if (!sid || !exp || !m) return null;
    if (!eq(m, this.mac('s|' + sid + '.' + exp)) || Number(exp) < this.now() || this.revoked.has(sid)) return null;
    return { sid, exp: Number(exp) };
  }
  revoke(sid) { this.revoked.set(sid, this.now() + SESSION_MS); }
  csrfFor(sid) { return this.mac('c|' + sid); }
}
module.exports = { MagicAuth, LINK_TTL_MS, SESSION_MS };
