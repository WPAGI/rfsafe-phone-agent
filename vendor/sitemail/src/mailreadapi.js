'use strict';
// Read-only Mailbox monitoring API (John, Nov 15, 7:30 PM ET). docs/MAIL_READ_API.md.
//   GET /admin/mail/messages?status=held|failed|sent|unsent|running|not_replied|pending|all&since=<ISO>&limit=<1..200>
//   GET /admin/mail/messages/<id>/activity
// Auth: Authorization: Bearer <mail read key>. The server stores only SHA-256(key) in MAIL_READ_TOKEN_HASH.
// The key is scoped to these two GET routes only: any other method is 403, and it is not accepted anywhere else
// (KB write API, KB agent API, bot API and the owner's /mail session each check their own credential).
const kbApi = require('./kbapi');

const PATH_RE = /^\/admin\/mail\/messages(?:\/([A-Za-z0-9._-]{8,200})\/activity)?\/?$/;
const STATUSES = new Set(['held', 'failed', 'sent', 'unsent', 'running', 'not_replied', 'pending', 'all']);
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, max-age=0', 'x-robots-tag': 'noindex, nofollow', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

function createMailReadApi({ hash, mailbox, now = () => Date.now(), max = 60, windowMs = 60000 } = {}) {
  const rate = new Map();
  const send = (res, code, obj, extra = {}) => { res.writeHead(code, { ...HEADERS, ...extra }); res.end(JSON.stringify(obj)); return true; };
  const isPath = (p) => PATH_RE.test(String(p || '').split('?')[0]);
  async function route(req, res, u) {
    const m = u.pathname.match(PATH_RE); if (!m) return false;
    const h = typeof hash === 'function' ? hash() : hash;
    if (!h || !kbApi.authorized(req.headers.authorization, h)) return send(res, 401, { error: 'unauthorized' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 403, { error: 'read_only', detail: 'This key can only read.' }, { allow: 'GET' });
    const ip = String((req.headers['x-forwarded-for'] || '').toString().split(',')[0] || (req.socket && req.socket.remoteAddress) || 'local').trim();
    if (!kbApi.rateLimit(rate, ip, { max, windowMs, now: +now() })) return send(res, 429, { error: 'too_many_requests' }, { 'retry-after': String(Math.ceil(windowMs / 1000)) });
    const mb = typeof mailbox === 'function' ? mailbox() : mailbox;
    if (!mb || !mb.enabled || !mb.readList) return send(res, 503, { error: 'mailbox_unavailable' });
    try {
      if (m[1]) { const a = await mb.readActivity(m[1]); return a ? send(res, 200, a) : send(res, 404, { error: 'not_found' }); }
      const status = String(u.searchParams.get('status') || 'all').toLowerCase();
      if (!STATUSES.has(status)) return send(res, 400, { error: 'bad_status', allowed: [...STATUSES] });
      const since = u.searchParams.get('since'); if (since && isNaN(Date.parse(since))) return send(res, 400, { error: 'bad_since' });
      const limit = Math.max(1, Math.min(200, parseInt(u.searchParams.get('limit') || '50', 10) || 50));
      const messages = await mb.readList({ status, since, limit });
      return send(res, 200, { status, since: since || null, count: messages.length, messages });
    } catch (e) { return send(res, 502, { error: 'mail_unavailable' }); }
  }
  return { route, isPath };
}
module.exports = { createMailReadApi, PATH_RE };
