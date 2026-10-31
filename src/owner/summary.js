'use strict';
// Builds the owner's daily briefing from the existing archives (read-only):
// call-records.jsonl, sent-messages.jsonl, owner-outbox.jsonl (messages + voicemails), kb-gaps.jsonl, owner-events.jsonl.
const fs = require('fs');
const { localParts } = require('./config');

function readJsonl(file) { if (!file) return []; let l = []; try { l = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; } const out = []; for (const x of l) { try { out.push(JSON.parse(x)); } catch { /* skip */ } } return out; }
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;


// ---- unanswered questions (privacy-scrubbed) ----
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const LONG_DIGITS = /(?:\+?\d[\s().-]*){7,}/g; // phone numbers, card numbers, long ids
const PIN_RE = /\b(pin|passcode|code|password)\b[\s:is#-]*\d{3,8}/gi;
const SHORT_DIGITS = /\b\d{4,6}\b/g; // possible PINs / partial cards (years like 2024 kept below)
function scrub(q, max = 140) {
  let s = String(q || '').replace(/\s+/g, ' ').trim();
  s = s.replace(EMAIL_RE, '[email]').replace(PIN_RE, '$1 [redacted]').replace(LONG_DIGITS, (m) => { const d = m.replace(/\D/g, ''); if (d.length >= 13) return ' [card number] '; return d.length >= 7 ? ' [number ending QLASTQ' + d.slice(-4) + '] ' : m; });
  s = s.replace(SHORT_DIGITS, (m) => (/^(19|20)\d\d$/.test(m) ? m : '[digits]')).replace(/QLASTQ/g, '').replace(/\s+/g, ' ').replace(/\s+([,.;?!])/g, '$1').trim();
  if (s.length > max) { const cut = s.slice(0, max); s = cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20)).replace(/[\s,;:.-]+$/, '') + '…'; }
  return s;
}
const norm = (q) => String(q || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const CHANNEL = { voice: 'call', sms: 'text', email: 'email' };
function timeIn(at, tz) { try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(at)) + ' ' + (tz === 'America/New_York' ? (new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName') || {}).value || '' : tz); } catch { return ''; } }

// One entry per (conversation, question). A model_unanswered note supersedes the raw no_match searches in the same conversation.
function unanswered({ gaps, calls, msgs, outbox, tz, limit = 25 }) {
  const byConv = new Map();
  for (const g of gaps) { const k = g.call || 'nocall:' + norm(g.question); if (!byConv.has(k)) byConv.set(k, []); byConv.get(k).push(g); }
  const picked = [];
  for (const list of byConv.values()) {
    const noted = list.filter((g) => g.reason === 'model_unanswered');
    const use = noted.length ? noted : list;
    const seen = new Set();
    for (const g of use) { const n = norm(g.question); if (!n || seen.has(n)) continue; seen.add(n); picked.push(g); }
  }
  picked.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const callById = new Map(calls.filter((c) => c.call).map((c) => [c.call, c]));
  return picked.slice(-limit).map((g) => {
    const after = (r) => r.at && Date.parse(r.at) >= Date.parse(g.at);
    const outcomes = [];
    const c = g.call && callById.get(g.call); const tl = (c && c.tools) || [];
    if (tl.includes('take_message') || outbox.some((o) => o.kind === 'message' && after(o) && (o.channel || 'voice') === (g.channel || 'voice') && g.from_last4 && String(o.from || '').replace(/\D/g, '').endsWith(g.from_last4))) outcomes.push('message taken');
    if (tl.includes('transfer_to_human')) outcomes.push('transfer attempted');
    const sent = msgs.filter((m) => g.call && m.call === g.call && after(m));
    if (sent.some((m) => m.channel === 'sms' && /https?:\/\//.test(m.text || '')) || (c && /^sent/.test(c.texts || ''))) outcomes.push('link texted');
    if (sent.some((m) => m.channel === 'email') || (c && (c.emails || []).some((e) => e.ok))) outcomes.push('link emailed');
    return { question: scrub(g.question), channel: CHANNEL[g.channel] || g.channel || 'unknown', time: timeIn(g.at, tz), at: g.at, caller_last4: g.from_last4 || null, outcome: outcomes.length ? outcomes.join(', ') : 'no follow-up recorded', reason: g.reason || null };
  });
}
const NUMWORD = ['one', 'two', 'three', 'four', 'five'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function collect({ tenant, files, now, tz }) {
  const day = localParts(now, tz).date;
  const sameDay = (r) => r && r.at && localParts(new Date(r.at), tz).date === day;
  const mine = (r) => !r.tenant || r.tenant === tenant.id;
  const calls = readJsonl(files.callRecords).filter((r) => mine(r) && sameDay(r) && r.direction !== 'outbound_owner');
  const msgs = readJsonl(files.sentMessages).filter((r) => mine(r) && sameDay(r));
  const outbox = readJsonl(files.outbox).filter((r) => r.tenant === tenant.id && sameDay(r));
  const gaps = readJsonl(files.kbGaps).filter((r) => mine(r) && sameDay(r));
  const events = readJsonl(files.events).filter((r) => r.tenant === tenant.id && sameDay(r));
  const texts = msgs.filter((r) => r.channel === 'sms'); const emails = msgs.filter((r) => r.channel === 'email');
  const inboundTexts = texts.filter((r) => r.inbound != null);
  const topicCount = new Map();
  for (const c of calls) for (const q of [...(c.kb_queries || []), ...(c.emails || []).map((e) => e.topic).filter(Boolean)]) { const k = String(q).toLowerCase().slice(0, 60); topicCount.set(k, (topicCount.get(k) || 0) + 1); }
  for (const g of gaps) { const k = String(g.question || '').toLowerCase().slice(0, 60); if (k) topicCount.set(k, (topicCount.get(k) || 0) + 1); }
  const topics = [...topicCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  const orderLookups = calls.filter((c) => (c.tools || []).includes('order_status')).length + events.filter((e) => e.kind === 'order_lookup').length;
  const messages = outbox.filter((o) => o.kind === 'message'); const voicemails = outbox.filter((o) => o.kind === 'voicemail');
  const failedSends = msgs.filter((r) => r.status && r.status !== 'sent').length;
  const errors = events.filter((e) => e.kind === 'error').length;
  const alerts = events.filter((e) => e.kind === 'alert');
  const followUps = messages.length + voicemails.length + alerts.filter((a) => !a.called).length + events.filter((e) => e.kind === 'transfer_missed').length;
  const unans = unanswered({ gaps, calls, msgs, outbox, tz });
  return { day, calls: calls.length, inboundTexts: inboundTexts.length, textsSent: texts.length - 0, emailsSent: emails.length, topics, orderLookups, messages: messages.length, voicemails: voicemails.length, failedSends, errors, alerts: alerts.length, followUps, gaps: unans.length, unanswered: unans };
}

// Spoken/text summary. No caller numbers, names, emails or message bodies: counts, topics and scrubbed unanswered questions.
function unansweredLine(list, total, max = 5) {
  const head = `${cap(total <= 5 ? NUMWORD[total - 1] : String(total))} ${total === 1 ? 'question' : 'questions'} we couldn't answer`;
  if (!list.length) return head + '.';
  const items = list.slice(0, max).map((u, i) => `${list.length > 1 ? NUMWORD[i] + ', ' : ''}${u.question.replace(/[.?!…]+$/, '')} (${u.channel}${u.time ? ', ' + u.time : ''}, ${u.outcome})`);
  return `${head}: ${items.join('; ')}.${total > max ? ` Plus ${total - max} more; ask me for the full list.` : ''}`;
}
// Written list for text/email copies.
function renderUnansweredList(list) { return list.length ? 'Unanswered questions:\n' + list.map((u, i) => `${i + 1}. ${u.question} (${u.channel}, ${u.time}${u.caller_last4 ? ', number ending ' + u.caller_last4 : ''}; ${u.outcome})`).join('\n') : ''; }

function render(s, opts = {}) {
  const { name } = opts;
  const parts = [`Here is today's summary${name && name !== 'there' ? ' for ' + name : ''}.`];
  parts.push(`${plural(s.calls, 'call')}, ${plural(s.inboundTexts, 'incoming text')}, ${plural(s.textsSent, 'text')} sent, and ${plural(s.emailsSent, 'email')} sent.`);
  if (s.topics.length) parts.push(`Main topics: ${s.topics.join('; ')}.`);
  if (s.orderLookups) parts.push(`${plural(s.orderLookups, 'order lookup')}.`);
  if (s.messages || s.voicemails) parts.push(`${plural(s.messages, 'message')} taken and ${plural(s.voicemails, 'voicemail')}.`);
  if (s.alerts) parts.push(`${plural(s.alerts, 'urgent alert')} today.`);
  parts.push(s.followUps ? `${plural(s.followUps, 'item')} need follow-up; details are in the admin dashboard.` : 'Nothing needs follow-up.');
  if (s.errors || s.failedSends) parts.push(`System: ${plural(s.errors, 'error')} and ${plural(s.failedSends, 'failed send')}.`);
  else parts.push('No system errors.');
  if (s.gaps) parts.push(unansweredLine(s.unanswered || [], s.gaps, opts.maxSpoken));
  return parts.join(' ');
}

module.exports = { collect, render, readJsonl, unanswered, scrub, renderUnansweredList };
