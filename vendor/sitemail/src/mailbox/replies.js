'use strict';
// Replies sent for a received message: the mailbox's own Sent records (owner Send and checker-passed auto-send both
// go through deliver() -> store.addSent with reply_to_id), plus any auto-send "sent" step on the message timeline
// (a fallback if a Sent record is missing). Times are labeled in ET.
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const sentLabel = (iso) => { const t = Date.parse(iso); return t ? 'sent ' + fmt.format(new Date(t)) + ' ET' : 'sent'; };
function repliesFor(id, sentList, timeline) {
  const out = new Map();
  for (const s of sentList || []) if (s && s.reply_to_id === id) out.set(s.id, { id: s.id, at: s.at, via: s.via || null, approved_by: s.approved_by || null, subject: s.subject || '', body: s.body || '' });
  for (const x of timeline || []) if (x && x.step === 'auto_send' && x.status === 'sent') { const k = x.sent_id || ('t:' + x.at); if (!out.has(k)) out.set(k, { id: x.sent_id || null, at: x.at, via: 'auto', approved_by: 'checker', subject: '', body: '' }); }
  const all = [...out.values()].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  if (!all.length) return null;
  const latest = all[all.length - 1];
  return { count: all.length, latest: { ...latest, label: sentLabel(latest.at) } };
}
// John, Nov 15, 10:43 PM ET: "if it's stuck on a draft and it didn't go to reply, it should be marked as draft on the inbox,
// and there should be a view draft that displays in the inbox, the same place where there's a view the reply". Display only.
// The latest unsent draft for a received message ('draft' or 'held'; discarded drafts never count), only when no reply was
// sent and the message is not in Trash or Spam. Reads the draft records' plain fields (id, status, times, reply_to_id); the
// sealed body is opened only when the owner clicks View draft (GET /message/<draft id>, unchanged). The reason is the newest
// hold or failure step on the message timeline after the draft was written (auto_send held, a checker fail or error,
// a pipeline that gave up), or null if none is recorded.
const draftLabel = (iso) => { const t = Date.parse(iso); return t ? 'drafted ' + fmt.format(new Date(t)) + ' ET' : 'drafted'; };
const STUCK = new Set(['held', 'fail', 'error', 'gave_up', 'timeout']);
function draftFor(id, draftRecords, { replies = null, folder = 'inbox', timeline = [] } = {}) {
  if (replies || folder === 'trash' || folder === 'spam') return null;
  let best = null;
  for (const d of Object.values(draftRecords || {})) {
    if (!d || d.reply_to_id !== id || (d.status !== 'draft' && d.status !== 'held')) continue;
    if (!best || String(d.updated || d.created || '') > String(best.updated || best.created || '')) best = d;
  }
  if (!best) return null;
  const since = String(best.created || '');
  let reason = null;
  for (const x of timeline || []) if (x && STUCK.has(x.status) && String(x.at || '') >= since && x.reason) reason = String(x.reason).slice(0, 400);
  return { id: best.id, status: best.status, at: best.updated || best.created || null, label: draftLabel(best.updated || best.created), reason };
}
module.exports = { repliesFor, sentLabel, draftFor, draftLabel };
