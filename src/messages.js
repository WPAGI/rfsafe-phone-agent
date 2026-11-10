'use strict';
// Sent-message archive for admin quality review: an exact copy of every text and email the bot sends
// (or fails to send). Admin-only (session cookie). Kept 180 days like the call log. No secrets are stored:
// only what went to the caller, plus the provider's message id.
const fs = require('fs');
const { appendJsonl, fp, maskPhone } = require('./util');

const MSG_RETENTION_DAYS = 180;
const PAGE_SIZE = 50;
const BODY_MAX = 100000;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
function extractLinks(...texts) { const s = new Set(); for (const t of texts) for (const m of String(t || '').match(URL_RE) || []) s.add(m.replace(/[.,;:!?]+$/, '').replace(/&amp;/g, '&')); return [...s]; }
const cap = (s) => (s == null ? null : String(s).slice(0, BODY_MAX));

class SentMessages {
  constructor({ file, legacyEmailFile = null, now = () => Date.now(), retentionDays = MSG_RETENTION_DAYS }) { this.file = file; this.legacyEmailFile = legacyEmailFile; this.now = now; this.keepMs = retentionDays * 86400000; this.lastPrune = 0; this.seq = 0; }
  // rec: { channel, tenant, call, to, subject, text, html, status, error, provider_id, caller }
  add(r) {
    if (!this.file) return null;
    const at = new Date(this.now()).toISOString();
    const rec = {
      id: Date.parse(at).toString(36) + '-' + (++this.seq).toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      at, channel: r.channel === 'email' ? 'email' : 'sms', tenant: r.tenant || null, call: r.call || null, to: r.to || null,
      subject: r.subject || null, text: cap(r.text), html: r.channel === 'email' ? cap(r.html) : null,
      links: r.links || extractLinks(r.text, r.html), provider_id: r.provider_id || null,
      status: r.status || (r.error ? 'failed' : 'sent'), error: r.error ? String(r.error).slice(0, 200) : null,
      caller_fp: r.caller ? fp(r.caller) : null,
      ...(r.inbound != null ? { inbound: cap(r.inbound) } : {}),
    };
    try { appendJsonl(this.file, rec); } catch { return null; }
    if (this.now() - this.lastPrune > 86400000) { try { this.prune(); } catch { /* ignore */ } }
    return rec;
  }
  // Inbound texts (what the caller sent), stored so a reply's detail page can show what it answered. Kept with the same retention.
  addInbound({ tenant, call, from, text }) {
    if (!this.file) return null;
    const at = new Date(this.now()).toISOString();
    const rec = { id: Date.parse(at).toString(36) + '-' + (++this.seq).toString(36) + '-' + Math.random().toString(36).slice(2, 6), at, channel: 'sms_in', tenant: tenant || null, call: call || null, from: from || null, text: cap(text), caller_fp: from ? fp(from) : null };
    try { appendJsonl(this.file, rec); } catch { return null; }
    return rec;
  }
  inbound() { return this.read().filter((r) => r.channel === 'sms_in'); }
  readFile(f) { let l = []; try { l = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } const out = []; for (const x of l) { try { out.push(JSON.parse(x)); } catch { /* skip */ } } return out; }
  read() { return this.readFile(this.file); }
  // Emails sent before the archive existed: email.jsonl has masked recipient, links, status, provider id, but no body.
  legacyEmails() {
    if (!this.legacyEmailFile) return [];
    const cut = this.now() - this.keepMs;
    return this.readFile(this.legacyEmailFile).filter((r) => (r.kind === 'sent' || r.kind === 'send_failed') && Date.parse(r.at) >= cut).map((r, i) => ({
      id: 'legacy-' + Date.parse(r.at).toString(36) + '-' + i, at: r.at, channel: 'email', tenant: r.tenant || null, call: r.call || null, to: r.to_masked || null,
      subject: null, text: null, html: null, links: r.links || [], provider_id: r.provider_id || null, status: r.kind === 'sent' ? 'sent' : 'failed', error: r.reason || null, caller_fp: r.caller_fp || null, legacy: true,
    }));
  }
  list(channel) {
    let all = this.read().filter((r) => r.channel === channel);
    if (channel === 'email') {
      const have = new Set(all.map((r) => r.provider_id).filter(Boolean));
      const first = all.length ? all.reduce((m, r) => (r.at < m ? r.at : m), all[0].at) : null;
      all = all.concat(this.legacyEmails().filter((r) => !(r.provider_id && have.has(r.provider_id)) && (!first || r.at < first)));
    }
    return all.reverse().sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }
  get(id) { return this.list('sms').concat(this.list('email')).find((r) => r.id === id) || null; }
  prune() {
    this.lastPrune = this.now(); const cut = this.now() - this.keepMs; const all = this.read(); const keep = all.filter((r) => Date.parse(r.at) >= cut);
    if (keep.length !== all.length) { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''), { mode: 0o600 }); fs.renameSync(tmp, this.file); }
  }
}

// The inbound text an outbound SMS reply answered, among inbound records at or before the reply (same line):
// 1) same call/conversation id, 2) same caller fingerprint, 3) nearest prior inbound. The latest candidate wins in each tier.
// A reply that carries its own copy of the question (r.inbound, stored since async SMS replies) is used when no record matches by id.
function inReplyTo(r, inbound) {
  if (!r || r.channel !== 'sms') return null;
  const t = Date.parse(r.at);
  const prior = (inbound || []).filter((x) => x.channel === 'sms_in' && Date.parse(x.at) <= t && (!r.tenant || !x.tenant || x.tenant === r.tenant)).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const byCall = r.call ? prior.find((x) => x.call === r.call) : null; if (byCall) return { ...byCall, match: 'call' };
  if (r.inbound != null) return { at: null, text: r.inbound, from: r.to, caller_fp: r.caller_fp, match: 'reply' };
  const byFp = r.caller_fp ? prior.find((x) => x.caller_fp === r.caller_fp) : null; if (byFp) return { ...byFp, match: 'caller' };
  return prior[0] ? { ...prior[0], match: 'nearest' } : null;
}
const MATCH_LABEL = { call: 'same conversation', reply: 'stored with the reply', caller: 'same caller', nearest: 'nearest earlier text (not confirmed)' };

// ---- views ----
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
function etTime(iso) { const t = Date.parse(iso); return Number.isFinite(t) ? ET.format(new Date(t)) : String(iso || ''); }
const label = (ch) => (ch === 'email' ? 'emails' : 'texts');
function preview(r) { if (r.legacy) return '(sent before the archive existed; content not stored)'; const s = r.channel === 'email' ? (r.subject || '') : String(r.text || '').replace(/\s+/g, ' '); return s.length > 120 ? s.slice(0, 117) + '...' : s; }
function statusCell(r) { if (r.status === 'accepted') return 'accepted by provider (delivery not confirmed)'; return r.status === 'sent' ? 'sent' : `<span style="color:#b00">${esc(r.status)}${r.error ? ': ' + esc(r.error) : ''}</span>`; }

function listPage({ shell, channel, rows, page }) {
  const total = rows.length; const pages = Math.max(1, Math.ceil(total / PAGE_SIZE)); const p = Math.min(Math.max(1, page || 1), pages);
  const slice = rows.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
  const tr = slice.map((r) => `<tr><td><a href="/admin/messages?type=${channel}&amp;id=${encodeURIComponent(r.id)}">${esc(etTime(r.at))}</a></td><td>${esc(r.to || '')}</td><td>${esc(preview(r))}</td><td>${(r.links || []).length}</td><td>${statusCell(r)}</td></tr>`).join('');
  const nav = (n, txt) => `<a href="/admin/messages?type=${channel}&amp;page=${n}">${txt}</a>`;
  const pager = pages > 1 ? `<p>${p > 1 ? nav(p - 1, '&larr; Newer') : ''} Page ${p} of ${pages} ${p < pages ? nav(p + 1, 'Older &rarr;') : ''}</p>` : '';
  const other = channel === 'email' ? '<a href="/admin/messages?type=sms">Review texts</a>' : '<a href="/admin/messages?type=email">Review emails</a>';
  const title = channel === 'email' ? 'Review emails' : 'Review texts';
  return shell(title, `<p><a href="/admin">&larr; Dashboard</a> · ${other}</p><h1>${title}</h1>
<p>${total} ${label(channel)}. <a href="/admin/messages.csv?type=${channel}">Download CSV</a> <small>Exact copies of what was sent, kept ${MSG_RETENTION_DAYS} days. Times are Eastern.</small></p>${pager}
<table><tr><th>Time (ET)</th><th>Recipient</th><th>${channel === 'email' ? 'Subject' : 'Message'}</th><th>Links</th><th>Status</th></tr>${tr || `<tr><td colspan="5">No ${label(channel)} recorded yet.</td></tr>`}</table>${pager}`);
}
function inReplySection(r, inbound) {
  if (r.channel !== 'sms' || r.legacy) return '';
  const m = inReplyTo(r, inbound);
  const pre = (t) => `<pre style="white-space:pre-wrap;background:#f7f7f7;padding:10px;border:1px solid #ddd">${esc(t)}</pre>`;
  if (!m) { const first = (inbound || []).reduce((a, x) => (!a || x.at < a ? x.at : a), null); return `<details><summary>In reply to</summary><p><em>Original text not stored${first ? ' (before ' + esc(etTime(first)) + ')' : ' (inbound texts are stored from now on)'}.</em></p></details>`; }
  const kv = (k, v) => `<tr><th style="width:160px">${esc(k)}</th><td>${v}</td></tr>`;
  return `<details><summary>In reply to</summary><table>${m.at ? kv('Time (ET)', esc(etTime(m.at))) + kv('Time (UTC)', esc(m.at)) : kv('Time', 'not recorded (copy stored with the reply)')}${kv('Sender', esc(maskPhone(m.from || '')))}${kv('Caller fingerprint', esc(m.caller_fp || ''))}${kv('Matched by', esc(MATCH_LABEL[m.match]))}</table>${pre(m.text || '')}</details>`;
}
function detailPage({ shell, r, inbound = [] }) {
  const ch = r.channel; const back = `/admin/messages?type=${ch}`;
  const kv = (k, v) => `<tr><th style="width:160px">${esc(k)}</th><td>${v}</td></tr>`;
  const links = (r.links || []).map((l) => `<li><code>${esc(l)}</code></li>`).join('');
  const body = r.legacy ? '<p><em>This email was sent before the message archive existed, so only the summary below was recorded (recipient masked, no body).</em></p>'
    : ch === 'email'
      ? `<h2>Plain text (exact)</h2><pre style="white-space:pre-wrap;background:#f7f7f7;padding:10px;border:1px solid #ddd">${esc(r.text || '')}</pre><h2>HTML (exact source)</h2><pre style="white-space:pre-wrap;background:#f7f7f7;padding:10px;border:1px solid #ddd">${esc(r.html || '')}</pre>`
      : `<h2>Text (exact)</h2><pre style="white-space:pre-wrap;background:#f7f7f7;padding:10px;border:1px solid #ddd">${esc(r.text || '')}</pre><p><small>${String(r.text || '').length} characters</small></p>`;
  return shell(ch === 'email' ? 'Email' : 'Text', `<p><a href="${back}">&larr; Back to ${label(ch)}</a></p><h1>${ch === 'email' ? 'Email' : 'Text message'}</h1>
<table>${kv('Time (ET)', esc(etTime(r.at)))}${kv('Time (UTC)', esc(r.at))}${kv('Status', statusCell(r))}${kv('Recipient', esc(r.to || ''))}${ch === 'email' ? kv('Subject', esc(r.subject || '')) : ''}${kv('Line', esc(r.tenant || ''))}${kv('Call id', esc(r.call || ''))}${kv('Caller fingerprint', esc(r.caller_fp || ''))}${kv('Provider message id', esc(r.provider_id || ''))}</table>
${inReplySection(r, inbound)}<h2>Links (${(r.links || []).length})</h2>${links ? `<ul>${links}</ul>` : '<p>None.</p>'}${body}`);
}
const MSG_COLS = ['at', 'at_et', 'channel', 'status', 'error', 'tenant', 'call', 'to', 'subject', 'text', 'html', 'links', 'provider_id', 'caller_fp', 'legacy', 'inbound'];
const csvRows = (rows) => rows.map((r) => ({ ...r, at_et: etTime(r.at), links: (r.links || []).join(' '), legacy: r.legacy ? 'yes' : '' }));

module.exports = { SentMessages, inReplyTo, extractLinks, listPage, detailPage, etTime, MSG_COLS, csvRows, MSG_RETENTION_DAYS, PAGE_SIZE };
