'use strict';
// Builds the owner's daily briefing from the existing archives (read-only):
// call-records.jsonl, sent-messages.jsonl, owner-outbox.jsonl (messages + voicemails), kb-gaps.jsonl, owner-events.jsonl.
const fs = require('fs');
const { localParts } = require('./config');

function readJsonl(file) { if (!file) return []; let l = []; try { l = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; } const out = []; for (const x of l) { try { out.push(JSON.parse(x)); } catch { /* skip */ } } return out; }
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;

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
  return { day, calls: calls.length, inboundTexts: inboundTexts.length, textsSent: texts.length - 0, emailsSent: emails.length, topics, orderLookups, messages: messages.length, voicemails: voicemails.length, failedSends, errors, alerts: alerts.length, followUps, gaps: gaps.length };
}

// Spoken/text summary. No caller numbers, names, emails or message bodies: counts and topics only.
function render(s, { name } = {}) {
  const parts = [`Here is today's summary${name && name !== 'there' ? ' for ' + name : ''}.`];
  parts.push(`${plural(s.calls, 'call')}, ${plural(s.inboundTexts, 'incoming text')}, ${plural(s.textsSent, 'text')} sent, and ${plural(s.emailsSent, 'email')} sent.`);
  if (s.topics.length) parts.push(`Main topics: ${s.topics.join('; ')}.`);
  if (s.orderLookups) parts.push(`${plural(s.orderLookups, 'order lookup')}.`);
  if (s.messages || s.voicemails) parts.push(`${plural(s.messages, 'message')} taken and ${plural(s.voicemails, 'voicemail')}.`);
  if (s.alerts) parts.push(`${plural(s.alerts, 'urgent alert')} today.`);
  parts.push(s.followUps ? `${plural(s.followUps, 'item')} need follow-up; details are in the admin dashboard.` : 'Nothing needs follow-up.');
  if (s.errors || s.failedSends) parts.push(`System: ${plural(s.errors, 'error')} and ${plural(s.failedSends, 'failed send')}.`);
  else parts.push('No system errors.');
  if (s.gaps) parts.push(`${plural(s.gaps, 'question')} the knowledge base could not answer.`);
  return parts.join(' ');
}

module.exports = { collect, render, readJsonl };
