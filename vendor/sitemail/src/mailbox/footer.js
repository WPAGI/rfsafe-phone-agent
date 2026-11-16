'use strict';
// Newsletter footer for mailbox replies. Fixed text from code (never written by the AI), kept apart from the answer:
// the checker grades the answer without it, and the owner-only / hard-block rules apply to the answer body.
// Membership comes from the same newsletter list the phone line uses (Newsletter.isSubscriber).
// Non-members get an invitation to opt in themselves on the existing sign-up page; nobody is ever added automatically.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DIVIDER = '———';
function buildFooter({ subscriber, siteName, joinUrl }) {
  const n = siteName || 'our';
  // Member wording: the phone line's emails (src/email.js buildEmail) say "thank you for being an RF Safe newsletter subscriber".
  if (subscriber) return { kind: 'member', text: `Thank you for being an ${n} newsletter subscriber.`, lines: [`Thank you for being an ${n} newsletter subscriber.`] };
  const lines = [`Get the ${n} monthly newsletter: join the ${n} mailing list. You are only added if you choose to join.`];
  return { kind: 'invite', text: lines[0] + '\nJoin the mailing list: ' + joinUrl, lines, join_url: joinUrl, button: 'Join the mailing list' };
}
// The email as sent: answer, then a divider, then the footer (plain text and HTML).
function renderEmail(body, footer) {
  const b = String(body || '');
  if (!footer) return { text: b, html: null };
  const text = b.replace(/\s+$/, '') + '\n\n' + DIVIDER + '\n' + footer.text;
  // A sentence-ending period or comma after a link is text, not part of the link (it broke the href).
  const linkify = (s) => esc(s).replace(/https:\/\/[^\s<>"')\]]+/g, (u) => { const m = u.match(/^(.*?)([.,;:!?]+)$/); const url = m ? m[1] : u; return `<a href="${url}">${url}</a>` + (m ? m[2] : ''); });
  // A paragraph whose lines are "- item" (e.g. SAR figures) becomes a short list; other lines stay as text around it.
  const block = (p) => { const out = []; let items = []; const flush = () => { if (items.length) out.push(`<ul style="margin:0 0 12px;padding-left:20px">${items.map((i) => `<li>${linkify(i)}</li>`).join('')}</ul>`); items = []; };
    let text = []; const flushText = () => { if (text.length) out.push(`<p style="margin:0 0 12px">${text.map(linkify).join('<br>')}</p>`); text = []; };
    for (const line of p.split('\n')) { const m = line.match(/^\s*[-•*]\s+(.*)$/); if (m) { flushText(); items.push(m[1]); } else { flush(); text.push(line); } }
    flushText(); flush(); return out.join(''); };
  const paras = b.trim().split(/\n\s*\n/).map(block).join('');
  const foot = footer.kind === 'invite'
    ? `<p style="margin:0 0 10px">${esc(footer.lines[0])}</p><p style="margin:0"><a href="${esc(footer.join_url)}" style="display:inline-block;padding:8px 16px;background:#0a7d3b;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">${esc(footer.button)}</a></p>`
    : `<p style="margin:0">${esc(footer.lines[0])}</p>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222">${paras}<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 14px"><div style="font-size:13px;color:#555">${foot}</div></div>`;
  return { text, html };
}
module.exports = { buildFooter, renderEmail, DIVIDER };
