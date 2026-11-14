'use strict';
// Invented sample mail for demos and screenshots. Every address and message here is fake.
const SAMPLES = [
  { id: 'demo-0001-aaaa', from: 'Northwind Cloud <no-reply@northwind.example>', to: ['info@bestdealon.app'], subject: 'Verify your new Northwind sign-in', mins: 7, html: '<h2>Confirm it is you</h2><p>Use verification code <strong>482 915</strong> to finish signing in. (Sample message.)</p><p><a href="https://northwind.example/security">Review security activity</a></p><img src="https://tracker.example/pixel.gif"><script>alert(1)</script>', text: 'Confirm it is you\n\nUse verification code 482915 to finish signing in. (Sample message.)\n\nReview security activity: https://northwind.example/security' },
  { id: 'demo-0002-bbbb', from: '"Ada Example" <ada@example.org>', to: ['support@bestdealon.app'], subject: 'Question about the phone case sizes', mins: 52, html: '<p>Hi team,</p><p>Which case fits the Example Phone 12? This is invented demo text.</p><p>Thanks,<br>Ada</p>', text: '' },
  { id: 'demo-0003-cccc', from: 'Contoso Billing <billing@contoso.example>', to: ['billing@bestdealon.app'], subject: 'Your sample invoice #1042 is ready', mins: 190, html: '<table><tr><td><b>Invoice</b></td><td>#1042</td></tr><tr><td>Total</td><td>$0.00 (demo)</td></tr></table><p><a href="https://contoso.example/invoices/1042">View invoice</a></p>', text: 'Invoice #1042\nTotal: $0.00 (demo)\nView invoice: https://contoso.example/invoices/1042' },
  { id: 'demo-0004-dddd', from: 'Fabrikam Domains <hello@fabrikam.example>', to: ['info@bestdealon.app'], subject: 'Welcome to Fabrikam (sample)', mins: 1440, html: '<h1>Welcome!</h1><p>This is a made-up onboarding message for screenshots.</p>', text: 'Welcome! This is a made-up onboarding message for screenshots.' },
  { id: 'demo-0005-eeee', from: 'Sam Sample <sam@sample.example>', to: ['press@bestdealon.app'], subject: 'Interview request for next week', mins: 2900, html: '', text: 'Hello, this is placeholder text for the demo inbox. Could we talk next Tuesday?\n\nhttps://sample.example/calendar' },
  { id: 'demo-0006-ffff', from: 'Other Site <a@other.example>', to: ['someone@not-this-site.example'], subject: 'Must never appear (other domain)', mins: 3, html: '<p>hidden</p>', text: 'hidden' },
];
// Inbox source: one inbox on the site's domain (one message duplicates a received email by Message-ID, one is
// inbox-only) and one on another domain that must never be shown.
const INBOXES = [{ id: 'inbox-demo-site', email_address: 'info@bestdealon.app' }, { id: 'inbox-demo-other', email_address: 'info@othersite.example' }];
const THREADS = {
  'inbox-demo-site': [{ id: 'thread-demo-1', emails: [
    { id: 'tmail-demo-1', direction: 'inbound', from: 'Northwind Cloud <no-reply@northwind.example>', to: ['info@bestdealon.app'], subject: 'Verify your new Northwind sign-in', message_id: '<demo-0001@northwind.example>', mins: 7, html: '<p>dup</p>', text: 'dup' },
    { id: 'tmail-demo-2', direction: 'inbound', from: 'Litware Status <status@litware.example>', to: ['info@bestdealon.app'], subject: 'Scheduled maintenance notice (sample)', message_id: '<demo-0007@litware.example>', mins: 25, html: '<p>Planned maintenance window this weekend. Invented sample.</p>', text: 'Planned maintenance window this weekend. Invented sample.' },
    { id: 'tmail-demo-3', direction: 'outbound', from: 'info@bestdealon.app', to: ['someone@litware.example'], subject: 'Outbound must not show', mins: 20, html: '', text: '' }] }],
  'inbox-demo-other': [{ id: 'thread-demo-9', emails: [{ id: 'tmail-demo-9', direction: 'inbound', from: 'x@other.example', to: ['info@othersite.example'], subject: 'Other site inbox: must never appear', mins: 1, html: '', text: '' }] }],
};
function mockFetch(nowMs = Date.now()) {
  const at = (mins) => new Date(nowMs - mins * 60000).toISOString();
  const rows = SAMPLES.map((s, i) => ({ ...s, created_at: at(s.mins), cc: [], bcc: [], message_id: i === 0 ? '<demo-0001@northwind.example>' : '<' + s.id + '@sample.example>' }));
  const reply = (obj, status = 200) => ({ ok: status < 300, status, json: async () => obj });
  const strip = ({ html, text, mins, ...m }) => m;
  return async (url) => {
    const u = new URL(url); const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (u.pathname === '/emails/receiving') return reply({ object: 'list', has_more: false, data: rows.map(strip) });
    if (parts[0] === 'emails' && parts[1] === 'receiving') { const r = rows.find(x => x.id === parts[2]); return r ? reply(r) : reply({ message: 'not found' }, 404); }
    if (parts[0] === 'inboxes' && parts.length === 1) return reply({ object: 'list', has_more: false, data: INBOXES });
    if (parts[0] === 'inboxes' && parts.length === 2) { const ib = INBOXES.find(x => x.id === parts[1]); return ib ? reply(ib) : reply({}, 404); }
    const th = THREADS[parts[1]];
    if (!th) return reply({}, 404);
    if (parts.length === 3) return reply({ object: 'list', has_more: false, data: th.map(t => ({ id: t.id, subject: t.emails[0].subject, received_at: at(t.emails[0].mins) })) });
    const t = th.find(x => x.id === parts[3]); if (!t) return reply({}, 404);
    const em = t.emails.map(e => ({ ...e, received_at: at(e.mins), cc: [], bcc: [] }));
    if (parts.length === 5) return reply({ object: 'list', has_more: false, data: em.map(e => { const { mins, ...x } = e; return x; }) });
    const e = em.find(x => x.id === parts[5]); return e ? reply(e) : reply({}, 404);
  };
}
module.exports = { SAMPLES, INBOXES, THREADS, mockFetch };
