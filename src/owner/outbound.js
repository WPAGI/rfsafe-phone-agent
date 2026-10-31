'use strict';
// Admin "Outbound" page (/admin/outbound): owner PIN, unanswered questions by day, briefing preview,
// owner_briefing settings, recent owner calls and a confirmed test call. The PIN and its hash are never rendered.
const C = require('./config');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const last4 = (n) => String(n || '').replace(/\D/g, '').slice(-4);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function edt(at, tz = 'America/New_York') { try { const d = new Date(at); const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); return f.format(d); } catch { return ''; } }

// Parses the settings form into an owner_briefing patch. Returns { patch } or { errors }.
function parseSettings(f, cur) {
  const nums = String(f.owner_numbers || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean).map((x) => (/^\d{10}$/.test(x) ? '+1' + x : /^1\d{10}$/.test(x) ? '+' + x : x));
  const patch = { ...cur, enabled: f.enabled === 'on', daily_call: f.daily_call === 'on', daily_time: String(f.daily_time || ''), owner_numbers: nums,
    voice: f.voice === 'twilio' ? 'twilio' : 'grok', quiet_hours: { start: String(f.quiet_start || ''), end: String(f.quiet_end || '') },
    emergency_alerts: f.emergency_alerts === 'on', copy_sms: f.copy_sms === 'on', copy_email: f.copy_email === 'on' };
  const errors = C.validate(patch); return errors.length ? { errors } : { patch };
}

function page({ csrf, nonce, tenants, t, date, today, unanswered, preview, calls, pinSet, msg, err, audit, confirmCall }) {
  const s = C.settings(t); const h = `<input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="t" value="${esc(t.id)}">`;
  const chk = (k, on, label) => `<label><input type="checkbox" name="${k}"${on ? ' checked' : ''}> ${esc(label)}</label>`;
  const sel = tenants.length > 1 ? `<form method="get" action="/admin/outbound"><select name="t" aria-label="Tenant">${tenants.map((x) => `<option value="${esc(x.id)}"${x.id === t.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select> <button class="sm" type="submit">Switch</button></form>` : '';
  const uq = unanswered.map((u, i) => `<tr><td>${i + 1}</td><td>${esc(u.question)}</td><td>${esc(u.channel)}</td><td>${esc(u.time)}</td><td>${esc(u.outcome)}</td><td>${u.caller_last4 ? '…' + esc(u.caller_last4) : ''}</td></tr>`).join('');
  const cr = calls.map((c) => `<tr><td>${esc(edt(c.at, s.timezone))}</td><td>${esc(c.kind)}${c.alert ? ' (' + esc(c.alert) + ')' : ''}</td><td>…${esc(c.to_last4 || '')}</td><td>${esc(c.status || '')}</td><td>${c.seconds != null ? esc(c.seconds) + 's' : ''}</td></tr>`).join('');
  const au = (audit || []).map((a) => `<tr><td>${esc(edt(a.at, s.timezone))}</td><td>${esc(a.action)}</td><td>${esc(a.by || '')}</td></tr>`).join('');
  const own = C.ownerNumbers(t);
  return `<p><a href="/admin">← Dashboard</a></p><h1>Outbound &amp; owner briefing</h1>${sel}
${err ? `<p role="alert" style="color:#b00;background:#fff0f0;padding:8px">${esc(err)}</p>` : ''}${msg ? `<p role="status" style="background:#f0fff4;padding:8px">${esc(msg)}</p>` : ''}
<p><small>Briefing is <b>${C.enabled(t) ? 'ON' : 'OFF'}</b> · voice ${esc(C.voiceMode(t))} · PIN ${pinSet ? 'set' : '<b>not set</b>'}. Times are Eastern (${esc(s.timezone)}).</small></p>
<h2>Owner PIN</h2><form method="post" action="/admin/outbound/pin" autocomplete="off">${h}
<input type="password" name="pin" inputmode="numeric" pattern="\\d{4,8}" minlength="4" maxlength="8" placeholder="New PIN (4-8 digits)" aria-label="New PIN" required autocomplete="new-password">
<input type="password" name="pin_confirm" inputmode="numeric" pattern="\\d{4,8}" minlength="4" maxlength="8" placeholder="Confirm PIN" aria-label="Confirm PIN" required autocomplete="new-password">
<button type="submit" class="sm">${pinSet ? 'Change PIN' : 'Set PIN'}</button> <small>Stored hashed; never shown. Changes are written to the audit log.</small></form>
<h2>Unanswered questions</h2><form method="get" action="/admin/outbound"><input type="hidden" name="t" value="${esc(t.id)}"><input type="date" name="date" value="${esc(date)}" max="${esc(today)}" aria-label="Day"> <button type="submit" class="sm">Show</button>${date !== today ? ` <a href="/admin/outbound?t=${esc(encodeURIComponent(t.id))}">Today</a>` : ''}</form>
<table style="margin-top:8px"><tr><th>#</th><th>Question</th><th>Channel</th><th>Time</th><th>Outcome</th><th>Caller</th></tr>${uq || '<tr><td colspan="6">None for this day.</td></tr>'}</table>
<h2>Today's briefing (preview)</h2><blockquote style="background:#f6f6f6;padding:10px;white-space:pre-wrap">${esc(preview)}</blockquote>
<h2>Settings</h2><form method="post" action="/admin/outbound/settings">${h}
<p>${chk('enabled', C.enabled(t), 'Owner briefing enabled')} · ${chk('daily_call', s.daily_call, 'Daily call')} at <input type="time" name="daily_time" value="${esc(s.daily_time)}" aria-label="Daily time" required></p>
<p><label>Owner numbers <input name="owner_numbers" value="${esc(own.join(', '))}" size="40" aria-label="Owner numbers"></label> <small>E.164, comma separated, up to 5</small></p>
<p>Voice: <label><input type="radio" name="voice" value="grok"${C.voiceMode(t) === 'grok' ? ' checked' : ''}> Grok</label> <label><input type="radio" name="voice" value="twilio"${C.voiceMode(t) === 'twilio' ? ' checked' : ''}> Twilio</label></p>
<p>Quiet hours <input type="time" name="quiet_start" value="${esc(s.quiet_hours.start)}" aria-label="Quiet hours start" required> to <input type="time" name="quiet_end" value="${esc(s.quiet_hours.end)}" aria-label="Quiet hours end" required></p>
<p>${chk('emergency_alerts', s.emergency_alerts, 'Urgent alert calls')} · ${chk('copy_sms', s.copy_sms, 'Text copy')} · ${chk('copy_email', s.copy_email, 'Email copy')}</p>
<button type="submit" class="sm">Save settings</button></form>
<h2>Recent owner calls</h2><table><tr><th>When</th><th>Kind</th><th>To</th><th>Status</th><th>Duration</th></tr>${cr || '<tr><td colspan="5">No owner calls yet.</td></tr>'}</table>
${confirmCall ? `<form method="post" action="/admin/outbound/test-call" style="margin-top:10px;background:#fff8e6;padding:10px">${h}<input type="hidden" name="confirm" value="yes"><p>Place one test briefing call to <b>…${esc(last4(confirmCall))}</b> now?</p><input type="hidden" name="to" value="${esc(confirmCall)}"><button type="submit" class="sm">Yes, call now</button> <a href="/admin/outbound?t=${esc(encodeURIComponent(t.id))}">Cancel</a></form>`
    : `<form method="post" action="/admin/outbound/test-call" style="margin-top:10px">${h}<select name="to" aria-label="Number to call">${own.map((n) => `<option value="${esc(n)}">…${esc(last4(n))}</option>`).join('')}</select> <button type="submit" class="sm"${own.length ? '' : ' disabled'}>Place test call</button> <small>You will be asked to confirm.</small></form>`}
<h2>Audit log</h2><table><tr><th>When</th><th>Action</th><th>By</th></tr>${au || '<tr><td colspan="3">No changes yet.</td></tr>'}</table>
<style>.sm{font-size:13px;padding:5px 10px}</style>`;
}
module.exports = { page, parseSettings, DATE, edt };
