'use strict';
// Monthly newsletter: double opt-in. The call email carries a signed link; nobody is subscribed until they
// open it and press the button (POST), so link scanners cannot confirm. Records go to DATA_DIR/newsletter.jsonl.
const crypto = require('crypto');
const fs = require('fs');
const { appendJsonl } = require('./util');
const TTL_MS = 30 * 24 * 3600 * 1000;
const b64u = (b) => Buffer.from(b).toString('base64url');
const NAME_MAX = 40;
function cleanName(raw) { return String(raw || '').normalize('NFC').replace(/[^\p{L} '\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim(); }
function deriveSecret(env = {}) {
  if (env.NEWSLETTER_SECRET && env.NEWSLETTER_SECRET.length >= 16) return env.NEWSLETTER_SECRET;
  const base = env.PA_MASTER_KEY || env.PA_STATE_SECRET || env.PA_ADMIN_TOKEN || 'demo-newsletter-EXAMPLE';
  return crypto.createHmac('sha256', String(base)).update('rfsafe-newsletter-v1').digest('hex');
}
class Newsletter {
  constructor({ secret, file, baseUrl = 'https://callbots.org', now = () => Date.now() }) { this.secret = secret; this.file = file; this.base = baseUrl.replace(/\/$/, ''); this.now = now; }
  mac(p) { return crypto.createHmac('sha256', this.secret).update(p).digest('base64url'); }
  // token = base64url(json{e,n,t,ts,a}).hmac ; a = 'sub' | 'unsub'
  token({ email, name, tenant, action = 'sub', ts }) {
    const p = b64u(JSON.stringify({ e: String(email).toLowerCase(), n: cleanName(name), t: tenant, ts: ts ?? this.now(), a: action }));
    return p + '.' + this.mac(p);
  }
  verify(tok, action) {
    const [p, m] = String(tok || '').split('.'); if (!p || !m) return null;
    const exp = this.mac(p); const a = Buffer.from(m); const b = Buffer.from(exp);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let o; try { o = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { return null; }
    if (!o || o.a !== action || typeof o.e !== 'string' || typeof o.ts !== 'number') return null;
    if (action === 'sub' && (this.now() - o.ts > TTL_MS || o.ts - this.now() > 60000)) return null;
    return o;
  }
  confirmUrl(x) { return this.base + '/newsletter/confirm?t=' + this.token({ ...x, action: 'sub' }); }
  unsubscribeUrl(x) { return this.base + '/newsletter/unsubscribe?t=' + this.token({ ...x, action: 'unsub' }); }
  record(o, kind) { appendJsonl(this.file, { kind, email: o.e, name: o.n || null, tenant: o.t, at: new Date(this.now()).toISOString(), source: 'phone' }); }
  isSubscriber(tenant, email) {
    const e = String(email || '').trim().toLowerCase(); if (!e) return false;
    return this.subscribers().some((s) => s.tenant === tenant && String(s.email || '').trim().toLowerCase() === e);
  }
  subscribers() {
    let lines = []; try { lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
    const m = new Map();
    for (const l of lines) { let r; try { r = JSON.parse(l); } catch { continue; } const k = r.tenant + '|' + String(r.email || '').trim().toLowerCase(); if (r.kind === 'confirmed') m.set(k, r); else if (r.kind === 'unsubscribed') m.delete(k); }
    return [...m.values()].map(({ email, name, tenant, at, source }) => ({ email, name, tenant, confirmed_at: at, source }));
  }
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 20px;color:#222}button{font-size:16px;padding:12px 20px;border:0;border-radius:6px;background:#0b5;color:#fff;cursor:pointer}small{color:#777}</style></head><body><h1>${esc(title)}</h1>${body}<p><small>RF Safe is a trademark of Quanta X Technology LLC. <a href="/privacy#newsletter">Privacy</a></small></p></body></html>`;
}
function formPage({ title, text, button, action, tok }) { return page(title, `<p>${esc(text)}</p><form method="post" action="${action}"><input type="hidden" name="t" value="${esc(tok)}"><button type="submit">${esc(button)}</button></form>`); }
module.exports = { Newsletter, deriveSecret, cleanName, page, formPage, TTL_MS, NAME_MAX };
