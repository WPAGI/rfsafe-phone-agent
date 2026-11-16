'use strict';
// Invented mail for Site Mailbox v2 tests and screenshots, layered on the viewer's mock. Every address is fake.
// Also mocks Resend's sent list and POST /emails (recorded, never sent anywhere).
const base = require('../mail/mock');
const EXTRA = [
  { id: 'demo-0101-promo', from: 'GrowthLabs <deals@growthlabs.example>', to: ['info@rfsafe.app'], subject: 'Limited time: 40% off SEO backlinks', mins: 30, text: 'Special offer! Grow your business with our SEO backlinks package. Limited time 40% off. Book a call today. Unsubscribe here.' },
  { id: 'demo-0102-refund', from: 'Rae Example <rae@example.net>', to: ['support@rfsafe.app'], subject: 'Refund for my order?', mins: 75, text: 'Hi, the case arrived but it does not fit. Can I get a refund? (Invented demo text.)' },
  { id: 'demo-0103-howto', from: 'Lee Sample <lee@sample.example>', to: ['info@rfsafe.app'], subject: 'Where can I read about SAR?', mins: 95, text: 'Hello, where on the site can I read how SAR levels are compared? (Invented demo text.)', attachments: [{ id: 'att-demo-1', filename: 'screenshot.png', content_type: 'image/png', size: 48211 }] },
];
const SENT = [
  { id: 'sent-demo-0001', from: 'RF Safe <info@rfsafe.app>', to: ['support@quantaxtechnology.com'], subject: 'Your RF Safe Mail sign-in link', mins: 20, text: 'Sign in to RF Safe Mail (works once, expires in 15 minutes):\nhttps://rfsafe.app/mail/auth#t=DEMOtokenDEMOtoken1234567890\n\nCode 482915', last_event: 'delivered' },
  { id: 'sent-demo-0002', from: 'Other <noreply@othersite.example>', to: ['x@example.org'], subject: 'Must never appear (other sender domain)', mins: 5, text: 'hidden', last_event: 'delivered' },
];
// Attachment bytes served from a fake CDN URL (attachments.files[...] lets tests swap in a mock PDF or a large file).
const ATT = { 'demo-0103-howto': [{ id: 'att-demo-1', filename: 'screenshot.png', content_type: 'image/png', size: 48211 }] };
function mockFetch(nowMs = Date.now(), outbox = [], files = {}) {
  const inner = base.mockFetch(nowMs); const at = (m) => new Date(nowMs - m * 60000).toISOString();
  const reply = (obj, status = 200) => ({ ok: status < 300, status, json: async () => obj });
  const rows = EXTRA.map((s, i) => ({ ...s, created_at: at(s.mins), cc: [], bcc: [], html: '', message_id: '<' + s.id + '@sample.example>' }));
  const f = async (url, opt = {}) => {
    const u = new URL(url); const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (u.hostname === 'inbound-cdn.resend.com') { const f = files[parts[2]]; if (!f) return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) }; const b = Buffer.from(f.bytes); return { ok: true, status: 200, headers: new Map([['content-length', f.lie ? '0' : String(b.length)]]), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; }
    if (parts[0] === 'emails' && parts[1] === 'receiving' && parts[3] === 'attachments') {
      const list = [...(ATT[parts[2]] || []), ...Object.entries(files).filter(([, f]) => f.msg === parts[2]).map(([id, f]) => ({ id, filename: f.filename, content_type: f.content_type, size: f.size != null ? f.size : Buffer.from(f.bytes).length }))]
        .map(a => ({ ...a, content_disposition: 'attachment', download_url: (files[a.id] && files[a.id].url) || ('https://inbound-cdn.resend.com/' + parts[2] + '/attachments/' + a.id + '?signature=mock'), expires_at: at(-60) }));
      if (parts.length === 4) return reply({ object: 'list', has_more: false, data: list });
      const one = list.find(a => a.id === parts[4]); return one ? reply(one) : reply({}, 404);
    }
    if (u.pathname === '/emails' && (opt.method || 'GET') === 'POST') { const b = JSON.parse(opt.body); outbox.push(b); return reply({ id: 'mock-sent-' + outbox.length }); }
    if (u.pathname === '/emails') return reply({ object: 'list', has_more: false, data: SENT.map(({ text, mins, ...m }) => ({ ...m, created_at: at(mins) })) });
    if (u.pathname === '/emails/receiving') { const r = await inner(url, opt); const j = await r.json(); return reply({ ...j, data: [...j.data, ...rows.map(({ html, text, mins, ...m }) => m)] }); }
    if (parts[0] === 'emails' && parts[1] === 'receiving') { const r = rows.find(x => x.id === parts[2]); if (r) return reply(r); return inner(url, opt); }
    if (parts[0] === 'emails' && parts.length === 2) { const s = SENT.find(x => x.id === parts[1]); return s ? reply({ ...s, created_at: at(s.mins) }) : reply({}, 404); }
    return inner(url, opt);
  };
  f.outbox = outbox; f.files = files; return f;
}
module.exports = { mockFetch, EXTRA, SENT };
