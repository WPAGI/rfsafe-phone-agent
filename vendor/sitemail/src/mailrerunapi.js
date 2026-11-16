'use strict';
// Jarvis rerun key (John, Nov 15, 9:11 PM ET: "Yes, have Coder build a rerun-only key for unanswered emails").
// docs/MAIL_READ_API.md. Exactly one endpoint:
//   POST /admin/mail/messages/<id>/rerun    (empty body or {}; any field or query parameter is refused with 422)
//   POST /admin/mail/messages/<id>/redraft  (same key, same rate limits; keeps the current draft and runs a fresh check)
// Runs the normal pipeline once (sorter, writer, checker, auto-send) through the owner's own reprocess; nothing is
// forced, skipped or overridden. Refuses (409) an email that was already replied to, is in trash or spam, or is queued
// or running. Loop guard: at most PER_EMAIL_PER_HOUR reruns per email per rolling hour (default 5; John, Nov 15 11:03 PM ET,
// "four or five per hour for testing") and at most DAILY_CAP a day (UTC, default 50), kept on disk. Env overrides:
// MAIL_RERUN_PER_EMAIL_PER_HOUR and MAIL_RERUN_PER_DAY (positive integers; anything else keeps the default).
// Auth: Authorization: Bearer <rerun key>; the server stores only SHA-256(key) in MAIL_RERUN_TOKEN_HASH. The rerun key
// is refused (403) on every other route (see app.js), and the read key or the KB key get 403 here.
const fs = require('fs'); const path = require('path');
const kbApi = require('./kbapi');

const PATH_RE = /^\/admin\/mail\/messages\/([A-Za-z0-9._-]{8,200})\/(rerun|redraft)\/?$/;
const HOUR = 3600000; const DAILY_CAP = 50; const PER_EMAIL_PER_HOUR = 5;
const envInt = (v, d) => { const n = Number(String(v == null ? '' : v).trim()); return Number.isInteger(n) && n > 0 && n <= 10000 ? n : d; }; const MAX_BODY = 1024;
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, max-age=0', 'x-robots-tag': 'noindex, nofollow', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

function createMailRerunApi({ hash, otherHashes = () => [], mailbox, dataDir, now = () => Date.now(), max = 30, windowMs = 60000, dailyCap = DAILY_CAP, perEmailMs = HOUR, perEmail = PER_EMAIL_PER_HOUR } = {}) {
  const rate = new Map();
  const file = dataDir ? path.join(dataDir, 'mailbox', 'rerun-guard.json') : null;
  let mem = { byId: {}, day: '', count: 0 };
  const load = () => { if (!file) return mem; try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { byId: {}, day: '', count: 0 }; } };
  const save = (g) => { mem = g; if (!file) return; fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(g), { mode: 0o600 }); fs.renameSync(tmp, file); };
  const send = (res, code, obj, extra = {}) => { res.writeHead(code, { ...HEADERS, ...extra }); res.end(JSON.stringify(obj)); return true; };
  const isPath = (p) => PATH_RE.test(String(p || '').split('?')[0]);
  const resolve = (h) => (typeof h === 'function' ? h() : h);
  const isRerunKey = (authHeader) => { const h = resolve(hash); return !!h && kbApi.authorized(authHeader, h); };
  async function readSmall(req) {
    return new Promise((ok, bad) => { let n = 0; const parts = []; req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { bad(Object.assign(new Error('too_large'), { status: 413 })); req.destroy(); } else parts.push(c); }); req.on('end', () => ok(Buffer.concat(parts).toString('utf8'))); req.on('error', bad); });
  }
  async function route(req, res, u) {
    const m = u.pathname.match(PATH_RE); if (!m) return false;
    const auth = req.headers.authorization;
    if (!isRerunKey(auth)) {
      const other = [].concat(resolve(otherHashes) || []).filter(Boolean).some((h) => kbApi.authorized(auth, h));
      return other ? send(res, 403, { error: 'wrong_key', detail: 'This route only accepts the rerun key.' }) : send(res, 401, { error: 'unauthorized' });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
    const ip = String((req.headers['x-forwarded-for'] || '').toString().split(',')[0] || (req.socket && req.socket.remoteAddress) || 'local').trim();
    if (!kbApi.rateLimit(rate, ip, { max, windowMs, now: +now() })) return send(res, 429, { error: 'too_many_requests' }, { 'retry-after': String(Math.ceil(windowMs / 1000)) });
    if ([...u.searchParams.keys()].length) return send(res, 422, { error: 'unexpected_fields', detail: 'No parameters are accepted.', fields: [...new Set(u.searchParams.keys())].slice(0, 10) });
    let raw; try { raw = await readSmall(req); } catch (e) { return send(res, e.status || 400, { error: e.status === 413 ? 'body_too_large' : 'bad_body' }); }
    if (raw.trim()) {
      let b; try { b = JSON.parse(raw); } catch { return send(res, 422, { error: 'bad_body', detail: 'Send no body, or {}.' }); }
      if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).length) return send(res, 422, { error: 'unexpected_fields', detail: 'No fields are accepted (no force, skip or override).', fields: b && typeof b === 'object' ? Object.keys(b).slice(0, 10) : [] });
    }
    const mb = typeof mailbox === 'function' ? mailbox() : mailbox;
    if (!mb || !mb.enabled || !mb.rerunCheck || !mb.rerunByKey) return send(res, 503, { error: 'mailbox_unavailable' });
    const id = m[1]; const action = m[2] === 'redraft' ? 'redraft' : 'rerun';
    try {
      const c = await mb.rerunCheck(id); if (c.code !== 200) return send(res, c.code, { error: c.error, ...(c.detail ? { detail: c.detail } : {}) });
      const t = +now(); const day = new Date(t).toISOString().slice(0, 10); const g = load(); g.byId ||= {};
      // byId[id] = timestamps of this email's reruns in the last perEmailMs (an old single number is read as one rerun).
      for (const [k, v] of Object.entries(g.byId)) { const a = (Array.isArray(v) ? v : [v]).filter(x => Number.isFinite(x) && t - x < perEmailMs); if (a.length) g.byId[k] = a; else delete g.byId[k]; }
      const mine = g.byId[id] || [];
      if (mine.length >= perEmail) { const wait = Math.max(1, Math.ceil((perEmailMs - (t - Math.min(...mine))) / 1000)); return send(res, 429, { error: 'rerun_too_soon', detail: 'At most ' + perEmail + ' reruns per email per hour.', retry_after_seconds: wait, per_email_per_hour: perEmail }, { 'retry-after': String(wait) }); }
      if (g.day !== day) { g.day = day; g.count = 0; }
      if (g.count >= dailyCap) return send(res, 429, { error: 'daily_cap', detail: 'At most ' + dailyCap + ' reruns a day (UTC).' });
      g.byId[id] = [...mine, t]; g.count += 1; save(g);
      const r = action === 'redraft' ? (mb.redraftByKey ? mb.redraftByKey(id) : { no_draft: true }) : mb.rerunByKey(id);
      if (r && r.already_running) return send(res, 409, { error: 'already_running' });
      if (r && r.already_replied) return send(res, 409, { error: 'already_replied' });
      if (r && r.no_draft) return send(res, 409, { error: 'no_draft', detail: 'There is no current draft to redraft.' });
      return send(res, 202, { ok: true, id, action, run: r && r.run ? { status: r.run.status, label: r.run.label } : null, reruns_today: g.count, daily_cap: dailyCap, reruns_this_hour: g.byId[id].length, per_email_per_hour: perEmail });
    } catch (e) { return send(res, 502, { error: 'mail_unavailable' }); }
  }
  return { route, isPath, isRerunKey };
}
module.exports = { envInt, PER_EMAIL_PER_HOUR, createMailRerunApi, PATH_RE, DAILY_CAP };
