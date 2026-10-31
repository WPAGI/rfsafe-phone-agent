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
  record(o, kind, meta = {}) { appendJsonl(this.file, { kind, email: o.e, name: o.n || null, tenant: o.t, at: new Date(this.now()).toISOString(), source: 'phone', ...(meta.ip ? { ip: String(meta.ip).slice(0, 64) } : {}), ...(meta.ua ? { ua: String(meta.ua).slice(0, 300) } : {}) }); }
  // ---- SMS news opt-in (double opt-in by reply YES). Same file, phone-keyed events; one list with email. ----
  append(rec) { appendJsonl(this.file, { at: new Date(this.now()).toISOString(), ...rec }); }
  events() { let lines = []; try { lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean); } catch { return []; } const out = []; for (const l of lines) { try { out.push(JSON.parse(l)); } catch { /* skip */ } } return out; }
  smsState(tenant, phone) {
    let st = { status: 'none' };
    for (const r of this.events()) if (r.tenant === tenant && r.phone === phone) {
      if (r.kind === 'sms_pending' && st.status !== 'subscribed') st = { status: 'pending', requested_at: r.at, call: r.call, wording: r.wording };
      else if (r.kind === 'sms_confirmed') st = { ...st, status: 'subscribed', confirmed_at: r.at, confirm_text: r.reply, invited_at: r.invited_at || st.requested_at, source: r.source || 'phone' };
      else if (r.kind === 'sms_stopped' && st.status !== 'none') st = { ...st, status: 'unsubscribed', stopped_at: r.at };
    }
    return st;
  }
  isSmsSubscriber(tenant, phone) { return !!phone && this.smsState(tenant, phone).status === 'subscribed'; }
  requestSms({ tenant, phone, call, email, wording }) { this.append({ kind: 'sms_pending', tenant, phone, call: call || null, email: email || null, wording, source: 'phone' }); }
  // Reply YES within the TTL confirms a pending request. Returns true if this YES was a news confirmation.
  confirmSms(tenant, phone, reply) {
    const st = this.smsState(tenant, phone);
    if (st.status !== 'pending' || this.now() - Date.parse(st.requested_at) > TTL_MS) return false;
    this.append({ kind: 'sms_confirmed', tenant, phone, reply: String(reply || '').slice(0, 40), invited_at: st.requested_at, call: st.call || null, wording: st.wording || null, source: 'phone_call+sms_yes' }); return true;
  }
  stopSms(tenant, phone) { if (this.smsState(tenant, phone).status !== 'none') this.append({ kind: 'sms_stopped', tenant, phone }); }
  linkPhone({ tenant, email, phone, call }) { if (email && phone) this.append({ kind: 'link', tenant, email: String(email).toLowerCase(), phone, call: call || null }); }
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
const NEWS_SMS_FREQ = 'up to 4 msgs/mo';
const NEWS_SMS_CADENCE = 'About once a month, plus breaking news.';
const newsSmsInvite = (brand) => `Want ${brand} news by text? ${NEWS_SMS_CADENCE} Reply YES to join (${NEWS_SMS_FREQ}). Consent not required to buy. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`;
const newsSmsConfirmed = (brand) => `${brand} News: you're subscribed to RF Safe news texts. ${NEWS_SMS_CADENCE} Up to 4 msgs/mo. Msg & data rates may apply. Reply HELP for help, STOP to cancel.`;
const NEWS_SMS_SPOKEN = 'Would you also like RF Safe news by text, about once a month plus breaking news, up to 4 messages a month? I will add a line to the text, and you are signed up only if you reply YES. Message and data rates may apply, and you can reply STOP anytime.';
module.exports = { NEWS_SMS_FREQ, NEWS_SMS_CADENCE, newsSmsInvite, newsSmsConfirmed, NEWS_SMS_SPOKEN, Newsletter, deriveSecret, cleanName, page, formPage, TTL_MS, NAME_MAX };
