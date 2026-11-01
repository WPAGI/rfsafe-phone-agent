'use strict';
// Admin "Usage & Costs": per-provider usage and spend, fetched server-side only. Every figure is tagged
// exact (provider API), estimated (app records x published price) or plan (fixed plan price).
// Keys never leave this module: responses carry numbers, labels and env var NAMES only; provider error
// bodies are dropped (only the HTTP status is kept). Cached per provider; one failure never breaks the page.
const fs = require('fs');
const path = require('path');

// Published prices (USD). Update here when a provider changes its list price.
const PRICING = {
  checked: '2026-11-01',
  xai: { source: 'https://docs.x.ai/developers/pricing', per_mtok: { 'grok-4.7': { in: 2, cached: 0.5, out: 6 }, 'grok-4.6': { in: 2, cached: 0.5, out: 6 }, default: { in: 2, cached: 0.5, out: 6 } }, voice_per_min: 0.08 },
  render: { source: 'https://render.com/pricing', plans: { free: 0, starter: 7, standard: 25, pro: 85, 'pro plus': 175, 'pro max': 225, 'pro ultra': 450 }, disk_per_gb: 0.25,
    // The account as billed: Pro workspace plan (flat), one Standard instance (2 GB RAM), 1 GB disk. Instance and disk
    // prices come from plans/disk_per_gb above.
    workspace: { name: 'Pro', monthly: 25 }, instance: { plan: 'standard', ram: '2 GB' }, disk_gb: 1 },
  resend: { source: 'https://resend.com/pricing', plan: 'Free', monthly: 0, included: 3000 },
};
const TTL_MS = 12 * 60 * 1000;
const DAYS = 30;
const r2 = (n) => Math.round(n * 100) / 100;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);
const lastMonthOf = (ms) => { const d = new Date(ms); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7); };
const daysBack = (now, n = DAYS) => Array.from({ length: n }, (_, i) => dayOf(now - (n - 1 - i) * 86400000));
const fig = (label, value, unit, kind, note) => ({ label, value, unit, kind, ...(note ? { note } : {}) });
class ProviderError extends Error { constructor(status, what) { super(`${what} HTTP ${status}`); this.status = status; } }

// Per-day token counters for the SMS brain (the app's only metered text-model use). Tiny JSON file, no DB.
class TokenCounter {
  constructor({ file = null, now = () => Date.now(), keepDays = 400 } = {}) {
    this.file = file; this.now = now; this.keepDays = keepDays; this.days = {};
    if (file && fs.existsSync(file)) { try { this.days = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { this.days = {}; } }
  }
  add(model, usage) {
    if (!usage) return;
    const d = dayOf(this.now()); const m = String(model || 'unknown').slice(0, 40);
    const e = ((this.days[d] ||= {})[m] ||= { in: 0, cached: 0, out: 0, req: 0 });
    const cached = Number(usage.prompt_tokens_details?.cached_tokens) || 0;
    e.in += Math.max(0, (Number(usage.prompt_tokens) || 0) - cached); e.cached += cached;
    e.out += Number(usage.completion_tokens) || 0; e.req += 1;
    const cut = dayOf(this.now() - this.keepDays * 86400000); for (const k of Object.keys(this.days)) if (k < cut) delete this.days[k];
    this.save();
  }
  save() { if (!this.file) return; try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.days), { mode: 0o600 }); fs.renameSync(tmp, this.file); } catch { /* counters are best-effort */ } }
}
function tokenCost(e, model) { const p = PRICING.xai.per_mtok[model] || PRICING.xai.per_mtok.default; return (e.in * p.in + e.cached * p.cached + e.out * p.out) / 1e6; }

// Helpers to roll daily rows into today / month-to-date / last month.
function roll(daily, now) { const t = dayOf(now), m = monthOf(now), lm = lastMonthOf(now); let today = 0, mtd = 0, last = 0; for (const [d, v] of Object.entries(daily)) { if (d === t) today += v; if (d.startsWith(m)) mtd += v; if (d.startsWith(lm)) last += v; } return { today, mtd, last }; }
const series = (daily, now) => daysBack(now).map((d) => ({ day: d, cost: r2(daily[d] || 0) }));

// ---- providers ----
async function twilio({ env, fetchImpl, now }) {
  const sid = env.TWILIO_ACCOUNT_SID || env.RFSAFE_TWILIO_ACCOUNT_SID; const tok = env.RFSAFE_TWILIO_AUTH_TOKEN || env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) return { status: 'not_connected', needs: [!sid && 'TWILIO_ACCOUNT_SID (or RFSAFE_TWILIO_ACCOUNT_SID)', !tok && 'RFSAFE_TWILIO_AUTH_TOKEN (or TWILIO_AUTH_TOKEN)'].filter(Boolean) };
  if (!/^AC[0-9a-zA-Z]{32}$/.test(sid)) return { status: 'error', error: 'TWILIO_ACCOUNT_SID is not a valid Account SID' };
  const auth = 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64');
  const base = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Usage/Records`;
  const get = async (p) => { const r = await fetchImpl(base + p, { headers: { authorization: auth, accept: 'application/json' } }); if (!r.ok) throw new ProviderError(r.status, 'Twilio'); return (await r.json()).usage_records || []; };
  const start = daysBack(now)[0];
  const [today, month, last, daily] = await Promise.all([get('/Today.json?PageSize=1000'), get('/ThisMonth.json?PageSize=1000'), get('/LastMonth.json?PageSize=1000'), get(`/Daily.json?Category=totalprice&StartDate=${start}&EndDate=${dayOf(now)}&PageSize=100`)]);
  const cat = (rows, c) => rows.find((x) => x.category === c) || {};
  const num = (v) => Number(v) || 0;
  const dmap = {}; for (const x of daily) dmap[String(x.start_date).slice(0, 10)] = num(x.price);
  const mt = cat(month, 'totalprice'); const lt = cat(last, 'totalprice'); const tt = cat(today, 'totalprice');
  return {
    status: 'ok', kind: 'exact', mtd: num(mt.price), last: num(lt.price), today: num(tt.price), daily: series(dmap, now),
    figures: [fig('Calls this month', num(cat(month, 'calls').count), 'calls', 'exact'), fig('Call minutes this month', num(cat(month, 'calls').usage), 'min', 'exact'), fig('Texts this month', num(cat(month, 'sms').count), 'sms', 'exact'), fig('Calls cost this month', num(cat(month, 'calls').price), 'usd', 'exact'), fig('Texts cost this month', num(cat(month, 'sms').price), 'usd', 'exact'), fig('Spend today', num(tt.price), 'usd', 'exact'), fig('Spend last month', num(lt.price), 'usd', 'exact')],
  };
}
function xaiText({ env, tokens, now }) {
  if (!env.XAI_API_KEY) return { status: 'not_connected', needs: ['XAI_API_KEY'] };
  const days = (tokens && tokens.days) || {}; const dmap = {}; let tin = 0, tout = 0, req = 0; const m = monthOf(now);
  for (const [d, models] of Object.entries(days)) for (const [model, e] of Object.entries(models)) { dmap[d] = (dmap[d] || 0) + tokenCost(e, model); if (d.startsWith(m)) { tin += e.in + e.cached; tout += e.out; req += e.req; } }
  const r = roll(dmap, now);
  return { status: 'ok', kind: 'estimated', ...r, daily: series(dmap, now), note: 'Text replies only (SMS brain). Tokens counted by this app since the counter was added, times published grok-4.7 prices. xAI offers no usage API for this key type.',
    figures: [fig('Model requests this month', req, 'req', 'estimated'), fig('Input tokens this month', tin, 'tok', 'estimated'), fig('Output tokens this month', tout, 'tok', 'estimated'), fig('Est. text cost this month', r2(r.mtd), 'usd', 'estimated')] };
}
function xaiVoice({ env, callRecords, now }) {
  if (!env.XAI_API_KEY) return { status: 'not_connected', needs: ['XAI_API_KEY'] };
  const recs = callRecords ? callRecords.read() : []; const mins = {}; const m = monthOf(now); let calls = 0, mtdMin = 0;
  for (const c of recs) { const s = Number(c.seconds); if (!c.at || !Number.isFinite(s) || s <= 0) continue; const d = String(c.at).slice(0, 10); mins[d] = (mins[d] || 0) + s / 60; if (d.startsWith(m)) { calls++; mtdMin += s / 60; } }
  const dmap = Object.fromEntries(Object.entries(mins).map(([d, v]) => [d, v * PRICING.xai.voice_per_min])); const r = roll(dmap, now);
  return { status: 'ok', kind: 'estimated', ...r, daily: series(dmap, now), note: 'Call minutes from this app\'s call records x $0.08/min (Grok Voice speech-to-speech).',
    figures: [fig('Voice calls this month', calls, 'calls', 'estimated'), fig('Voice minutes this month', r2(mtdMin), 'min', 'estimated'), fig('Est. voice cost this month', r2(r.mtd), 'usd', 'estimated')] };
}
function resend({ env, sentMessages, now }) {
  if (!env.RESEND_API_KEY) return { status: 'not_connected', needs: ['RESEND_API_KEY'] };
  const rows = sentMessages ? sentMessages.read().filter((r) => r.channel === 'email' && r.status === 'sent') : []; const cnt = {};
  for (const x of rows) { const d = String(x.at).slice(0, 10); cnt[d] = (cnt[d] || 0) + 1; }
  const c = roll(cnt, now); const p = PRICING.resend;
  return { status: 'ok', kind: 'plan', mtd: p.monthly, last: p.monthly, today: 0, daily: daysBack(now).map((d) => ({ day: d, cost: 0, count: cnt[d] || 0 })), note: `Plan price is fixed (${p.plan}, ${p.included.toLocaleString('en-US')} emails/month included). Email counts come from this app's sent-message log.`,
    figures: [fig('Plan', p.plan, 'text', 'plan'), fig('Plan cost / month', p.monthly, 'usd', 'plan'), fig('Emails sent this month', c.mtd, 'emails', 'estimated'), fig('Emails sent last month', c.last, 'emails', 'estimated'), fig('Of monthly allowance', p.included ? Math.round((c.mtd / p.included) * 100) : 0, '%', 'estimated')] };
}
function renderLines(P) {
  return [fig(`${P.workspace.name} plan`, P.workspace.monthly, 'usd', 'plan', 'flat, per month'),
    fig(`Standard instance (${P.instance.ram})`, P.plans[P.instance.plan], 'usd', 'plan', 'per month, from PRICING table'),
    fig(`${P.disk_gb} GB disk`, r2(P.disk_gb * P.disk_per_gb), 'usd', 'plan', 'per month, from PRICING table')];
}
function yamlPlan(file) { try { const s = fs.readFileSync(file, 'utf8'); return { plan: (s.match(/^\s*plan:\s*([\w ]+)/m) || [])[1]?.trim() || null, disk: Number((s.match(/sizeGB:\s*(\d+)/) || [])[1]) || 0 }; } catch { return { plan: null, disk: 0 }; } }
async function render({ env, fetchImpl, now, renderYaml }) {
  const P = PRICING.render; const y = yamlPlan(renderYaml);
  const planCost = (pl) => P.plans[String(pl || '').toLowerCase().replace(/_/g, ' ')] ?? null;
  const lines = renderLines(P);
  if (!env.RENDER_API_KEY) {
    const total = lines.reduce((a, f) => a + f.value, 0);
    return { status: 'not_connected', needs: ['RENDER_API_KEY'], kind: 'plan', mtd: total, last: total, today: 0, daily: [], note: `Account as billed: Pro plan + Standard instance + ${P.disk_gb} GB disk. Instance and disk prices from this app's PRICING table (render.yaml says ${y.plan || 'unknown'}). Live plan not confirmed without an API key.`, figures: lines };
  }
  const r = await fetchImpl('https://api.render.com/v1/services?limit=100', { headers: { authorization: 'Bearer ' + env.RENDER_API_KEY, accept: 'application/json' } });
  if (!r.ok) throw new ProviderError(r.status, 'Render');
  const items = (await r.json()) || []; let total = P.workspace.monthly; const figures = [lines[0]];
  for (const it of items) { const s = it.service || it; const pl = s.serviceDetails?.plan || null; const c = planCost(pl); if (s.suspended === 'suspended') continue; total += c || 0; figures.push(fig(`${String(s.name || s.type || 'service').slice(0, 60)} (${pl || 'no plan'})`, c ?? 0, 'usd', 'plan', c == null ? 'price not in table' : undefined)); }
  total += lines[2].value; figures.push(lines[2]);
  return { status: 'ok', kind: 'plan', mtd: total, last: total, today: 0, daily: [], figures, note: 'Fixed monthly plan prices from the Render API service list. Bandwidth and build minutes not included.' };
}
function shopify({ env }) {
  const on = env.RFSAFE_SHOPIFY_STOREFRONT_TOKEN || env.SHOPIFY_ADMIN_CLIENT_ID;
  if (!on) return { status: 'not_connected', needs: ['RFSAFE_SHOPIFY_STOREFRONT_TOKEN'] };
  return { status: 'ok', kind: 'plan', mtd: 0, last: 0, today: 0, daily: [], note: 'The Storefront and Admin API calls this app makes are free. The store\'s own Shopify plan is billed to the store, not this app.', figures: [fig('API cost to this app', 0, 'usd', 'plan')] };
}
const PROVIDERS = [
  { id: 'twilio', name: 'Twilio', what: 'Phone line, calls & texts', run: twilio },
  { id: 'xai_voice', name: 'Grok Voice', what: 'xAI realtime voice for calls', run: xaiVoice },
  { id: 'xai_text', name: 'xAI text', what: 'grok-4.7 for text replies', run: xaiText },
  { id: 'resend', name: 'Resend', what: 'Email sending', run: resend },
  { id: 'render', name: 'Render', what: 'Hosting', run: render },
  { id: 'shopify', name: 'Shopify', what: 'Product & order lookup', run: shopify },
];

class UsageService {
  constructor({ env = {}, fetchImpl = globalThis.fetch, now = () => Date.now(), ttlMs = TTL_MS, tokens = null, callRecords = null, sentMessages = null, renderYaml = path.join(__dirname, '..', 'render.yaml'), log = () => {} } = {}) {
    Object.assign(this, { env, fetchImpl, now, ttlMs, tokens, callRecords, sentMessages, renderYaml, log }); this.cache = new Map(); this.fetches = 0;
  }
  async one(p) {
    const hit = this.cache.get(p.id); const t = this.now();
    if (hit && t - hit.at < this.ttlMs) return hit.v;
    let v;
    try { this.fetches++; v = await p.run({ ...this, now: t }); }
    catch (e) { const status = e instanceof ProviderError ? e.status : null; v = { status: 'error', error: status ? `${p.name} returned HTTP ${status}${status === 401 || status === 403 ? ' (check the key or its scope)' : ''}` : `${p.name} could not be reached` }; this.log('usage.provider_error', { provider: p.id, status: status || undefined, err: status ? undefined : String(e && e.name || 'Error') }); }
    v = { id: p.id, name: p.name, what: p.what, updated: new Date(t).toISOString(), needs: [], figures: [], daily: [], mtd: 0, last: 0, today: 0, ...v };
    for (const k of ['mtd', 'last', 'today']) v[k] = r2(Number(v[k]) || 0);
    this.cache.set(p.id, { at: t, v }); return v;
  }
  async snapshot() {
    const services = await Promise.all(PROVIDERS.map((p) => this.one(p)));
    const counted = services.filter((s) => s.status !== 'error');
    const mtd = r2(counted.reduce((a, s) => a + s.mtd, 0)); const last = r2(counted.reduce((a, s) => a + s.last, 0));
    const now = this.now(); const d = new Date(now); const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    return { generated: new Date(now).toISOString(), month: monthOf(now), mtd, last, delta: r2(mtd - last), day_of_month: d.getUTCDate(), days_in_month: dim, days: daysBack(now), services, pricing: { checked: PRICING.checked, xai: PRICING.xai.source, render: PRICING.render.source, resend: PRICING.resend.source }, ttl_minutes: Math.round(this.ttlMs / 60000) };
  }
}

// Per-session sliding window, in memory.
class SimpleLimiter { constructor({ max = 30, windowMs = 60000, now = () => Date.now() } = {}) { this.max = max; this.windowMs = windowMs; this.now = now; this.hits = new Map(); }
  allow(key) { const t = this.now(); const a = (this.hits.get(key) || []).filter((x) => t - x < this.windowMs); if (a.length >= this.max) { this.hits.set(key, a); return false; } a.push(t); this.hits.set(key, a); if (this.hits.size > 1000) for (const [k, v] of this.hits) if (!v.some((x) => t - x < this.windowMs)) this.hits.delete(k); return true; } }

module.exports = { PRICING, TTL_MS, TokenCounter, UsageService, SimpleLimiter, PROVIDERS, tokenCost, ProviderError };
