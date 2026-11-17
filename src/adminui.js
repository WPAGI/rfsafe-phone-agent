'use strict';
// Unified admin layout (John, Nov 16, 2026, 9:13-9:20 PM ET): one home with icon tiles grouped by section, and every
// admin page in the Mailbox look (same CSS, reused from vendor/sitemail) with a left side nav. On small screens the
// side nav becomes the Mailbox's horizontally scrollable top menu (its @media (max-width:980px) rules, reused as is).
// No folder column here: that stays inside the Mailbox itself. Zero dependencies; output is escaped.
const MAILV = require('../vendor/sitemail/src/mail/views');
const MBV = require('../vendor/sitemail/src/mailbox/views');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const I = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICONS = {
  home: I('<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>'),
  calls: I('<path d="M5 4h4l2 5-3 2a11 11 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>'),
  channels: I('<rect x="3" y="8" width="8" height="8" rx="4"/><rect x="13" y="8" width="8" height="8" rx="4"/>'),
  texts: I('<path d="M4 5h16v11H9l-5 4z"/>'),
  emails: MBV.ICONS.sent.replace('<svg ', '<svg aria-hidden="true" '),
  outbound: I('<path d="M12 3v12M7 8l5-5 5 5"/><path d="M4 15v5h16v-5"/>'),
  feedback: I('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>'),
  usage: I('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  subscribers: I('<circle cx="9" cy="8" r="3.5"/><path d="M2 20c.8-4 3.6-6 7-6s6.2 2 7 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2 .8 3.4 2.8 4 6"/>'),
  newsletter: I('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/>'),
  mailbox: MBV.ICONS.inbox.replace('<svg ', '<svg aria-hidden="true" '),
  viewer: I('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/>'),
  brain: I('<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3h1V4z"/><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3h-1V4z"/>'),
  csv: I('<path d="M12 4v11M7 10l5 5 5-5"/><path d="M4 19h16"/>'),
  gaps: I('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/>'),
};

// The one list of admin tools. Home tiles and the side nav are both drawn from it, so nothing can be on one and not the other.
// id = active key; mail: true = needs the Site Mail package (hidden when it is off).
const SECTIONS = [
  { title: 'Callbots', items: [
    { id: 'calls', label: 'Call log', href: '/admin/calls', icon: 'calls' },
    { id: 'channels', label: 'Texting & email', href: '/admin/channels', icon: 'channels' },
    { id: 'texts', label: 'Review texts', href: '/admin/messages?type=sms', icon: 'texts' },
    { id: 'emails', label: 'Review emails', href: '/admin/messages?type=email', icon: 'emails' },
    { id: 'outbound', label: 'Outbound & owner briefing', href: '/admin/outbound', icon: 'outbound' },
    { id: 'feedback', label: 'Owner feedback', href: '/admin/owner-feedback', icon: 'feedback' },
    { id: 'usage', label: 'Usage & costs', href: '/admin/usage', icon: 'usage' },
  ] },
  { title: 'People', items: [
    { id: 'subscribers', label: 'Subscribers', href: '/admin/subscribers', icon: 'subscribers' },
    { id: 'newsletter', label: 'Newsletter', href: '/admin/newsletter', icon: 'newsletter' },
  ] },
  { title: 'Mailbox', items: [
    { id: 'mailbox', label: 'Mailbox', href: '/admin/go/inbox', icon: 'mailbox', mail: true },
    { id: 'brain', label: 'Brain box', href: '/admin/go/kb', icon: 'brain', mail: true },
    { id: 'viewer', label: 'Mail viewer', href: '/admin/mail', icon: 'viewer' },
  ] },
  { title: 'Downloads', items: [
    { id: 'calls-csv', label: 'Calls (CSV)', href: '/admin/calls.csv', icon: 'csv' },
    { id: 'newsletter-csv', label: 'Newsletter (CSV)', href: '/admin/newsletter.csv', icon: 'csv' },
    { id: 'gaps-csv', label: 'Unanswered questions (CSV)', href: '/admin/kb-gaps.csv', icon: 'gaps' },
    { id: 'texts-csv', label: 'Sent texts (CSV)', href: '/admin/messages.csv?type=sms', icon: 'csv' },
    { id: 'emails-csv', label: 'Sent emails (CSV)', href: '/admin/messages.csv?type=email', icon: 'csv' },
  ] },
];
const sections = (mailOn) => SECTIONS.map((s) => ({ ...s, items: s.items.filter((i) => !i.mail || mailOn) })).filter((s) => s.items.length);

const ADMIN_CSS = `a.nb{text-decoration:none;color:var(--text)}.nb.on{font-weight:650}
.pane table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0}.pane td,.pane th{border-bottom:1px solid var(--line);padding:7px 8px;text-align:left;vertical-align:top}.pane th{color:var(--muted);font-weight:600;font-size:12px}
.pane button{font:inherit;font-size:14px;padding:8px 14px;border:0;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#07101f;font-weight:600;cursor:pointer}
.pane input,.pane select{padding:7px 10px;border-radius:10px;border:1px solid var(--line);background:var(--panel2)}.pane h1{margin:0 0 10px;font-size:24px}.pane h2{margin:22px 0 8px;font-size:18px}
.k{display:inline-block;margin:0 12px 10px 0;padding:10px 14px;background:var(--panel2);border:1px solid var(--line);border-radius:12px}.k b{font-size:22px;display:block}small{color:var(--muted)}
.tiles h2{font-size:13px;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted);margin:22px 0 10px}.grid{display:flex;flex-wrap:wrap;gap:14px}
.tile{width:128px;height:128px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:10px;text-align:center;border-radius:20px;border:1px solid var(--line);background:var(--panel2);color:var(--text);text-decoration:none;font-size:13.5px;line-height:1.25;transition:.18s}
.tile:hover{border-color:var(--accent);transform:translateY(-2px)}.tile svg{width:38px;height:38px;fill:none;stroke:var(--accent);stroke-width:1.8}
.pane{border-radius:20px;min-width:0}.pane button.grey{background:var(--panel2);color:var(--text);border:1px solid var(--line);font-weight:500}.pane button.red{background:#e5484d;color:#fff}.pane button.sm{font-size:13px;padding:6px 11px}
.pane button[style*="background:#888"]{background:var(--panel2)!important;color:var(--text);border:1px solid var(--line);font-weight:500}.pane button[style*="background:#c33"]{background:#e5484d!important;color:#fff}
.pane{overflow-x:auto}.pane input{max-width:100%}.pane [style*="color:#b00"]:not([style*="background"]){color:var(--hot)!important}.pane .so{background:var(--panel2);color:var(--text);border:1px solid var(--line);font-weight:500}.top form{margin:0}.top .so{font:inherit;font-size:13px;padding:8px 12px;border-radius:12px;border:1px solid var(--line);background:var(--panel2);color:var(--text);cursor:pointer}
/* Older admin pages carry a few light inline boxes (alerts, exact-copy <pre>): keep their text dark so they read in both themes. */
.pane [style*="background:#f"]{color:#15171a}.pane [style*="background:#f"] a{color:#0a58a0}.pane pre{overflow-wrap:anywhere}
@media (max-width:980px){.tile{width:calc(50% - 7px);height:112px}.pane{padding:14px}}`;

function nav(active, mailOn) {
  const nb = (i) => `<a class="nb${i.id === active ? ' on' : ''}" href="${esc(i.href)}"${i.id === active ? ' aria-current="page"' : ''}>${ICONS[i.icon]}<span>${esc(i.label)}</span></a>`;
  return `<nav class="nav glass" aria-label="Admin">${nb({ id: 'home', label: 'Home', href: '/admin', icon: 'home' })}${sections(mailOn).filter((s) => s.title !== 'Downloads').map((s) => `<h4>${esc(s.title)}</h4>${s.items.map(nb).join('')}`).join('')}</nav>`;
}
// Full admin page: Mailbox top bar + left nav + content pane. csrf (optional) adds the Sign out button.
function layout(title, body, { active = '', csrf = '', mailOn = false } = {}) {
  const so = csrf ? `<form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit" class="so">Sign out</button></form>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>${MAILV.CSS}${MBV.CSS2}${ADMIN_CSS}</style></head><body>
<header class="top glass"><div class="logo">${MAILV.ICON}</div><div class="brand"><b>Callbots Admin</b><small>One sign-in for calls, texts, subscribers, Mailbox and Brain box</small></div><div class="sp"></div><span class="pill"><span class="dot"></span>Private · owner only</span>${so}</header>
<div class="app wide">${nav(active, mailOn)}<main class="pane glass">${body}</main></div></body></html>`;
}
// Sign-in and message pages: same colors, one centered card, no nav (nothing behind sign-in is linked).
function bare(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>${MAILV.CSS}${ADMIN_CSS}.card button{font:inherit;padding:11px 18px;border:0;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#07101f;font-weight:650;cursor:pointer}.card button:disabled{opacity:.55;cursor:default}</style></head><body><main class="card glass"><div class="logo">${MAILV.ICON}</div>${body}</main></body></html>`;
}
function homePage({ mailOn }) {
  const tile = (i) => `<a class="tile" href="${esc(i.href)}">${ICONS[i.icon]}<span>${esc(i.label)}</span></a>`;
  return `<h1>Admin home</h1><p><small>Everything below uses this one sign-in. Times on admin pages are UTC unless marked ET.</small></p><div class="tiles">${sections(mailOn).map((s) => `<section><h2>${esc(s.title)}</h2><div class="grid">${s.items.map(tile).join('')}</div></section>`).join('')}</div>`;
}
module.exports = { layout, bare, homePage, nav, sections, SECTIONS, ICONS, ADMIN_CSS };
