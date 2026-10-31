'use strict';
// One-time tokens that mark an outbound owner-briefing call bridged into xAI over SIP.
// Format: v1.<base64url JSON payload>.<base64url HMAC-SHA256>. Short-lived (default 120 s) and single-use.
// The HMAC key is derived from the tenant's xAI webhook secret, so no new secret is needed.
const crypto = require('crypto');
const HEADER = 'X-RFSafe-Owner-Token';
const b64u = (b) => Buffer.from(b).toString('base64url');
function deriveKey(secret) { return secret ? crypto.createHmac('sha256', String(secret)).update('rfsafe-owner-call-token-v1').digest() : null; }
const sign = (key, data) => crypto.createHmac('sha256', key).update(data).digest('base64url');

class OwnerTokens {
  constructor({ now = () => Date.now(), ttlMs = 120000 } = {}) { this.now = now; this.ttlMs = ttlMs; this.used = new Map(); }
  mint(secret, { tenant, to, kind = 'daily', alert = null }) {
    const key = deriveKey(secret); if (!key) return null;
    const p = b64u(JSON.stringify({ t: tenant, to, k: kind, a: alert || null, exp: this.now() + this.ttlMs, n: crypto.randomBytes(12).toString('base64url') }));
    return 'v1.' + p + '.' + sign(key, 'v1.' + p);
  }
  // Returns { ok:true, tenant, to, kind, alert } once; any later use of the same token fails.
  claim(secret, token) {
    const key = deriveKey(secret); const s = String(token || '');
    if (!key || s.length > 600) return { ok: false, reason: 'invalid' };
    const m = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(s); if (!m) return { ok: false, reason: 'invalid' };
    const want = Buffer.from(sign(key, 'v1.' + m[1])); const got = Buffer.from(m[2]);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { ok: false, reason: 'bad_signature' };
    let p; try { p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'invalid' }; }
    const t = this.now(); for (const [n, exp] of this.used) if (exp < t) this.used.delete(n);
    if (!p || typeof p.exp !== 'number' || p.exp < t) return { ok: false, reason: 'expired' };
    if (this.used.has(p.n)) return { ok: false, reason: 'replayed' };
    this.used.set(p.n, p.exp);
    return { ok: true, tenant: p.t, to: p.to, kind: p.k === 'alert' ? 'alert' : 'daily', alert: p.a || null };
  }
}
// The token can arrive as a custom SIP header or as a URI parameter on the Request-URI/To header.
function tokenFromSip(data) {
  const hs = (data && data.sip_headers) || [];
  const h = hs.find((x) => x && String(x.name).toLowerCase() === HEADER.toLowerCase()); if (h && h.value) return String(h.value).trim();
  for (const x of hs) { const m = /[;?&]rfs_owner_token=([A-Za-z0-9._-]+)/.exec(String((x && x.value) || '')); if (m) return m[1]; }
  return null;
}
module.exports = { OwnerTokens, tokenFromSip, HEADER, deriveKey };
