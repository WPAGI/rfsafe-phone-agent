'use strict';
// Daily usage snapshots pushed from the owner's computer to POST /admin/usage/snapshot (Bearer USAGE_SNAPSHOT_SECRET).
// Validated strictly, stored atomically as DATA_DIR/usage-snapshot.json (latest only), rendered by /admin/usage.
// Snapshot content is untrusted: every string is length-capped here and HTML-escaped by usagepage.js.
const fs = require('fs');
const crypto = require('crypto');

const MAX_BYTES = 256 * 1024;
const LIM = { services: 30, items: 50, daily: 62, str: 200, note: 1000 };
const KINDS = { exact: 'exact', estimated: 'estimated', estimate: 'estimated', flat: 'plan', plan: 'plan' };
const STATUSES = ['ok', 'error', 'not_connected', 'partial'];
const KNOWN = { twilio: 'twilio', 'grok voice': 'xai_voice', xai_voice: 'xai_voice', 'xai voice': 'xai_voice', 'xai text': 'xai_text', xai_text: 'xai_text', xai: 'xai_text', resend: 'resend', render: 'render', shopify: 'shopify' };

// Constant-time Bearer check. Unset/empty secret => never authorized.
function bearerOk(header, secret) {
  if (!secret) return false;
  const m = /^Bearer (.+)$/.exec(String(header || '')); if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest(); const b = crypto.createHash('sha256').update(String(secret)).digest();
  return crypto.timingSafeEqual(a, b) && m[1].length === String(secret).length; // hashing equalizes lengths
}

const isStr = (v, max = LIM.str) => typeof v === 'string' && v.length <= max;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e9;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const optStr = (v, max) => v === undefined || v === null || isStr(v, max);

// Returns { ok:true, value } with a clean copy (unknown keys dropped) or { ok:false, error }.
function validate(s) {
  if (!isObj(s)) return { ok: false, error: 'not_an_object' };
  if (!(isNum(s.version) || isStr(s.version, 20))) return { ok: false, error: 'bad_version' };
  if (!isStr(s.generated_at, 40) || Number.isNaN(Date.parse(s.generated_at))) return { ok: false, error: 'bad_generated_at' };
  if (!Array.isArray(s.services) || s.services.length > LIM.services) return { ok: false, error: 'bad_services' };
  const services = [];
  for (const [i, x] of s.services.entries()) {
    const bad = (w) => ({ ok: false, error: `services[${i}].${w}` });
    if (!isObj(x)) return bad('type');
    if (!isStr(x.service, 60) || !x.service.trim()) return bad('service');
    if (!STATUSES.includes(x.status)) return bad('status');
    const o = { service: x.service, status: x.status };
    if (x.items !== undefined) {
      if (!Array.isArray(x.items) || x.items.length > LIM.items) return bad('items');
      o.items = [];
      for (const it of x.items) {
        if (!isObj(it) || !isStr(it.name) || !isStr(it.label, 20) || !KINDS[it.label.toLowerCase()]) return bad('items');
        const hasU = it.usd !== undefined, hasM = it.usd_month !== undefined;
        if (hasU === hasM || (hasU && !isNum(it.usd)) || (hasM && !isNum(it.usd_month))) return bad('items');
        o.items.push({ name: it.name, label: it.label, ...(hasU ? { usd: it.usd } : { usd_month: it.usd_month }) });
      }
    }
    if (x.total_usd_month_to_date !== undefined) { if (!isNum(x.total_usd_month_to_date)) return bad('total_usd_month_to_date'); o.total_usd_month_to_date = x.total_usd_month_to_date; }
    if (x.daily !== undefined) {
      if (!Array.isArray(x.daily) || x.daily.length > LIM.daily) return bad('daily');
      o.daily = [];
      for (const dd of x.daily) { if (!isObj(dd) || !isStr(dd.date, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(dd.date) || !isNum(dd.usd)) return bad('daily'); o.daily.push({ date: dd.date, usd: dd.usd }); }
    }
    if (!optStr(x.error, LIM.note)) return bad('error'); if (x.error) o.error = x.error;
    if (!optStr(x.note, LIM.note)) return bad('note'); if (x.note) o.note = x.note;
    services.push(o);
  }
  return { ok: true, value: { version: s.version, generated_at: s.generated_at, services } };
}

function store(file, value, nowMs = Date.now()) {
  const stored_at = new Date(nowMs).toISOString();
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...value, stored_at }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return stored_at;
}
// Latest stored snapshot, re-validated; null when missing or unreadable (caller falls back to live fetch).
function load(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); const v = validate(j); return v.ok ? { ...v.value, stored_at: typeof j.stored_at === 'string' ? j.stored_at : null } : null; } catch { return null; }
}

const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const toEt = (iso) => etFmt.format(new Date(iso)) + ' ET';
const r2 = (n) => Math.round(n * 100) / 100;

// Convert a stored snapshot into the shape usagepage.page() renders.
function toPageSnap(sn, nowMs = Date.now()) {
  const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10); const days = Array.from({ length: 30 }, (_, i) => dayOf(nowMs - (29 - i) * 86400000));
  const used = new Set();
  const services = sn.services.map((x) => {
    let id = KNOWN[x.service.toLowerCase()] || 'snap_' + x.service.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
    while (used.has(id)) id += '_'; used.add(id);
    const figures = (x.items || []).map((it) => ({ label: it.name, value: it.usd !== undefined ? it.usd : it.usd_month, unit: 'usd', kind: KINDS[it.label.toLowerCase()], ...(it.usd_month !== undefined ? { note: 'per month' } : {}) }));
    const kinds = [...new Set(figures.map((f) => f.kind))]; const kind = kinds.length === 1 ? kinds[0] : kinds.includes('exact') ? 'exact' : kinds[0] || null;
    const dmap = {}; for (const dd of x.daily || []) dmap[dd.date] = (dmap[dd.date] || 0) + dd.usd;
    const mtd = x.total_usd_month_to_date !== undefined ? x.total_usd_month_to_date : figures.reduce((a, f) => a + (Number(f.value) || 0), 0);
    const status = x.status === 'partial' ? 'ok' : x.status;
    return { id, name: x.service, what: 'From daily snapshot', kind, status, error: x.error || (status === 'error' ? 'reported as unavailable' : undefined), note: x.note, needs: [], figures, daily: days.map((d) => ({ day: d, cost: r2(dmap[d] || 0) })), mtd: r2(mtd), last: 0, last_unknown: true, today: 0, updated: sn.generated_at };
  });
  const counted = services.filter((s) => s.status !== 'error'); const mtd = r2(counted.reduce((a, s) => a + s.mtd, 0));
  const d = new Date(nowMs); const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const { PRICING } = require('./usage');
  return { source: 'snapshot', updated_et: toEt(sn.generated_at), generated: sn.generated_at, stored_at: sn.stored_at, month: d.toISOString().slice(0, 7), mtd, last: 0, delta: 0, no_last: true, day_of_month: d.getUTCDate(), days_in_month: dim, days, services, pricing: { checked: PRICING.checked, xai: PRICING.xai.source, render: PRICING.render.source, resend: PRICING.resend.source }, ttl_minutes: 24 * 60 };
}

module.exports = { MAX_BYTES, LIM, bearerOk, validate, store, load, toPageSnap, toEt };
