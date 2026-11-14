'use strict';
// Reusable read-only mail viewer. Mount with:
//   const mail = require('./mail').createMail({ env, auth, sendEmail, publicBaseUrl, siteName });
//   if (await mail.route(req, res, new URL(req.url, 'http://x'))) return;
// The server enforces MAIL_DOMAINS for every list and message; client parameters never widen it.
const crypto = require('crypto');
const { ReceivedMail, domains } = require('./client');
const { documentHtml } = require('./sanitizer');
const V = require('./views');
const { MagicAuth, SESSION_MS } = require('./auth');
const DEFAULT_OWNER = 'support@quantaxtechnology.com';
const BASE_HEADERS = { 'cache-control': 'no-store, max-age=0', pragma: 'no-cache', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
const PAGE_CSP = (nonce) => `default-src 'none'; script-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
const FRAME_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-popups allow-popups-to-escape-sandbox";
const eq = (a, b) => { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
const cookiesOf = h => { const o = {}; for (const p of String(h || '').split(';')) { const i = p.indexOf('='); if (i > 0) { try { o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch {} } } return o; };
const readForm = req => new Promise((resolve, reject) => { let s = ''; req.on('data', c => { s += c; if (s.length > 8192) { reject(Object.assign(new Error('too_large'), { status: 413 })); req.destroy(); } }); req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(s)))); req.on('error', reject); });
const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const ET_SHORT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmt = (f, iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? f.format(t) : ''; };
const htmlToText = h => String(h || '').replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<a\s[^>]*href\s*=\s*["']?(https?:[^"'\s>]+)[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
// Short numeric or alphanumeric codes near the words "code", "verification", "PIN" etc., shown as copy chips.
function findCodes(subject, text) {
  const out = new Set(); const s = String(subject || '') + '\n' + String(text || '').slice(0, 20000);
  for (const k of s.matchAll(/code|verification|verify|pin|passcode|otp|security/gi)) {
    const win = s.slice(k.index, k.index + 60).split('\n')[0];
    for (const m of win.matchAll(/\b([A-Z0-9]{4,8})\b/gi)) if (/\d/.test(m[1]) && !/^(19|20)\d\d$/.test(m[1])) out.add(m[1]);
  }
  return [...out].slice(0, 4);
}
function createMail(o = {}) {
  const env = o.env || process.env; const base = o.base || '/mail'; const now = o.now || (() => Date.now()); const log = o.log || (() => {});
  const allowed = [...domains(env.MAIL_DOMAINS)];
  const ownerEmail = String(env.MAIL_OWNER_EMAIL || env.ADMIN_LOGIN_EMAIL || DEFAULT_OWNER).trim().toLowerCase();
  const auth = o.auth || new MagicAuth({ secret: o.secret || env.MAIL_SESSION_SECRET, email: ownerEmail, now });
  const keyVar = o.keyVar || 'RESEND_MAIL_READ_KEY';
  const client = new ReceivedMail({ key: env[keyVar], allowed: allowed.join(','), inboxIds: env.MAIL_INBOX_IDS, fetchImpl: o.fetchImpl || globalThis.fetch });
  const siteName = o.siteName || 'Site'; const pub = () => String((typeof o.publicBaseUrl === 'function' ? o.publicBaseUrl() : o.publicBaseUrl) || '').replace(/\/$/, '');
  const SC = `HttpOnly; Secure; SameSite=Strict; Path=${base}`;
  let cache = null;
  function send(res, code, body, type, extra = {}, cookies = []) { res.writeHead(code, { 'content-type': type || 'text/html; charset=utf-8', ...BASE_HEADERS, 'x-frame-options': 'DENY', 'content-security-policy': PAGE_CSP(), ...extra, ...(cookies.length ? { 'set-cookie': cookies } : {}) }); res.end(body); return true; }
  const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
  const redirect = (res, to, cookies) => send(res, 303, '', null, { location: to }, cookies);
  function sameOrigin(req) {
    if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') return false;
    const org = req.headers.origin; if (!org || org === 'null') return true;
    try { const u = new URL(org); if (pub() && u.origin === new URL(pub()).origin) return true; return u.host === req.headers.host; } catch { return false; }
  }
  function preCsrf(cookies) { const c = cookies.mail_csrf; if (c && /^[A-Za-z0-9_-]{20,}$/.test(c)) return { tok: c, set: [] }; const t = crypto.randomBytes(24).toString('base64url'); return { tok: t, set: [`mail_csrf=${t}; ${SC}; Max-Age=3600`] }; }
  async function messages(force) {
    if (!force && cache && now() - cache.at < 30000) return cache;
    let list = []; let error = null;
    try { const r = await client.list(); list = r.messages; if (r.errors.length) { error = r.errors.includes('mail_not_configured') ? 'Mail reader key not configured' : 'Some mail could not be loaded'; log('mail.list_partial', { reasons: r.errors }); } } catch (e) { error = 'Mail server unavailable'; log('mail.list_failed', { reason: e.message }); }
    list.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const result = { at: now(), error, messages: list.map(({ resend_id, message_id, ...m }) => ({ ...m, when: fmt(ET, m.created_at), short: fmt(ET_SHORT, m.created_at) })) };
    if (!error) cache = result; return result;
  }
  async function route(req, res, u) {
    const p = u.pathname; if (p !== base && !p.startsWith(base + '/')) return false;
    const sub = p.slice(base.length) || '/'; const cookies = cookiesOf(req.headers.cookie); const sess = auth.session(cookies.mail_session);
    try {
      if (sub === '/login') {
        if (req.method === 'GET') { const c = preCsrf(cookies); return send(res, 200, V.loginPage({ base, csrf: c.tok, siteName }), null, {}, c.set); }
        if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
        const f = await readForm(req);
        if (!sameOrigin(req) || !eq(f.csrf, cookies.mail_csrf)) return send(res, 403, V.msgPage({ base, title: 'Request blocked', text: 'Reload the sign-in page and try again.' }));
        // Owner only. Any other address gets the identical page and no email.
        if (String(f.email || '').trim().toLowerCase() === ownerEmail && ownerEmail === String(auth.email).toLowerCase()) {
          const tok = auth.issueLink();
          if (tok && o.sendEmail) {
            const link = pub() + base + '/auth#t=' + tok;
            try { const r = await o.sendEmail({ to: auth.email, subject: 'Your ' + siteName + ' Mail sign-in link', text: `Sign in to ${siteName} Mail (works once, expires in 15 minutes):\n${link}\n\nIf this was not you, ignore this email.`, html: `<p>Sign in to ${siteName} Mail.</p><p><a href="${link}">Open the sign-in page</a></p><p>The link works once and expires in 15 minutes. If this was not you, ignore this email.</p>` }); log('mail.login_link', { ok: !!(r && r.ok) }); } catch { log('mail.login_link', { ok: false }); }
          } else log('mail.login_link', { ok: false, reason: tok ? 'no_sender' : 'rate_limited' });
        } else log('mail.login_other', {});
        return send(res, 200, V.sentPage({ base }));
      }
      if (sub === '/auth') {
        if (req.method === 'GET') { if (u.search) return send(res, 400, V.msgPage({ base, title: 'Link expired or used', text: 'Request a new sign-in link.' })); const c = preCsrf(cookies); const nonce = crypto.randomBytes(16).toString('base64'); return send(res, 200, V.authPage({ base, csrf: c.tok, nonce }), null, { 'content-security-policy': PAGE_CSP(nonce) }, c.set); }
        if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
        const f = await readForm(req);
        if (!sameOrigin(req) || !eq(f.csrf, cookies.mail_csrf)) return send(res, 403, V.msgPage({ base, title: 'Request blocked', text: 'Open the link from the email again.' }));
        if (!auth.consumeLink(f.t)) { log('mail.login_failed', {}); return send(res, 400, V.msgPage({ base, title: 'Link expired or used', text: 'This sign-in link is invalid, used, or expired.' })); }
        log('mail.login', {});
        return redirect(res, base, [`mail_session=${auth.newSession()}; ${SC}; Max-Age=${Math.floor(SESSION_MS / 1000)}`, `mail_csrf=; ${SC}; Max-Age=0`]);
      }
      if (sub === '/logout') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
        const f = await readForm(req);
        if (sess && sameOrigin(req) && eq(f.csrf, auth.csrfFor(sess.sid))) auth.revoke(sess.sid);
        return redirect(res, base + '/login', [`mail_session=; ${SC}; Max-Age=0`]);
      }
      // Everything below needs the owner session.
      if (!sess) return sub.startsWith('/api/') ? json(res, 401, { error: 'unauthorized' }) : redirect(res, base + '/login');
      if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
      if (sub === '/' ) { const nonce = crypto.randomBytes(16).toString('base64'); return send(res, 200, V.appPage({ base, csrf: auth.csrfFor(sess.sid), nonce, siteName, domains: allowed }), null, { 'content-security-policy': PAGE_CSP(nonce) }); }
      if (sub === '/api/messages') {
        const r = await messages(u.searchParams.get('refresh') === '1');
        const addresses = [...new Set(r.messages.flatMap(m => m.to.map(x => x.toLowerCase())))].sort();
        return json(res, r.error && !r.messages.length ? 502 : 200, { messages: r.messages.map(m => ({ ...m, to: m.to.map(x => x.toLowerCase()) })), addresses, domains: allowed, updated: fmt(ET_SHORT, new Date(r.at).toISOString()) + ' ET', error: r.error || undefined });
      }
      const m = sub.match(/^\/api\/messages\/((?:r\.[A-Za-z0-9-]{8,80})|(?:i(?:\.[A-Za-z0-9-]{8,80}){3}))(\/html)?$/);
      if (m) {
        let msg; try { msg = await client.get(m[1]); } catch (e) { log('mail.get_failed', { reason: e.message }); return json(res, 502, { error: 'mail_unavailable' }); }
        if (!msg) return json(res, 404, { error: 'not_found' });
        if (m[2]) return send(res, 200, documentHtml(msg.html || ''), null, { 'content-security-policy': FRAME_CSP, 'x-frame-options': 'SAMEORIGIN' });
        const text = msg.text || htmlToText(msg.html);
        return json(res, 200, { id: msg.id, from: msg.from, to: msg.to.map(x => x.toLowerCase()), subject: msg.subject, when: fmt(ET, msg.created_at), hasHtml: !!msg.html, text, codes: findCodes(msg.subject, text) });
      }
      return json(res, 404, { error: 'not_found' });
    } catch (e) { log('mail.error', { reason: e.message }); if (!res.headersSent) json(res, e.status || 500, { error: 'internal_error' }); return true; }
  }
  return { route, auth, allowed, ownerEmail };
}
module.exports = { createMail, MagicAuth, htmlToText, findCodes };
