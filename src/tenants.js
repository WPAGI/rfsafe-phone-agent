'use strict';
// Multi-tenant config. Each tenant is a JSON file in TENANTS_DIR. Secrets are NEVER in tenant files:
// they are references ("env:NAME") resolved at runtime, or values in the encrypted SecretStore.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const E164 = /^\+[1-9]\d{7,14}$/;
const ID = /^[a-z0-9][a-z0-9-]{1,40}$/;

function validateTenant(t) {
  const errs = [];
  if (!ID.test(t.id || '')) errs.push('id must be lowercase slug');
  if (!t.name) errs.push('name required');
  if (!Array.isArray(t.numbers) || !t.numbers.every((n) => E164.test(n))) errs.push('numbers must be E.164 array');
  if (!Array.isArray(t.link_allowlist) || !t.link_allowlist.length) errs.push('link_allowlist required');
  else if (!t.link_allowlist.every((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d))) errs.push('link_allowlist must be bare domains');
  if (t.transfer_target && !/^(tel:\+[1-9]\d{7,14}|sip:[^\s]+)$/.test(t.transfer_target)) errs.push('transfer_target must be tel:+E164 or sip:');
  if (t.hours && !(t.hours.tz && /^\d\d:\d\d$/.test(t.hours.open) && /^\d\d:\d\d$/.test(t.hours.close))) errs.push('hours needs tz, open, close (HH:MM)');
  for (const [k, v] of Object.entries(t.secrets || {})) if (!/^env:[A-Z][A-Z0-9_]*$|^store:[a-z0-9_.-]+$/.test(String(v))) errs.push(`secrets.${k} must be env:NAME or store:KEY reference, never a value`);
  if (t.payments_enabled) errs.push('payments are never supported');
  if (t.known_callers != null) {
    if (typeof t.known_callers !== 'object' || Array.isArray(t.known_callers)) errs.push('known_callers must be an object of E.164 number -> {name, role?, greeting?}');
    else for (const [n, v] of Object.entries(t.known_callers)) {
      if (!E164.test(n)) errs.push(`known_callers key ${n} must be E.164`);
      if (!v || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 40) errs.push(`known_callers.${n}.name required (max 40)`);
      if (v && v.role != null && (typeof v.role !== 'string' || v.role.length > 120)) errs.push(`known_callers.${n}.role max 120 chars`);
      if (v && v.greeting != null && (typeof v.greeting !== 'string' || v.greeting.length > 200)) errs.push(`known_callers.${n}.greeting max 200 chars`);
      if (v && Object.keys(v).some((k) => !['name', 'role', 'greeting'].includes(k))) errs.push(`known_callers.${n} allows only name, role, greeting`);
    }
  }
  if (t.support_email != null && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(t.support_email)) errs.push('support_email must be an email address');
  return errs;
}

const DEFAULTS = {
  voice: 'eve',
  disclosure: 'Hi, you have reached {name}. This call may be recorded and is answered by an AI assistant.',
  approval_mode: true,
  order_lookup_enabled: false,
  max_call_seconds: 900,
  blocked_topics: [],
};

class TenantRegistry {
  constructor(dir, { skipExample = false } = {}) { this.dir = dir; this.skipExample = skipExample; this.byId = new Map(); this.byNumber = new Map(); this.files = new Map(); if (dir) this.loadDir(dir); }
  // In live mode, EXAMPLE tenant files (seeded demo data with 555 numbers) are ignored so they never route calls or block readiness.
  loadDir(dir) { for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) { const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (this.skipExample && raw._note && /EXAMPLE/.test(raw._note)) continue; const t = this.add(raw); if (t && t.id) this.files.set(t.id, f); } }
  add(raw) {
    const t = { ...DEFAULTS, ...raw };
    const errs = validateTenant(t);
    if (errs.length) throw Object.assign(new Error('invalid tenant ' + (raw.id || '?') + ': ' + errs.join('; ')), { status: 400 });
    if (this.byId.has(t.id)) throw Object.assign(new Error('tenant exists'), { status: 409 });
    for (const n of t.numbers) if (this.byNumber.has(n)) throw Object.assign(new Error('number already assigned to another tenant'), { status: 409 });
    this.byId.set(t.id, t); for (const n of t.numbers) this.byNumber.set(n, t.id);
    return t;
  }
  get(id) { return this.byId.get(id) || null; }
  forNumber(num) { const id = this.byNumber.get(normNumber(num)); return id ? this.byId.get(id) : null; }
  save(t) { if (!this.dir) return; fs.writeFileSync(path.join(this.dir, this.files.get(t.id) || (t.id + '.json')), JSON.stringify(t, null, 2)); } // rewrite the file it was loaded from, so a save never leaves two files claiming one number
  list() { return [...this.byId.values()]; }
}

function normNumber(s) {
  s = String(s || '').replace(/^sip:/, '').replace(/^tel:/, '').split(/[@;]/)[0].replace(/[^\d+]/g, '');
  if (/^\d{10}$/.test(s)) s = '+1' + s; else if (/^1\d{10}$/.test(s)) s = '+' + s;
  return s;
}

// Encrypted per-tenant secret store (AES-256-GCM). Keys are namespaced "<tenant>.<name>", so one tenant's
// tools can never resolve another tenant's token. Master key comes from env PA_MASTER_KEY (32-byte base64).
class SecretStore {
  constructor(file, masterKeyB64) {
    this.file = file; this.key = masterKeyB64 ? Buffer.from(masterKeyB64, 'base64') : null;
    if (this.key && this.key.length !== 32) throw new Error('PA_MASTER_KEY must be 32 bytes base64');
    this.data = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  }
  put(tenantId, name, value) {
    if (!this.key) throw new Error('secret store has no master key');
    const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(tenantId + '.' + name));
    const ct = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
    this.data[tenantId + '.' + name] = [iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
    if (this.file) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 }); }
    return 'store:' + name;
  }
  get(tenantId, name) {
    const v = this.data[tenantId + '.' + name]; if (!v || !this.key) return null;
    const [iv, tag, ct] = v.split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, iv); d.setAAD(Buffer.from(tenantId + '.' + name)); d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  }
}

// Resolve a tenant secret reference. Isolation: a tenant can only read refs declared in its own config.
function resolveSecret(tenant, name, { env = process.env, store } = {}) {
  const ref = (tenant.secrets || {})[name]; if (!ref) return null;
  if (ref.startsWith('env:')) return env[ref.slice(4)] || null;
  if (ref.startsWith('store:') && store) return store.get(tenant.id, ref.slice(6));
  return null;
}

module.exports = { TenantRegistry, SecretStore, resolveSecret, validateTenant, normNumber };
