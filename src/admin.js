'use strict';
// Admin dashboard: passwordless sign-in (one-time email link to a FIXED address), session cookie, CSRF,
// newsletter + call-log views and CSV exports. Zero dependencies.
const crypto = require('crypto');
const fs = require('fs');
const { appendJsonl } = require('./util');

const LINK_TTL_MS = 15 * 60 * 1000;
const LINK_MAX_PER_WINDOW = 3;
const SESSION_MS = 12 * 3600 * 1000;
const CALL_RETENTION_DAYS = 180;
const DEFAULT_ADMIN_EMAIL = 'support@quantaxtechnology.com';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rnd = (n = 32) => crypto.randomBytes(n).toString('base64url');
const eq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function adminSecret(env = {}) {
  const base = env.PA_STATE_SECRET || env.PA_MASTER_KEY || env.PA_ADMIN_TOKEN || 'demo-admin-EXAMPLE';
  return crypto.createHmac('sha256', String(base)).update('rfsafe-admin-session-v1').digest();
}
function parseCookies(h) { const o = {}; for (const p of String(h || '').split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } return o; }

class AdminAuth {
  constructor({ secret, email, now = () => Date.now() }) { this.secret = secret; this.email = email || DEFAULT_ADMIN_EMAIL; this.now = now; this.links = new Map(); this.sends = []; this.revoked = new Map(); }
  mac(s) { return crypto.createHmac('sha256', this.secret).update(s).digest('base64url'); }
  // One-time login link: random token, only its hash is stored. Max 3 issued per 15 minutes.
  issueLink() {
    const t = this.now(); this.sends = this.sends.filter((x) => t - x < LINK_TTL_MS);
    if (this.sends.length >= LINK_MAX_PER_WINDOW) return null;
    for (const [h, e] of this.links) if (e < t) this.links.delete(h);
    const tok = rnd(32); this.links.set(sha(tok), t + LINK_TTL_MS); this.sends.push(t); return tok;
  }
  checkLink(tok) { const e = this.links.get(sha(tok || '')); return !!e && e >= this.now(); }
  consumeLink(tok) { const h = sha(tok || ''); const e = this.links.get(h); if (!e) return false; this.links.delete(h); return e >= this.now(); }
  // Session cookie: sid.exp.mac (stateless; logout revokes the sid in memory).
  newSession() { const sid = rnd(18); const exp = this.now() + SESSION_MS; const p = sid + '.' + exp; return p + '.' + this.mac('s|' + p); }
  session(cookie) {
    const [sid, exp, m] = String(cookie || '').split('.'); if (!sid || !exp || !m) return null;
    if (!eq(m, this.mac('s|' + sid + '.' + exp))) return null;
    if (Number(exp) < this.now() || this.revoked.has(sid)) return null;
    return { sid, exp: Number(exp) };
  }
  revoke(sid) { const t = this.now(); for (const [k, e] of this.revoked) if (e < t) this.revoked.delete(k); this.revoked.set(sid, t + SESSION_MS); }
  csrfFor(sid) { return this.mac('c|' + sid); }
}

// Per-call records with the full caller number for the admin's quality review. Pruned after CALL_RETENTION_DAYS.
class CallRecords {
  constructor({ file, now = () => Date.now(), retentionDays = CALL_RETENTION_DAYS }) { this.file = file; this.now = now; this.keepMs = retentionDays * 86400000; this.lastPrune = 0; }
  add(rec) { if (!this.file) return; appendJsonl(this.file, rec); if (this.now() - this.lastPrune > 86400000) this.prune(); }
  read() { let l = []; try { l = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean); } catch { return []; } const out = []; for (const x of l) { try { out.push(JSON.parse(x)); } catch { /* skip */ } } return out; }
  prune() {
    this.lastPrune = this.now(); const cut = this.now() - this.keepMs; const all = this.read(); const keep = all.filter((r) => Date.parse(r.at) >= cut);
    if (keep.length !== all.length) { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''), { mode: 0o600 }); fs.renameSync(tmp, this.file); }
  }
}

// Build a call record from a CallSession summary (tools carry per-tool detail).
const TEXT_TOOLS = ['send_link_sms', 'send_link', 'set_text_number'];
const TEXT_ASK = /\b(text|txt|texting|sms)\b/i;
function callRecord(summary, caller, endedAt, transcript) {
  const tools = summary.tools || [];
  const kb = tools.filter((t) => t.tool === 'kb_answer' && t.q).map((t) => t.q);
  const emails = tools.filter((t) => t.tool === 'send_email').map((t) => ({ to_masked: t.to_masked || null, topic: t.topic || null, ok: !!t.ok }));
  const sar = tools.filter((t) => t.tool === 'sar_lookup' && t.phone).map((t) => 'SAR: ' + t.phone);
  const prod = tools.filter((t) => t.tool === 'product_search' && t.query).map((t) => 'Product: ' + t.query);
  const textTools = tools.filter((t) => TEXT_TOOLS.includes(t.tool));
  const textsSent = tools.filter((t) => (t.tool === 'send_link_sms' || t.tool === 'send_link') && t.ok).length;
  const callerAskedText = Array.isArray(transcript) && transcript.some((x) => x && x.role === 'caller' && TEXT_ASK.test(String(x.text || '')));
  let texts = null;
  if (textsSent) texts = `sent ${textsSent}`;
  else if (textTools.length) texts = 'failed: ' + ([...new Set(textTools.map((t) => t.error).filter(Boolean))].join(' ') || 'not sent');
  else if (callerAskedText) texts = 'requested, none sent (no text tool used)';
  const failed = tools.filter((t) => !t.ok && !TEXT_TOOLS.includes(t.tool)).map((t) => `${t.tool} failed${t.error ? ' (' + t.error + ')' : ''}`);
  const topics = [...new Set([...kb, ...emails.map((e) => e.topic).filter(Boolean), ...sar, ...prod])];
  const parts = [...topics.slice(0, 5), ...(texts ? ['Text ' + texts] : []), ...failed.slice(0, 3)];
  return {
    at: summary.started_at || endedAt, ended_at: endedAt, call: summary.call || null, tenant: summary.tenant, caller: caller || null,
    seconds: summary.seconds ?? null, tools: [...new Set(tools.map((t) => t.tool))], kb_queries: kb, emails, texts,
    newsletter_optin: tools.some((t) => t.tool === 'send_email' && t.ok && t.newsletter_optin === true),
    summary: parts.length ? parts.join('; ').slice(0, 300) : null,
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function csvCell(v) { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
const toCsv = (cols, rows) => [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';

// Newsletter: one list per person (email and/or caller-ID phone), with separate email and text consent + proof.
function newsletterRows(file, { all = false } = {}) {
  let lines = []; try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const rows = []; const byEmail = new Map(); const byPhone = new Map();
  const blank = (tenant) => ({ name: '', email: '', phone: '', tenant, confirmed_at: '', source: 'phone', consent_method: '', confirm_ip: '', user_agent: '', unsubscribed_at: '', email_optin: '', sms_optin: '', sms_requested_at: '', sms_call: '', sms_consent_wording: '', sms_confirmed_at: '', sms_confirm_reply: '', sms_stopped_at: '' });
  const get = (tenant, email, phone) => {
    const ek = email ? tenant + '|' + String(email).trim().toLowerCase() : null; const pk = phone ? tenant + '|' + phone : null;
    let r = (ek && byEmail.get(ek)) || (pk && byPhone.get(pk));
    const pr = pk && byPhone.get(pk);
    if (r && pr && pr !== r && !pr.email && !r.phone) { // a phone-only row now linked to an email: fold it in
      for (const [k, v] of Object.entries(pr)) if (v && !r[k] && k !== 'source') r[k] = v;
      rows.splice(rows.indexOf(pr), 1); byPhone.set(pk, r);
    }
    if (!r) { r = blank(tenant); rows.push(r); }
    if (ek && !r.email) { r.email = String(email).trim().toLowerCase(); byEmail.set(ek, r); }
    if (pk && !r.phone) { r.phone = phone; byPhone.set(pk, r); }
    return r;
  };
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.kind === 'confirmed') { const r = get(e.tenant, e.email); Object.assign(r, { name: e.name || r.name, confirmed_at: e.at, source: e.source || 'phone', consent_method: 'phone verbal yes + email double opt-in click', confirm_ip: e.ip || '', user_agent: e.ua || '', unsubscribed_at: '', email_optin: 'subscribed' }); }
    else if (e.kind === 'unsubscribed') { const r = byEmail.get(e.tenant + '|' + String(e.email || '').trim().toLowerCase()); if (r) { r.unsubscribed_at = e.at; r.email_optin = 'unsubscribed'; } }
    else if (e.kind === 'profile') { const r = get(e.tenant, e.email, e.phone); if (e.name != null) r.name = e.name; }
    else if (e.kind === 'link') { const r = get(e.tenant, e.email, e.phone); if (!r.phone) r.phone = e.phone; }
    else if (e.kind === 'sms_pending') { const r = get(e.tenant, e.email, e.phone); if (r.sms_optin !== 'subscribed') Object.assign(r, { sms_optin: 'pending', sms_requested_at: e.at, sms_call: e.call || '', sms_consent_wording: e.wording ? `Spoken: ${e.wording.spoken || ''} | Text: ${e.wording.text || ''}` : '' }); }
    else if (e.kind === 'sms_confirmed') { const r = get(e.tenant, null, e.phone); Object.assign(r, { sms_optin: 'subscribed', sms_confirmed_at: e.at, sms_confirm_reply: e.reply || '', sms_stopped_at: '' }); }
    else if (e.kind === 'sms_stopped') { const r = byPhone.get(e.tenant + '|' + e.phone); if (r) { r.sms_optin = 'unsubscribed'; r.sms_stopped_at = e.at; } }
  }
  return rows.filter((r) => all ? (r.email || r.phone) : (r.email_optin || r.sms_optin));
}
const NL_COLS = ['name', 'email', 'tenant', 'confirmed_at', 'source', 'consent_method', 'confirm_ip', 'user_agent', 'unsubscribed_at', 'phone', 'email_optin', 'sms_optin', 'sms_requested_at', 'sms_call', 'sms_consent_wording', 'sms_confirmed_at', 'sms_confirm_reply', 'sms_stopped_at'];
const CALL_COLS = ['at', 'ended_at', 'tenant', 'caller', 'seconds', 'summary', 'kb_queries', 'tools', 'emails', 'texts', 'newsletter_optin'];
function callCsvRows(recs) { return recs.map((r) => ({ ...r, kb_queries: (r.kb_queries || []).join(' | '), tools: (r.tools || []).join(' '), emails: (r.emails || []).map((e) => `${e.to_masked || '?'} (${e.topic || 'links'})${e.ok ? '' : ' FAILED'}`).join(' | '), newsletter_optin: r.newsletter_optin ? 'yes' : 'no' })); }
function filterCalls(recs, { from, to, number }) {
  const f = from ? Date.parse(from + 'T00:00:00Z') : null; const t = to ? Date.parse(to + 'T23:59:59.999Z') : null; const n = String(number || '').replace(/\D/g, '');
  return recs.filter((r) => { const a = Date.parse(r.at); if (f && a < f) return false; if (t && a > t) return false; if (n && !String(r.caller || '').replace(/\D/g, '').includes(n)) return false; return true; }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

const STYLE = 'body{font-family:system-ui,sans-serif;max-width:1200px;margin:30px auto;padding:0 20px;color:#222}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #ddd;padding:5px;text-align:left;vertical-align:top}th{background:#f4f4f4}button{font-size:15px;padding:10px 18px;border:0;border-radius:6px;background:#0b5;color:#fff;cursor:pointer}.k{display:inline-block;margin:0 18px 10px 0;padding:10px 14px;background:#f4f8f4;border-radius:6px}.k b{font-size:22px;display:block}small{color:#777}';
function shell(title, body) { return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`; }
const hidden = (csrf) => `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
function loginPage(csrf, msg) { return shell('Admin sign-in', `<h1>CallBots admin</h1>${msg ? `<p>${esc(msg)}</p>` : ''}<p>Press the button and a one-time sign-in link (valid 15 minutes) is emailed to the admin inbox.</p><form method="post" action="/admin/login">${hidden(csrf)}<button type="submit">Send sign-in link</button></form>`); }
function authPage(csrf, tok) { return shell('Sign in', `<h1>CallBots admin</h1><form method="post" action="/admin/auth">${hidden(csrf)}<input type="hidden" name="t" value="${esc(tok)}"><button type="submit">Sign in</button></form><p><small>This link works once and expires 15 minutes after it was sent.</small></p>`); }
function sentPage(csrf, nonce, email) {
  return shell('Sign-in link sent', `<h1>Sign-in link sent</h1><p>Check <strong>${esc(email)}</strong> (and spam). The link expires in <strong id="ttl">15:00</strong>.</p><form method="post" action="/admin/login">${hidden(csrf)}<button type="submit" id="resend" disabled>Resend link (<span id="rs">60</span>s)</button></form><p><a href="/admin/login">Back to sign-in</a></p>
<script nonce="${esc(nonce)}">(function(){var end=Date.now()+900000,rend=Date.now()+60000,ttl=document.getElementById('ttl'),b=document.getElementById('resend'),rs=document.getElementById('rs');function p(n){return n<10?'0'+n:''+n}function tick(){var l=Math.max(0,Math.round((end-Date.now())/1000));ttl.textContent=l?Math.floor(l/60)+':'+p(l%60):'expired';var r=Math.max(0,Math.ceil((rend-Date.now())/1000));if(r){rs.textContent=r}else{b.disabled=false;b.textContent='Resend link'}if(l)setTimeout(tick,1000)}tick()})();</script>`);
}
function msgPage(title, text) { return shell(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/admin/login">Back to sign-in</a></p>`); }
function channelsSection(csrf, tenants = [], log = [], err = '') {
  const tog = (t, ch, label, on) => `<form method="post" action="/admin/channels" style="display:inline-block;margin:0 18px 8px 0">${hidden(csrf)}<input type="hidden" name="tenant" value="${esc(t.id)}"><input type="hidden" name="channel" value="${ch}"><input type="hidden" name="enabled" value="${on ? 'off' : 'on'}">${esc(label)}: <strong data-ch="${ch}">${on ? 'ON' : 'OFF'}</strong> <button type="submit" style="${on ? 'background:#888' : ''}">Turn ${esc(label.toLowerCase())} ${on ? 'off' : 'on'}</button></form>`;
  const instant = (t) => !t.approval_mode || !!t.instant_link_reply;
  const instTog = (t) => { const on = instant(t); return `<form method="post" action="/admin/channels" style="display:inline-block;margin:0 18px 8px 0">${hidden(csrf)}<input type="hidden" name="tenant" value="${esc(t.id)}"><input type="hidden" name="channel" value="instant"><input type="hidden" name="enabled" value="${on ? 'off' : 'on'}">Texts: <strong data-ch="instant">${on ? 'SEND INSTANTLY' : 'HOLD FOR REVIEW'}</strong> <button type="submit">${on ? 'Hold texts for review' : 'Send texts instantly'}</button></form>`; };
  const rows = tenants.map((t) => `<div><p><b>${esc(t.name || t.id)}</b> <small>${esc((t.numbers || [])[0] || '')}</small></p>${tog(t, 'sms', 'Texting', !!t.sms_enabled)}${tog(t, 'email', 'Email', !!t.email_enabled)}${instTog(t)}${!t.sms_enabled && !t.email_enabled ? '<p role="alert" style="color:#b00"><strong>Warning:</strong> texting and email are both off, so callers cannot receive links.</p>' : ''}</div>`).join('');
  const logRows = log.slice().reverse().slice(0, 50).map((e) => `<tr><td>${esc(e.at)}</td><td>${esc(e.tenant)}</td><td>${e.channel === 'sms' ? 'Texting' : e.channel === 'instant' ? 'Texts: send instantly' : 'Email'}</td><td>${e.enabled ? 'on' : 'off'}</td><td>${e.ok ? 'done' : esc('failed: ' + (e.error || ''))}</td></tr>`).join('');
  return `<h2>Texting and email</h2>${err ? `<p role="alert" style="color:#b00;background:#fff0f0;padding:8px"><strong>Could not change setting:</strong> ${esc(err)}</p>` : ''}${rows || '<p>No lines configured.</p>'}<p><small>Texts only ever go to the number the caller is calling from.</small></p>
<table><tr><th>Changed (UTC)</th><th>Line</th><th>Setting</th><th>To</th><th>Result</th></tr>${logRows || '<tr><td colspan="5">No changes yet.</td></tr>'}</table>`;
}
function dashboard({ csrf, nl, calls, q, now, tenants, channelLog, err }) {
  const t = now; const d7 = t - 7 * 86400000; const d30 = t - 30 * 86400000;
  const emailRows = nl.filter((r) => r.email_optin); const active = emailRows.filter((r) => r.email_optin === 'subscribed');
  const smsSubs = nl.filter((r) => r.sms_optin === 'subscribed').length; const smsPend = nl.filter((r) => r.sms_optin === 'pending').length; const smsStop = nl.filter((r) => r.sms_optin === 'unsubscribed').length;
  const k = (label, n) => `<span class="k"><b>${n}</b>${esc(label)}</span>`;
  const since = (x) => emailRows.filter((r) => Date.parse(r.confirmed_at) >= x).length;
  const nlRows = nl.slice().sort((a, b) => String(b.confirmed_at).localeCompare(String(a.confirmed_at))).map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.email)}</td><td>${esc(r.tenant)}</td><td>${esc(r.confirmed_at)}</td><td>${esc(r.source)}</td><td>${esc(r.confirm_ip)}</td><td>${esc(r.unsubscribed_at)}</td><td>${esc(r.phone)}</td><td>${esc(r.email_optin || '')}</td><td>${esc(r.sms_optin || '')}${r.sms_confirmed_at ? ' ' + esc(r.sms_confirmed_at) : ''}</td></tr>`).join('');
  const callRows = calls.slice(0, 500).map((r) => `<tr><td>${esc(r.at)}</td><td>${esc(r.caller || 'withheld')}</td><td>${r.seconds != null ? esc(r.seconds) + 's' : ''}</td><td>${esc(r.summary || '')}</td><td>${esc((r.tools || []).join(', '))}</td><td>${(r.emails || []).map((e) => esc(`${e.to_masked || '?'}: ${e.topic || 'links'}${e.ok ? '' : ' (failed)'}`)).join('<br>')}</td><td>${r.newsletter_optin ? 'yes' : ''}</td></tr>`).join('');
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
  return shell('CallBots admin', `<form method="post" action="/admin/logout" style="float:right">${hidden(csrf)}<button type="submit" style="background:#888">Sign out</button></form><h1>CallBots admin</h1>
<p><a href="/admin/messages?type=sms">Review texts</a> · <a href="/admin/messages?type=email">Review emails</a> · <a href="/admin/outbound"><b>Outbound &amp; owner briefing</b></a> <small>(exact copies of every text and email sent)</small></p>
${channelsSection(csrf, tenants, channelLog, err)}
<h2>Newsletter</h2>${k('email confirmed (active)', active.length)}${k('email unsubscribed', emailRows.length - active.length)}${k('news texts confirmed', smsSubs)}${k('news texts awaiting YES', smsPend)}${k('news texts stopped', smsStop)}${k('new, last 7 days', since(d7))}${k('new, last 30 days', since(d30))}
<p><a href="/admin/subscribers"><b>Manage subscribers</b></a> (search, edit, unsubscribe, merge, delete) · <a href="/admin/newsletter.csv">Download CSV</a> <small>(email and text consent per person: consent wording shown, source call, confirm time and reply, IP and browser when recorded)</small></p>
<table><tr><th>Name</th><th>Email</th><th>Tenant</th><th>Confirmed (UTC)</th><th>Source</th><th>Confirm IP</th><th>Unsubscribed</th><th>Phone</th><th>Email</th><th>News texts</th></tr>${nlRows || '<tr><td colspan="10">No subscribers yet.</td></tr>'}</table>
<h2>Call log</h2><form method="get" action="/admin">From <input type="date" name="from" value="${esc(q.from || '')}"> To <input type="date" name="to" value="${esc(q.to || '')}"> Number <input name="number" value="${esc(q.number || '')}" placeholder="digits, e.g. 727555"> <button type="submit">Filter</button> <a href="/admin">Clear</a></form>
<p>${calls.length} call(s). <a href="/admin/calls.csv${qs ? '?' + esc(qs) : ''}">Download CSV</a> · <a href="/admin/kb-gaps.csv">Unanswered questions (CSV)</a> · <a href="/admin/messages?type=sms">Review texts</a> · <a href="/admin/messages?type=email">Review emails</a> <small>Call records are kept ${CALL_RETENTION_DAYS} days. Times are UTC.</small></p>
<table><tr><th>Time (UTC)</th><th>Caller</th><th>Duration</th><th>Asked about</th><th>Tools</th><th>Emails sent</th><th>Newsletter opt-in</th></tr>${callRows || '<tr><td colspan="7">No calls recorded yet.</td></tr>'}</table>`);
}

module.exports = { shell, AdminAuth, CallRecords, callRecord, adminSecret, parseCookies, newsletterRows, toCsv, NL_COLS, CALL_COLS, callCsvRows, filterCalls, loginPage, authPage, msgPage, sentPage, dashboard, channelsSection, LINK_TTL_MS, SESSION_MS, CALL_RETENTION_DAYS, DEFAULT_ADMIN_EMAIL };
