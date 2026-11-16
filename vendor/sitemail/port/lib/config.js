'use strict';
// Site config: validation and the mappings the framework uses (brand.json for the reference modules, an isolated
// env object for the mail modules). Pure functions; no I/O except loadConfig.
const path = require('path');
const { MODULES, IDS } = require('./modules');

const PLACEHOLDER = /<<CHANGE_ME/;
const ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const EMAIL = /^[^\s@<>]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const ENVNAME = /^[A-Z][A-Z0-9_]{1,63}$/;
// Data folders a host may already use; the package namespace may never be one of them.
const RESERVED_NS = new Set(['kb', 'kb-api', 'mailbox', 'mail', 'tenants', 'secrets', 'calls', 'sms', 'backups', 'data', 'tmp', '.', '..']);
const SECRET_KEYS = ['RESEND_MAIL_READ_KEY', 'MAILBOX_ENC_KEY', 'MAIL_SESSION_SECRET', 'MAILBOX_RESEND_WEBHOOK_SECRET', 'XAI_API_KEY', 'KB_API_WRITE_TOKEN_HASH', 'MAIL_READ_TOKEN_HASH', 'MAIL_RERUN_TOKEN_HASH', 'SHOPIFY_ADMIN_SHOP', 'SHOPIFY_ADMIN_CLIENT_ID', 'SHOPIFY_ADMIN_CLIENT_SECRET'];
const SHOP_KEYS = ['SHOPIFY_ADMIN_SHOP', 'SHOPIFY_ADMIN_CLIENT_ID', 'SHOPIFY_ADMIN_CLIENT_SECRET'];

function loadConfig(file) { const f = path.resolve(file); delete require.cache[f]; return require(f); }

function moduleOn(cfg, id) { const m = cfg && cfg.modules && cfg.modules[id]; return m === true || !!(m && typeof m === 'object' && m.enabled); }

// Every problem with a config, as plain sentences. ok only when the list is empty.
function validate(cfg) {
  const e = [];
  const scan = (v, at) => { if (typeof v === 'string') { if (PLACEHOLDER.test(v)) e.push(at + ' still has a <<CHANGE_ME>> placeholder'); } else if (Array.isArray(v)) v.forEach((x, i) => scan(x, at + '[' + i + ']')); else if (v && typeof v === 'object') for (const k of Object.keys(v)) scan(v[k], at ? at + '.' + k : k); };
  if (!cfg || typeof cfg !== 'object') return { ok: false, errors: ['config is not an object'] };
  scan(cfg, '');
  const s = cfg.site || {}; const m = cfg.mail || {}; const kb = cfg.kb || {}; const d = cfg.data || {};
  if (!ID.test(String(s.id || ''))) e.push('site.id must be lowercase letters, digits and dashes');
  for (const k of ['name', 'company', 'product']) if (!String(s[k] || '').trim()) e.push('site.' + k + ' is required');
  if (!DOMAIN.test(String(s.domain || ''))) e.push('site.domain must be a bare domain like example.com');
  if (!/^https:\/\/[a-z0-9.-]+$/.test(String(s.public_base_url || ''))) e.push('site.public_base_url must be https://<domain> with no path');
  if (!Array.isArray(s.link_allowlist) || !s.link_allowlist.length || s.link_allowlist.some((x) => !DOMAIN.test(String(x)))) e.push('site.link_allowlist must list at least one domain');
  const from = String(m.from || ''); const fromAddr = (from.match(/<([^>]+)>/) || [, from])[1];
  if (!EMAIL.test(fromAddr)) e.push('mail.from must be "Name <address@domain>"');
  if (m.base != null && !/^\/[a-z][a-z0-9-]{1,30}$/.test(String(m.base))) e.push('mail.base must be a path like /inbox');
  if (!Array.isArray(m.domains) || !m.domains.length || m.domains.some((x) => !DOMAIN.test(String(x)))) e.push('mail.domains must list at least one domain');
  else if (EMAIL.test(fromAddr) && !m.domains.includes(fromAddr.split('@')[1].toLowerCase())) e.push('mail.from must be an address on one of mail.domains');
  if (!EMAIL.test(String(m.owner_email || ''))) e.push('mail.owner_email must be an email address');
  if (!ID.test(String(kb.tenant_id || ''))) e.push('kb.tenant_id must be lowercase letters, digits and dashes');
  if (kb.host_kb_dirs && (!Array.isArray(kb.host_kb_dirs) || kb.host_kb_dirs.some((p) => typeof p !== 'string' || path.isAbsolute(p) || p.split(/[\\/]/).includes('..')))) e.push('kb.host_kb_dirs must be paths inside the host repo, or $DATA_DIR/<folder> for the host data disk');
  const ns = String(d.namespace || '');
  if (!/^[a-z0-9][a-z0-9_-]{2,40}$/.test(ns) || RESERVED_NS.has(ns)) e.push('data.namespace must be a new folder name (not ' + [...RESERVED_NS].filter((x) => /^[a-z]/.test(x)).join(', ') + ')');
  const mods = cfg.modules || {};
  for (const k of Object.keys(mods)) if (!IDS.includes(k)) e.push('modules.' + k + ' is not a known module (' + IDS.join(', ') + ')');
  for (const id of IDS) {
    const v = mods[id];
    if (v !== true && v !== false && !(v && typeof v === 'object')) e.push('modules.' + id + ' must be true, false or { enabled, factory }');
    if (v && typeof v === 'object' && v.factory && (typeof v.factory !== 'string' || !v.factory.startsWith('./'))) e.push('modules.' + id + '.factory must be a relative path starting with ./');
    if (moduleOn(cfg, id)) for (const need of MODULES[id].needs) if (!moduleOn(cfg, need)) e.push('modules.' + id + ' needs modules.' + need + ' on');
  }
  const st = cfg.store || {};
  if (moduleOn(cfg, 'order_lookup')) {
    if (!st.enabled) e.push('modules.order_lookup is on but store.enabled is false');
    if (!DOMAIN.test(String(st.store_domain || ''))) e.push('store.store_domain must be a domain when order lookup is on');
  }
  const sec = cfg.secrets || {};
  for (const k of SECRET_KEYS) {
    if (SHOP_KEYS.includes(k) && !moduleOn(cfg, 'order_lookup')) continue;
    if (!ENVNAME.test(String(sec[k] || ''))) e.push('secrets.' + k + ' must name an env variable (UPPER_CASE)');
  }
  for (const [k, v] of Object.entries(sec)) if (typeof v === 'string' && v.length > 40 && /[a-z]/.test(v)) e.push('secrets.' + k + ' looks like a secret value; put only the env variable NAME here');
  for (const sec2 of [['public_kb', 'replace'], ['prompts', 'replace']]) { const r = (cfg[sec2[0]] || {})[sec2[1]] || []; if (!Array.isArray(r) || r.some((p) => !Array.isArray(p) || p.length !== 2 || !p[0])) e.push(sec2.join('.') + ' must be a list of [from, to] pairs'); }
  if (kb.seed_import != null && kb.seed_import !== false && (typeof kb.seed_import !== 'string' || !/^seed\/[a-z0-9._/-]+\.json$/i.test(kb.seed_import) || kb.seed_import.includes('..'))) e.push('kb.seed_import must be a package path like seed/public-kb/<name>.json, or false');
  if (kb.growth != null && (typeof kb.growth !== 'object' || (kb.growth.proposals_per_day != null && !(Number.isInteger(kb.growth.proposals_per_day) && kb.growth.proposals_per_day >= 0 && kb.growth.proposals_per_day <= 100)))) e.push('kb.growth.proposals_per_day must be a whole number 0-100');
  if (kb.light_first != null) { const lf = kb.light_first; if (typeof lf !== 'object' || Array.isArray(lf)) e.push('kb.light_first must be an object like { mail: true, phone: true, sms: true, phone_tenants: [\'rfsafe\'] }'); else { for (const ch of ['mail', 'phone', 'sms']) if (lf[ch] != null && typeof lf[ch] !== 'boolean') e.push('kb.light_first.' + ch + ' must be true or false'); if (lf.phone_tenants != null && (!Array.isArray(lf.phone_tenants) || lf.phone_tenants.some((t) => !/^[a-z0-9_-]{1,40}$/i.test(String(t))))) e.push('kb.light_first.phone_tenants must be a list of host tenant ids'); if (lf.min_terms != null && !(Number.isInteger(lf.min_terms) && lf.min_terms >= 1 && lf.min_terms <= 6)) e.push('kb.light_first.min_terms must be 1 to 6'); if (lf.min_coverage != null && !(typeof lf.min_coverage === 'number' && lf.min_coverage > 0 && lf.min_coverage <= 1)) e.push('kb.light_first.min_coverage must be over 0 and at most 1'); } }
  if ((cfg.store || {}).single_variant_color != null && !/^[A-Za-z][A-Za-z -]{0,30}$/.test(String(cfg.store.single_variant_color))) e.push('store.single_variant_color must be a color name like Black');
  const pk = cfg.public_kb || {};
  if (pk.seed != null && (typeof pk.seed !== 'string' || !/^seed\/[a-z0-9._/-]+\.json$/i.test(pk.seed) || pk.seed.includes('..'))) e.push('public_kb.seed must be a package path like seed/public-kb/<name>.json');
  if (pk.research_base != null && pk.research_base !== '' && !/^https:\/\/[a-z0-9.-]+(\/[^\s]*)?$/i.test(String(pk.research_base))) e.push('public_kb.research_base must be an https URL or empty');
  if (pk.brand != null && (typeof pk.brand !== 'object' || Array.isArray(pk.brand))) e.push('public_kb.brand must be an object');
  if (pk.host_kb != null) { const h = pk.host_kb; if (typeof h !== 'object' || (h.page_types != null && (!Array.isArray(h.page_types) || h.page_types.some((t) => !/^[a-z-]+$/.test(String(t)))))) e.push('public_kb.host_kb.page_types must be a list of page types'); }
  if (cfg.shared_env != null && (!Array.isArray(cfg.shared_env) || cfg.shared_env.some((n) => !ENVNAME.test(String(n))))) e.push('shared_env must be a list of env variable names');
  if (!ENVNAME.test(String(cfg.enable_env || ''))) e.push('enable_env must name an env variable');
  return { ok: !e.length, errors: e };
}

// brand.json for the reference modules (src/brand.js reads it).
function toBrand(cfg) {
  const s = cfg.site; const st = cfg.store || {};
  return {
    id: s.id, name: s.name, company: s.company, product: s.product, site: s.domain, domain: s.domain,
    store: st.enabled && st.store_domain ? st.store_domain : s.domain, from: cfg.mail.from,
    link_allowlist: [...new Set([...s.link_allowlist, ...(st.enabled ? st.store_hosts || [] : [])])],
    kb_source_allowlist: [...new Set(s.link_allowlist)], sar_site: s.domain,
    mailbox: { store_hosts: st.enabled ? st.store_hosts || [] : [], own_site_names: st.enabled && (st.own_site_names || []).length ? st.own_site_names : [s.domain.split('.')[0]], prompt_replace: (cfg.prompts || {}).replace || [] },
    public_kb: { replace: (cfg.public_kb || {}).replace || [], hide: (cfg.public_kb || {}).hide || [], ...((cfg.public_kb || {}).brand ? { brand: cfg.public_kb.brand } : {}), ...((cfg.public_kb || {}).research_base ? { research_base: cfg.public_kb.research_base } : {}) },
  };
}

// The env object the mail modules see: only this package's values, mapped from the host env by name.
function moduleEnv(hostEnv, cfg) {
  const out = { MAIL_DOMAINS: cfg.mail.domains.join(','), MAIL_OWNER_EMAIL: cfg.mail.owner_email };
  if (hostEnv.XAI_TEXT_MODEL) out.XAI_TEXT_MODEL = hostEnv.XAI_TEXT_MODEL;
  // Color answers for a product with no color option (rfsafe.app PR #73; John: "it's always black"). Config, not host env.
  const sv = String(((cfg.store || {}).single_variant_color) || '').trim(); if (sv) out.MAIL_SINGLE_VARIANT_COLOR = sv;
  if (hostEnv.MAIL_MOCK === '1' || hostEnv.SITEMAIL_MOCK === '1') out.MAIL_MOCK = '1';
  for (const [k, name] of Object.entries(cfg.secrets || {})) {
    if (SHOP_KEYS.includes(k) && !moduleOn(cfg, 'order_lookup')) continue; // store off: no store credentials at all
    const v = hostEnv[name]; if (v != null && String(v) !== '') out[k] = String(v);
  }
  return out;
}
function enabledAtRuntime(hostEnv, cfg) { return String(hostEnv[cfg.enable_env] == null ? '1' : hostEnv[cfg.enable_env]).trim() !== '0'; }
// Route patterns of the enabled modules (for collision checks against the host).
function mailBase(cfg) { return (cfg && cfg.mail && cfg.mail.base) || '/mail'; }
// The owner inbox path (mail.base, default /mail) replaces the /mail prefix in module routes.
function routesOf(cfg) { const b = mailBase(cfg); return IDS.filter((id) => moduleOn(cfg, id)).flatMap((id) => MODULES[id].routes.map((r) => ({ module: id, route: r === '/mail' ? b : r.startsWith('/mail/') ? b + r.slice(5) : r }))); }

module.exports = { mailBase, loadConfig, validate, moduleOn, toBrand, moduleEnv, enabledAtRuntime, routesOf, SECRET_KEYS, RESERVED_NS, PLACEHOLDER };
