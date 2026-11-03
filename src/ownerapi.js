'use strict';
// Owner API for the Best Deal On Bot extension: one business per request, bound to the caller's Bizinator token.
// Auth: Authorization: Bearer bdo_<id>_<48hex> (a Bizinator per-phone bot token). We ask Bizinator who the token is
// (GET /api/v1/me) and confirm it can read its own business (GET /api/v1/businesses/{phone}, which Bizinator only allows
// for the owner). The tenant is the one whose admin-set `bizinator_phone` equals the token's phone. No tenant id is ever
// taken from the request. Read-only: creating a business, texting on/off and number changes stay admin-only.
// Never logs or returns tokens, secrets, PIN hashes or provider keys.
const crypto = require('crypto');
const { fp } = require('./util');
const adm = require('./admin');
const { onboardingStatus } = require('./onboarding');
const { SimpleLimiter } = require('./usage');

const EXT_ORIGIN = 'chrome-extension://hheielialecldbibdenjkepdhdbnbmig';
const TOKEN_RE = /^Bearer (bdo_\d+_[a-f0-9]{48})$/;
const OK_TTL = 60000, BAD_TTL = 10000;
// Safe tenant fields an owner may see. Everything else (twilio, xai, kb keys, shopify, secrets, owner PIN) is left out.
const SAFE_FIELDS = ['id', 'name', 'website', 'owner_email', 'support_email', 'hours', 'voice', 'disclosure', 'link_allowlist', 'keyterms', 'email_enabled', 'sms_enabled', 'instant_link_reply', 'take_message', 'transfer_hours_only'];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const digits = (s) => String(s || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');

function redactedConfig(t) {
  const o = {}; for (const k of SAFE_FIELDS) if (t[k] !== undefined) o[k] = k === 'take_message' ? { enabled: !!(t.take_message || {}).enabled } : t[k];
  o.numbers = (t.numbers || []).slice(); o.transfer_target_set = !!t.transfer_target;
  o.owner_briefing_enabled = !!(t.owner_briefing && t.owner_briefing.enabled);
  return o;
}

function createOwnerApi(d, { log = () => {}, readJsonl }) {
  const cache = new Map();
  const limiter = new SimpleLimiter({ max: d.ownerApiRateMax || 60, windowMs: 60000 });
  const base = () => String((d.env || {}).BIZINATOR_URL || 'https://bestdealon.app').replace(/\/$/, '');
  const fetchImpl = () => d.bizinatorFetch || globalThis.fetch;
  const origins = () => [EXT_ORIGIN, ...String((d.env || {}).OWNER_API_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)];
  const now = () => Date.now();

  async function whoIs(token) {
    const key = sha(token); const c = cache.get(key);
    if (c && c.exp > now()) return c.v;
    let v = null;
    try {
      const h = { authorization: 'Bearer ' + token, accept: 'application/json' };
      const me = await fetchImpl()(base() + '/api/v1/me', { headers: h });
      if (me.status === 200) {
        const j = await me.json(); const phone = digits(j && j.token && j.token.phone);
        if (/^\d{10}$/.test(phone) && (j.token.scopes || []).includes('modules:read')) {
          const b = await fetchImpl()(base() + '/api/v1/businesses/' + phone, { headers: h });
          if (b.status === 200 || b.status === 304) v = { phone, user: j.user_id, token_id: j.token.id };
        }
      }
    } catch (e) { log('owner_api.bizinator_error', { err: String(e.message).slice(0, 80) }); return { error: 'bizinator_unreachable' }; }
    if (cache.size > 500) cache.clear();
    cache.set(key, { v, exp: now() + (v ? OK_TTL : BAD_TTL) });
    return v;
  }
  // Who sets up / turns on features, as the owner should read it. A service with a branded tenant (callbots-bdo)
  // names that brand's support; otherwise the original Quanta X Technology wording, unchanged.
  const supportLine = (t) => { const b = (t && t.brand) ? t : d.tenants.list().find((x) => x.brand); return b ? `${b.brand.team_name} support (${b.owner_email || require('./brand').addrOf(b.brand.email_from)})` : null; };
  const tenantFor = (phone) => d.tenants.list().find((t) => digits(t.bizinator_phone) === phone) || null;

  function send(req, res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
    const o = req.headers.origin; const h = { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'Origin', ...extra };
    if (o && origins().includes(o)) { h['access-control-allow-origin'] = o; h['access-control-allow-headers'] = 'authorization'; h['access-control-allow-methods'] = 'GET, OPTIONS'; h['access-control-max-age'] = '600'; }
    res.writeHead(code, h); res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  async function route(req, res, u) {
    if (req.method === 'OPTIONS') return send(req, res, 204, '');
    if (req.method !== 'GET') return send(req, res, 405, { error: 'method_not_allowed', message: 'This API is read-only.' });
    const m = TOKEN_RE.exec(req.headers.authorization || '');
    if (!m) return send(req, res, 401, { error: 'unauthorized', message: 'Sign in with Best Deal On first.' });
    if (!limiter.allow(sha(m[1]))) return send(req, res, 429, { error: 'rate_limited' }, undefined, { 'retry-after': '60' });
    const who = await whoIs(m[1]);
    if (who && who.error) return send(req, res, 503, { error: who.error, message: 'Could not reach Best Deal On to check your sign-in. Try again shortly.' });
    if (!who) { log('owner_api.denied', { reason: 'token' }); return send(req, res, 401, { error: 'unauthorized', message: 'This sign-in is not valid for a business you own.' }); }
    const t = tenantFor(who.phone);
    if (!t) return send(req, res, 404, { error: 'no_phone_bot', message: supportLine(null) ? `Your business does not have a phone bot connected yet. ${supportLine(null)} can set one up.` : 'Your business does not have a phone bot connected yet. Quanta X Technology staff can set one up.' });
    const p = u.pathname.replace(/^\/api\/owner\/v1/, '') || '/';
    log('owner_api.read', { tenant: t.id, path: p, user: fp(who.user) });
    const mine = (r) => r && r.tenant === t.id;
    const qp = (k) => u.searchParams.get(k) || '';
    const page = (rows) => { const lim = Math.min(Math.max(parseInt(qp('limit'), 10) || 50, 1), 200); const off = Math.max(parseInt(qp('offset'), 10) || 0, 0); return { total: rows.length, offset: off, limit: lim, items: rows.slice(off, off + lim) }; };
    const csv = (name, cols, rows) => send(req, res, 200, adm.toCsv(cols, rows), 'text/csv; charset=utf-8', { 'content-disposition': `attachment; filename="${name}"` });
    const day = (k) => (/^\d{4}-\d{2}-\d{2}$/.test(qp(k)) ? qp(k) : '');

    if (p === '/status') {
      const ob = onboardingStatus(t);
      return send(req, res, 200, { business: { phone: who.phone, tenant: t.id, name: t.name }, config: redactedConfig(t),
        channels: { voice: !!(t.numbers && t.numbers.length), email: !!t.email_enabled, sms: !!t.sms_enabled, sms_note: t.sms_enabled ? null : (supportLine(t) ? 'Texting is a feature that turns on after a one-time carrier approval (usually about 4 to 24 hours). ' + supportLine(t) + ' turns it on.' : 'Texting is a feature that turns on after a one-time carrier approval (usually about 4 to 24 hours). Quanta X Technology staff turn it on.') },
        onboarding: ob, ready: ob.filter((s) => !s.optional).every((s) => s.done), kb: !!(t.kb && (t.kb.dirs || t.kb.collection_id)), mode: d.mode || 'unknown' });
    }
    if (p === '/subscribers' || p === '/subscribers.csv') {
      // all:true keeps people who were linked/asked but never clicked the confirm link, shown as "pending".
      const rows = (d.newsletterFile ? adm.newsletterRows(d.newsletterFile, { all: true }) : []).filter(mine).map((r) => ({ ...r, email_optin: r.email_optin || (r.email ? 'pending' : '') }));
      const ql = qp('q').toLowerCase().slice(0, 80);
      const f = ql ? rows.filter((r) => [r.name, r.email, r.phone].some((x) => String(x || '').toLowerCase().includes(ql))) : rows;
      if (p === '/subscribers.csv') return csv('subscribers.csv', adm.NL_COLS, f);
      // Signups asked for on a call: the confirm email went out; they show as subscribed only after the click.
      const asked = (d.callRecords ? d.callRecords.read() : []).filter((r) => mine(r) && r.newsletter_optin).map((r) => ({ at: r.at, emails: (r.emails || []).map((e) => e.to_masked).filter(Boolean) })).reverse().slice(0, 50);
      return send(req, res, 200, { ...page(f), asked_on_calls: asked });
    }
    if (p === '/calls' || p === '/calls.csv') {
      const q = { from: day('from'), to: day('to'), number: qp('number').replace(/[^\d+]/g, '').slice(0, 16) };
      const rows = adm.filterCalls((d.callRecords ? d.callRecords.read() : []).filter(mine), q);
      if (p === '/calls.csv') return csv('calls.csv', adm.CALL_COLS, adm.callCsvRows(rows));
      return send(req, res, 200, page(rows));
    }
    if (p === '/kb-gaps' || p === '/kb-gaps.csv') {
      const rows = readJsonl(d.kbGapFile).filter(mine).map((r) => ({ at: r.at, channel: r.channel, reason: r.reason, question: r.question })).sort((a, b) => String(b.at).localeCompare(String(a.at)));
      if (p === '/kb-gaps.csv') return csv('unanswered-questions.csv', ['at', 'channel', 'reason', 'question'], rows);
      return send(req, res, 200, page(rows));
    }
    if (p === '/messages' || p === '/messages.csv') {
      const M = require('./messages'); const type = qp('type') === 'sms' ? 'sms' : 'email';
      const rows = (d.sentMessages ? d.sentMessages.list(type) : []).filter(mine);
      if (p === '/messages.csv') return csv(type === 'email' ? 'sent-emails.csv' : 'sent-texts.csv', M.MSG_COLS, M.csvRows(rows));
      const id = qp('id').slice(0, 80);
      if (id) { const r = rows.find((x) => x.id === id); return r ? send(req, res, 200, r) : send(req, res, 404, { error: 'not_found' }); }
      return send(req, res, 200, page(rows));
    }
    return send(req, res, 404, { error: 'not_found' });
  }
  return { route, _cache: cache };
}
module.exports = { createOwnerApi, redactedConfig, EXT_ORIGIN, SAFE_FIELDS };
