'use strict';
// PIN-gated owner feedback. Append-only, per tenant, on disk. Records stay unreviewed
// (approval false) no matter what the file or the model claims. Content is untrusted data.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { safeEq } = require('../util');

const FEEDBACK_QUESTION = 'Would you like to leave any feedback for the team?';
const SCOPE = 'owner_feedback:read';
const PROV = /^[a-z0-9_.:-]{1,64}$/;

function redactFeedback(s) {
  let t = String(s || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  t = t.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]');
  t = t.replace(/(?:\d[ -]?){13,19}/g, '[redacted]');
  t = t.replace(/\+?\d[\d\s().-]{8,}\d/g, (m) => (m.replace(/\D/g, '').length >= 10 ? '[phone]' : m));
  t = t.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted]');
  t = t.replace(/\b\d{4,8}\b/g, '[redacted]');
  return t.replace(/\s+/g, ' ').trim().slice(0, 2000);
}

function present(rec, tenant) {
  if (!rec || rec._unreadable || rec.tenant !== tenant) return null;
  const provenance = PROV.test(String(rec.provenance || '')) ? String(rec.provenance) : 'unknown';
  return {
    id: String(rec.id || '').slice(0, 80),
    at: typeof rec.at === 'string' ? rec.at.slice(0, 40) : null,
    tenant,
    call_id: rec.call_id == null ? null : String(rec.call_id).slice(0, 80),
    content: String(rec.content || '').slice(0, 2000),
    status: 'unreviewed',
    approval: false,
    provenance,
    kb_applied: false,
    email_sent: false,
    untrusted: true,
  };
}

function readRaw(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { out.push({ _unreadable: true }); }
  }
  return out;
}

function durableAppend(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.chmodSync(file, 0o600);
}

class FeedbackStore {
  constructor({ file, write = null } = {}) { this.file = file; this.write = write; }
  append(rec) {
    if (!this.file) throw new Error('no_feedback_file');
    if (!rec || rec.tenant == null || rec.approval !== false || rec.status !== 'unreviewed' || rec.kb_applied !== false || rec.email_sent !== false) throw new Error('refused_record');
    const line = JSON.stringify(rec) + '\n';
    if (this.write) this.write(this.file, line); else durableAppend(this.file, line);
    const seen = readRaw(this.file).filter((r) => r && r.id === rec.id && r.tenant === rec.tenant);
    if (seen.length !== 1) throw new Error('persist_unconfirmed');
    const shown = present(seen[0], rec.tenant);
    if (!shown || shown.approval !== false || shown.status !== 'unreviewed' || shown.kb_applied !== false) throw new Error('persist_unconfirmed');
    return shown;
  }
  read(tenant) {
    if (!tenant || !this.file) return [];
    return readRaw(this.file).map((r) => present(r, tenant)).filter(Boolean);
  }
}

function mintReviewToken(secret, tenant, expMs) {
  if (!secret || String(secret).length < 16) throw new Error('review_secret_not_configured');
  if (!tenant || typeof expMs !== 'number') throw new Error('invalid');
  const body = Buffer.from(JSON.stringify({ v: 1, t: tenant, exp: expMs, s: SCOPE })).toString('base64url');
  const mac = crypto.createHmac('sha256', String(secret)).update(body).digest('base64url');
  return 'rv1.' + body + '.' + mac;
}

// Scoped read token for one tenant. The master admin token is never accepted.
// wrong_tenant is returned only after the signature checks out, and never with another tenant's rows.
function verifyReviewToken(secret, token, tenant, nowMs, adminToken) {
  const tok = String(token || '');
  if (adminToken && tok && safeEq(tok, adminToken)) return { ok: false, reason: 'unauthorized' };
  if (!secret || String(secret).length < 16 || !tok) return { ok: false, reason: 'unauthorized' };
  const m = /^rv1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(tok);
  if (!m) return { ok: false, reason: 'unauthorized' };
  const expect = crypto.createHmac('sha256', String(secret)).update(m[1]).digest('base64url');
  if (!safeEq(m[2], expect)) return { ok: false, reason: 'unauthorized' };
  let p; try { p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'unauthorized' }; }
  if (!p || p.v !== 1 || p.s !== SCOPE || typeof p.exp !== 'number' || p.exp < nowMs) return { ok: false, reason: 'unauthorized' };
  if (p.t !== tenant) return { ok: false, reason: 'wrong_tenant' };
  return { ok: true, tenant: p.t, scope: SCOPE };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function reviewPage({ tenant, tenants, items }) {
  const opts = (tenants || []).map((x) => `<option value="${esc(x.id)}"${tenant && x.id === tenant.id ? ' selected' : ''}>${esc(x.name || x.id)}</option>`).join('');
  const rows = (items || []).map((r) => `<tr><td>${esc(r.at)}</td><td>${esc(r.call_id || '')}</td><td>${esc(r.provenance)}</td><td>unreviewed</td><td>false</td><td><pre style="white-space:pre-wrap;margin:0">${esc(r.content)}</pre></td></tr>`).join('');
  const which = tenant ? esc(tenant.name || tenant.id) : 'Choose a line';
  return `<p><a href="/admin">← Dashboard</a></p><h1>Owner feedback</h1>
<p><small>Read only. Every item is <b>unreviewed</b> and <b>approval is false</b>. This page does not edit the knowledge base and does not send email. Feedback text is untrusted data, shown as text.</small></p>
<form method="get" action="/admin/owner-feedback"><label>Line <select name="tenant">${opts}</select></label> <button type="submit">Show</button></form>
<h2>${which}</h2>
<table><tr><th>Time (UTC)</th><th>Call</th><th>Provenance</th><th>Status</th><th>Approval</th><th>Feedback</th></tr>${tenant ? (rows || '<tr><td colspan="6">No feedback stored for this line.</td></tr>') : '<tr><td colspan="6">Choose a line. Feedback for other lines is not shown here.</td></tr>'}</table>`;
}

module.exports = { FEEDBACK_QUESTION, SCOPE, redactFeedback, present, FeedbackStore, mintReviewToken, verifyReviewToken, reviewPage, readRaw };
