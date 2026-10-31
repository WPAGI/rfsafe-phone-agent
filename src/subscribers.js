'use strict';
// Admin subscriber management for the unified newsletter list (newsletter.jsonl, append-only events).
// Edits, merges and deletes rewrite the event file atomically and are written to an audit log with before/after.
// The page can only turn consent OFF (unsubscribe email, stop texts). It never creates an opt-in.
const fs = require('fs');
const path = require('path');
const { newsletterRows } = require('./admin');

const E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^\s@<>"']{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const low = (s) => String(s || '').trim().toLowerCase();
const keyOf = (r) => [r.tenant, low(r.email), r.phone || ''].join('|');
const pick = (r) => (r ? { tenant: r.tenant, name: r.name || '', email: r.email || '', phone: r.phone || '', email_optin: r.email_optin || '', sms_optin: r.sms_optin || '' } : null);

function readEvents(file) { let lines = []; try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; } const out = []; for (const l of lines) { try { out.push(JSON.parse(l)); } catch { /* skip */ } } return out; }
function writeEvents(file, evs) { const tmp = file + '.tmp-' + process.pid; fs.writeFileSync(tmp, evs.map((e) => JSON.stringify(e)).join('\n') + (evs.length ? '\n' : ''), { mode: 0o600 }); fs.renameSync(tmp, file); }
const belongs = (e, r) => e.tenant === r.tenant && ((r.email && low(e.email) === low(r.email)) || (r.phone && e.phone === r.phone));

class Subscribers {
  constructor({ file, auditFile, suppressionFile, now = () => Date.now() }) { Object.assign(this, { file, auditFile, suppressionFile, now }); }
  ts() { return new Date(this.now()).toISOString(); }
  // Every entry, including phone-linked rows with no active consent.
  list(q = '') {
    const rows = newsletterRows(this.file, { all: true }).map((r) => ({ ...r, key: keyOf(r) }));
    const s = low(q); const digits = s.replace(/\D/g, '');
    return rows.filter((r) => !s || low(r.name).includes(s) || low(r.email).includes(s) || (digits.length >= 3 && String(r.phone).replace(/\D/g, '').includes(digits)));
  }
  get(key) { return this.list().find((r) => r.key === key) || null; }
  audit(who, action, before, after, extra = {}) { fs.appendFileSync(this.auditFile, JSON.stringify({ at: this.ts(), who: who || 'admin', action, before: pick(before), after: pick(after), ...extra }) + '\n', { mode: 0o600 }); }
  edit(key, { name, email, phone }, who) {
    const r = this.get(key); if (!r) return { ok: false, error: 'not_found' };
    const nm = name == null ? r.name : String(name).replace(/[^\p{L} '\-.]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const em = email == null ? r.email : low(email); const ph = phone == null ? r.phone : String(phone).replace(/[^\d+]/g, '');
    if (em && !EMAIL.test(em)) return { ok: false, error: 'invalid_email' };
    if (ph && !E164.test(ph)) return { ok: false, error: 'invalid_phone' };
    if (!em && !ph) return { ok: false, error: 'need_email_or_phone' };
    const clash = this.list().find((x) => x.key !== key && x.tenant === r.tenant && ((em && low(x.email) === em) || (ph && x.phone === ph)));
    if (clash) return { ok: false, error: 'already_exists_use_merge' };
    const evs = readEvents(this.file); const at = this.ts();
    for (const e of evs) if (belongs(e, r)) {
      if ('email' in e && r.email && low(e.email) === low(r.email)) e.email = em || null;
      if ('phone' in e && r.phone && e.phone === r.phone) e.phone = ph || null;
      if (e.kind === 'confirmed' && nm !== r.name) e.name = nm;
    }
    // Consent belongs to the address/number it was given for: a changed address or number is not subscribed until it opts in again.
    if (r.email && em && em !== low(r.email) && r.email_optin === 'subscribed') evs.push({ at, kind: 'unsubscribed', tenant: r.tenant, email: em, reason: 'admin_email_changed_reconfirm_needed' });
    if (r.phone && ph && ph !== r.phone && (r.sms_optin === 'subscribed' || r.sms_optin === 'pending')) evs.push({ at, kind: 'sms_stopped', tenant: r.tenant, phone: ph, reason: 'admin_phone_changed_reconfirm_needed' });
    if (nm !== r.name) evs.push({ at, kind: 'profile', tenant: r.tenant, email: em || null, phone: ph || null, name: nm, source: 'admin' });
    if (em && ph && !(r.email && r.phone)) evs.push({ at, kind: 'link', tenant: r.tenant, email: em, phone: ph, source: 'admin' });
    writeEvents(this.file, evs);
    const after = this.list().find((x) => x.tenant === r.tenant && ((em && low(x.email) === em) || (!em && x.phone === ph)));
    this.audit(who, 'edit', r, after); return { ok: true, key: after && after.key };
  }
  unsubscribe(key, channel, who) {
    const r = this.get(key); if (!r) return { ok: false, error: 'not_found' };
    const at = this.ts();
    if (channel === 'email') { if (r.email_optin !== 'subscribed') return { ok: false, error: 'not_subscribed' }; fs.appendFileSync(this.file, JSON.stringify({ at, kind: 'unsubscribed', tenant: r.tenant, email: low(r.email), reason: 'admin' }) + '\n'); }
    else if (channel === 'sms') { if (!['subscribed', 'pending'].includes(r.sms_optin)) return { ok: false, error: 'not_subscribed' }; fs.appendFileSync(this.file, JSON.stringify({ at, kind: 'sms_stopped', tenant: r.tenant, phone: r.phone, reason: 'admin' }) + '\n'); }
    else return { ok: false, error: 'bad_channel' };
    this.audit(who, channel === 'email' ? 'unsubscribe_email' : 'stop_texts', r, this.get(key)); return { ok: true };
  }
  // Merge `fromKey` into `intoKey` (e.g. a phone-only row into an email row). Refuses two different emails or two different phones.
  merge(intoKey, fromKey, who) {
    const a = this.get(intoKey); const b = this.get(fromKey);
    if (!a || !b) return { ok: false, error: 'not_found' }; if (a.key === b.key || a.tenant !== b.tenant) return { ok: false, error: 'cannot_merge' };
    if (a.email && b.email && low(a.email) !== low(b.email)) return { ok: false, error: 'two_different_emails' };
    if (a.phone && b.phone && a.phone !== b.phone) return { ok: false, error: 'two_different_phones' };
    const email = a.email || b.email; const phone = a.phone || b.phone;
    const evs = readEvents(this.file);
    for (const e of evs) if (belongs(e, b) && !e.name && e.kind === 'confirmed' && a.name) e.name = a.name;
    if (!a.name && b.name) evs.push({ at: this.ts(), kind: 'profile', tenant: a.tenant, email: email ? low(email) : null, phone: phone || null, name: b.name, source: 'admin_merge' });
    if (email && phone) evs.push({ at: this.ts(), kind: 'link', tenant: a.tenant, email: low(email), phone, source: 'admin_merge' });
    writeEvents(this.file, evs);
    const after = this.list().find((x) => x.tenant === a.tenant && ((email && low(x.email) === low(email)) || (!email && x.phone === phone)));
    this.audit(who, 'merge', a, after, { merged_from: pick(b) }); return { ok: true, key: after && after.key };
  }
  // Delete removes the entry's events. If it ever opted out, a minimal suppression + proof record is kept so STOP stays honored.
  remove(key, who) {
    const r = this.get(key); if (!r) return { ok: false, error: 'not_found' };
    const evs = readEvents(this.file); const mine = evs.filter((e) => belongs(e, r)); const keep = evs.filter((e) => !belongs(e, r));
    const stops = mine.filter((e) => e.kind === 'unsubscribed' || e.kind === 'sms_stopped').map((e) => ({ at: e.at, kind: e.kind, tenant: e.tenant, ...(e.kind === 'unsubscribed' ? { email: low(e.email) } : { phone: e.phone }) }));
    keep.push(...stops); // invisible on the list (no opt-in left), but readers still see the opt-out
    writeEvents(this.file, keep);
    if (stops.length && this.suppressionFile) for (const s of stops) fs.appendFileSync(this.suppressionFile, JSON.stringify({ at: this.ts(), opted_out_at: s.at, tenant: s.tenant, channel: s.kind === 'unsubscribed' ? 'email' : 'sms', ...(s.email ? { email: s.email } : { phone: s.phone }), reason: 'entry_deleted_keep_opt_out' }) + '\n', { mode: 0o600 });
    this.audit(who, 'delete', r, null, { kept_opt_out_records: stops.length }); return { ok: true, kept_opt_out_records: stops.length };
  }
  auditLog(n = 100) { return readEvents(this.auditFile).slice(-n).reverse(); }
}
module.exports = { Subscribers, keyOf };

// ---- Admin page ----
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BADGE = { subscribed: ['#0b5', 'subscribed'], pending: ['#c80', 'awaiting YES'], unsubscribed: ['#888', 'unsubscribed'], '': ['#bbb', 'none'] };
const badge = (v) => { const [c, l] = BADGE[v || ''] || BADGE['']; return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${c};color:#fff;font-size:12px">${esc(l)}</span>`; };
const MSG = { not_found: 'That entry no longer exists. Reload the page.', invalid_email: 'That email address is not valid.', invalid_phone: 'Phone must be in +1XXXXXXXXXX format.', need_email_or_phone: 'An entry needs an email or a phone number.', already_exists_use_merge: 'Another entry already has that email or phone. Use Merge instead.', two_different_emails: 'Both entries have different emails, so they cannot be merged.', two_different_phones: 'Both entries have different phone numbers, so they cannot be merged.', cannot_merge: 'Pick two different entries to merge.', not_subscribed: 'That channel is already off.', bad_channel: 'Unknown channel.' };
function subscribersPage({ csrf, nonce, rows, q, msg, err, audit }) {
  const h = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
  const opts = (self) => rows.filter((x) => x.key !== self.key).map((x) => `<option value="${esc(x.key)}">${esc([x.name, x.email, x.phone].filter(Boolean).join(' · '))}</option>`).join('');
  const tr = rows.map((r) => `<tr>
<td><form method="post" action="/admin/subscribers/edit" class="row">${h}<input type="hidden" name="key" value="${esc(r.key)}">
<input name="name" value="${esc(r.name)}" placeholder="Name" aria-label="Name" size="12"> <input name="email" value="${esc(r.email)}" placeholder="email" aria-label="Email" size="22"> <input name="phone" value="${esc(r.phone)}" placeholder="+1…" aria-label="Phone" size="13"> <button type="submit" class="sm">Save</button></form>
<small>${esc(r.tenant)} · source ${esc(r.source || 'phone')}${r.sms_call ? ' · call ' + esc(r.sms_call) : ''}</small></td>
<td>${badge(r.email_optin)}<br><small>${r.confirmed_at ? 'confirmed ' + esc(r.confirmed_at) : ''}${r.unsubscribed_at ? '<br>unsubscribed ' + esc(r.unsubscribed_at) : ''}</small>${r.email_optin === 'subscribed' ? `<form method="post" action="/admin/subscribers/unsubscribe">${h}<input type="hidden" name="key" value="${esc(r.key)}"><input type="hidden" name="channel" value="email"><button type="submit" class="sm grey">Unsubscribe email</button></form>` : ''}</td>
<td>${badge(r.sms_optin)}<br><small>${r.sms_requested_at ? 'invited ' + esc(r.sms_requested_at) : ''}${r.sms_confirmed_at ? '<br>YES ' + esc(r.sms_confirmed_at) : ''}${r.sms_stopped_at ? '<br>stopped ' + esc(r.sms_stopped_at) : ''}</small>${['subscribed', 'pending'].includes(r.sms_optin) ? `<form method="post" action="/admin/subscribers/unsubscribe">${h}<input type="hidden" name="key" value="${esc(r.key)}"><input type="hidden" name="channel" value="sms"><button type="submit" class="sm grey">Stop texts</button></form>` : ''}</td>
<td>${rows.length > 1 ? `<form method="post" action="/admin/subscribers/merge">${h}<input type="hidden" name="into" value="${esc(r.key)}"><select name="from" aria-label="Merge another entry into this one"><option value="">Merge into this…</option>${opts(r)}</select> <button type="submit" class="sm">Merge</button></form>` : ''}
<form method="post" action="/admin/subscribers/delete" class="del" data-label="${esc([r.name, r.email, r.phone].filter(Boolean).join(' · '))}">${h}<input type="hidden" name="key" value="${esc(r.key)}"><input type="hidden" name="confirm" value=""><button type="submit" class="sm red">Delete</button></form></td></tr>`).join('');
  const au = (audit || []).slice(0, 30).map((a) => `<tr><td>${esc(a.at)}</td><td>${esc(a.action)}</td><td>${esc(a.before ? [a.before.name, a.before.email, a.before.phone].filter(Boolean).join(' · ') : '')}${a.merged_from ? ' ← ' + esc([a.merged_from.name, a.merged_from.email, a.merged_from.phone].filter(Boolean).join(' · ')) : ''}</td><td>${esc(a.after ? [a.after.name, a.after.email, a.after.phone, 'email ' + (a.after.email_optin || 'none'), 'texts ' + (a.after.sms_optin || 'none')].filter(Boolean).join(' · ') : 'deleted')}</td></tr>`).join('');
  return `<p><a href="/admin">← Dashboard</a></p><h1>Subscribers</h1>
<p><small>One entry per person. The phone number stays linked to the name and email even when texts are off; email and text consent are separate. This page can only turn consent <b>off</b>; people opt in themselves (email confirmation link, or reply YES). Every change is written to the audit log. Times are UTC.</small></p>
${err ? `<p role="alert" style="color:#b00;background:#fff0f0;padding:8px">${esc(err)}</p>` : ''}${msg ? `<p role="status" style="background:#f0fff4;padding:8px">${esc(msg)}</p>` : ''}
<form method="get" action="/admin/subscribers"><input name="q" value="${esc(q)}" placeholder="Search name, email or phone" aria-label="Search" size="34"> <button type="submit" class="sm">Search</button> ${q ? '<a href="/admin/subscribers">Clear</a>' : ''} <small>${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}</small> · <a href="/admin/newsletter.csv">Download CSV</a></form>
<table style="margin-top:10px"><tr><th>Person (name, email, phone)</th><th>Email newsletter</th><th>News texts</th><th>Merge / delete</th></tr>${tr || '<tr><td colspan="4">No entries.</td></tr>'}</table>
<h2>Audit log</h2><p><small>Last 30 changes (who: signed-in admin). Kept in DATA_DIR/subscriber-audit.jsonl.</small></p>
<table><tr><th>When (UTC)</th><th>Action</th><th>Before</th><th>After</th></tr>${au || '<tr><td colspan="4">No changes yet.</td></tr>'}</table>
<style>.sm{font-size:13px;padding:5px 10px}.grey{background:#888}.red{background:#c33}form.row input{font-size:13px;padding:4px}td form{margin:4px 0}</style>
<script nonce="${esc(nonce)}">document.querySelectorAll('form.del').forEach(function(f){f.addEventListener('submit',function(e){if(!window.confirm('Delete '+f.dataset.label+'? This removes the entry. Opt-out records are kept so STOP stays honored.')){e.preventDefault();return}f.querySelector('input[name=confirm]').value='yes'})});</script>`;
}
function confirmDeletePage({ csrf, r }) {
  return `<p><a href="/admin/subscribers">← Subscribers</a></p><h1>Delete this entry?</h1><p><b>${esc([r.name, r.email, r.phone].filter(Boolean).join(' · '))}</b></p><p>This removes the entry. If it ever opted out, a minimal opt-out record is kept so STOP stays honored.</p>
<form method="post" action="/admin/subscribers/delete"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="key" value="${esc(r.key)}"><input type="hidden" name="confirm" value="yes"><button type="submit" style="background:#c33">Yes, delete</button> <a href="/admin/subscribers">Cancel</a></form>`;
}
module.exports.subscribersPage = subscribersPage; module.exports.confirmDeletePage = confirmDeletePage; module.exports.MSG = MSG;
