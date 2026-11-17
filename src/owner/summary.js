'use strict';
// Builds the owner's daily briefing from the existing archives (read-only):
// call-records.jsonl, sent-messages.jsonl, owner-outbox.jsonl (messages + voicemails), kb-gaps.jsonl, owner-events.jsonl,
// and, when files.sitemail is set, the Site Mail mailbox and Brain box under DATA_DIR/sitemail (see mailboxDay below).
const fs = require('fs'); const path = require('path');
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

// ---- Site Mail mailbox + Brain box (DATA_DIR/sitemail; Katie, team note fb_9oxoRqnbm8Cs: "how many changes were made to
// the knowledge base, and mailbox monitoring of real mail exchanges"). Read-only, plain fields only: the per-message timeline
// (db.bots.timeline), the at times of sent copies (db.sent[].at) and the Brain box audit log. Sealed copies, drafts and
// sent bodies are never opened, so no address, name or body can reach the briefing. A missing file counts as zero.
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function mailboxDay({ dir, sameDay }) {
  const out = { received: 0, sent: 0, held: 0, failed: 0, rerun: 0, kbChanges: 0, statusById: {} };
  const db = readJson(path.join(dir, 'mailbox', 'mailbox.json')) || {};
  const tl = (db.bots && db.bots.timeline) || {};
  for (const [id, rows] of Object.entries(tl)) {
    if (!Array.isArray(rows) || !rows.length) continue;
    const today = rows.filter(sameDay); if (!today.length) continue;
    if (sameDay(rows[0])) out.received++;
    if (today.some((r) => (r.step === 'pipeline' && r.status === 'requested') || (r.step === 'reply' && r.status === 'rerun'))) out.rerun++;
    // The latest run decides the outcome (same rule as the mail read API): from the last pipeline started/requested step.
    let start = 0; for (let i = rows.length - 1; i >= 0; i--) if (rows[i].step === 'pipeline' && /^(?:started|requested)$/.test(rows[i].status)) { start = i; break; }
    const run = rows.slice(start); const lastIdx = (re) => { for (let i = run.length - 1; i >= 0; i--) if (re.test(String(run[i].status || ''))) return i; return -1; };
    const sentAt = lastIdx(/^sent$/), errAt = lastIdx(/^error$/), heldAt = lastIdx(/^(?:held|fail)$/);
    let st = null;
    if (sentAt >= 0 && sentAt > Math.max(errAt, heldAt)) st = 'sent'; else if (errAt >= 0) st = 'failed'; else if (heldAt >= 0) st = 'held';
    if (st === 'failed') out.failed++; else if (st === 'held') out.held++;
    if (st) out.statusById[id] = st;
  }
  out.sent = Object.values(db.sent || {}).filter((r) => r && sameDay(r)).length;
  // Brain box (KB Light) content changes: kb-api/<tenant>/audit.jsonl rows written by the entry store (create, update,
  // disable, undo). Rows with kind "swarm" are editorial activity (runner, proposals), not entry changes.
  let tenants = []; try { tenants = fs.readdirSync(path.join(dir, 'kb-api'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { tenants = []; }
  for (const t of tenants) out.kbChanges += readJsonl(path.join(dir, 'kb-api', t, 'audit.jsonl')).filter((r) => r.kind !== 'swarm' && r.slug && r.action && sameDay(r)).length;
  // Email questions the Mailbox could not answer (channel email), keyed by message so repeats collapse like calls do.
  out.gaps = readJsonl(path.join(dir, 'kb-gaps.jsonl')).filter((g) => g.question && (g.channel === 'email' || g.source === 'email') && sameDay(g))
    .map((g) => ({ at: g.at, question: g.question, channel: 'email', reason: 'model_unanswered', call: 'mail:' + String(g.message_id || g.question).slice(0, 80), message_id: g.message_id || null }));
  return out;
}
const EMAIL_OUTCOME = { sent: 'reply sent', held: 'draft held for review', failed: 'draft failed' };
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
  const mail = files.sitemail ? mailboxDay({ dir: files.sitemail, sameDay }) : null;
  let unans = unanswered({ gaps: mail ? gaps.concat(mail.gaps) : gaps, calls, msgs, outbox, tz });
  if (mail) unans = unans.map((u) => { if (u.channel !== 'email') return u; const g = mail.gaps.find((x) => x.at === u.at && scrub(x.question) === u.question); const st = g && g.message_id && mail.statusById[g.message_id]; return st ? { ...u, outcome: EMAIL_OUTCOME[st] } : u; });
  const mailbox = mail ? { received: mail.received, sent: mail.sent, held: mail.held, failed: mail.failed, rerun: mail.rerun, kbChanges: mail.kbChanges } : null;
  return { day, mailbox, calls: calls.length, inboundTexts: inboundTexts.length, textsSent: texts.length - 0, emailsSent: emails.length, topics, orderLookups, messages: messages.length, voicemails: voicemails.length, failedSends, errors, alerts: alerts.length, followUps, gaps: unans.length, unanswered: unans };
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

// Mailbox and Brain box: counts only.
function mailboxLine(m) {
  const mail = (m.received || m.sent || m.held || m.failed || m.rerun)
    ? `Mailbox: ${plural(m.received, 'email')} received, ${plural(m.sent, 'reply', 'replies')} sent, ${m.held} held for review, ${m.failed} failed, and ${plural(m.rerun, 'rerun')}.`
    : 'Mailbox: no email activity today.';
  return mail + ' ' + (m.kbChanges ? `${plural(m.kbChanges, 'Brain box change')} today.` : 'No Brain box changes today.');
}
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
  if (s.mailbox) parts.push(mailboxLine(s.mailbox));
  if (s.gaps) parts.push(unansweredLine(s.unanswered || [], s.gaps, opts.maxSpoken));
  return parts.join(' ');
}

module.exports = { collect, render, readJsonl, unanswered, scrub, renderUnansweredList, mailboxDay, mailboxLine };
