'use strict';
// Site Mail + Brain box framework: the mount (the one seam between a host app and the modules).
//
//   const sitemail = require('./vendor/sitemail/port/mount').mountSiteMail(host, config);
//   // first line of the host's request handler:
//   if (await sitemail.route(req, res, new URL(req.url, 'http://x'))) return;
//
// host = { env, dataDir, rootDir, log, now, sendEmail?, fetchImpl?, mailChecker?, mailNow? }
// route() answers ONLY the paths of enabled modules and returns false for everything else, so the host's own
// routes (phone, text, admin) run exactly as before. All data goes to DATA_DIR/<data.namespace>; the host's KB
// folders (kb.host_kb_dirs) are read, never written. Set the kill-switch env (enable_env) to "0" to turn it off.
//
// The modules are the proven rfsafe.app code (src/...), unchanged; per-site values come from the generated
// brand.json (deploy/brand.json next to src/) and from the config. Any module can be replaced with
// modules.<id> = { enabled: true, factory: './file.js' }: the factory gets (ctx) and returns { route(req, res, u) }.
const fs = require('fs');
const path = require('path');
const C = require('./lib/config');

const ROOT = path.join(__dirname, '..');
const req = (p) => require(path.join(ROOT, p));

function mountSiteMail(host = {}, cfg) {
  const v = C.validate(cfg); if (!v.ok) throw new Error('sitemail config: ' + v.errors.join('; '));
  const hostEnv = host.env || process.env;
  const off = { enabled: false, modules: [], route: async () => false, status: () => ({ enabled: false }), close: () => {} };
  if (!C.enabledAtRuntime(hostEnv, cfg)) return off;
  if (!host.dataDir) throw new Error('sitemail: host.dataDir is required');
  const B = req('src/brand.js');
  if (B.id !== cfg.site.id || B.domain !== cfg.site.domain) throw new Error('sitemail: deploy/brand.json is for ' + B.id + ' (' + B.domain + '), not this config; run port/setup.js again');
  const log = (e, f) => { try { (host.log || (() => {}))('sitemail.' + e, f || {}); } catch {} };
  const now = host.now || (() => new Date());
  const on = (id) => C.moduleOn(cfg, id);
  const ns = path.join(host.dataDir, cfg.data.namespace);
  // The namespace is this package's alone: refuse a folder that already holds someone else's data.
  const marker = path.join(ns, '.sitemail.json');
  if (fs.existsSync(ns) && fs.readdirSync(ns).length && !fs.existsSync(marker)) throw new Error('sitemail: ' + ns + ' already holds data that is not sitemail\'s; choose another data.namespace');
  if (fs.existsSync(marker)) { const m = JSON.parse(fs.readFileSync(marker, 'utf8')); if (m.site !== cfg.site.id) throw new Error('sitemail: ' + ns + ' belongs to site ' + m.site); }
  fs.mkdirSync(ns, { recursive: true }); if (!fs.existsSync(marker)) fs.writeFileSync(marker, JSON.stringify({ site: cfg.site.id, created: new Date().toISOString() }) + '\n');
  const env = C.moduleEnv(hostEnv, cfg);
  const fetchImpl = host.fetchImpl || (env.MAIL_MOCK === '1' ? req('src/mailbox/mock.js').mockFetch() : globalThis.fetch);
  const { readBody, appendJsonl } = req('src/util.js');
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const tenantId = cfg.kb.tenant_id;
  const tenant = { id: tenantId, name: B.name, kb: { dirs: [] }, link_allowlist: B.link_allowlist };
  const gapFile = path.join(ns, 'kb-gaps.jsonl');

  // Knowledge for the Mailbox: the host's KB folders (read only) with this site's Brain box entries on top.
  const { KB } = req('src/kb.js');
  const hostDirs = (cfg.kb.host_kb_dirs || []).map((p) => (p.startsWith('$DATA_DIR/') ? path.join(host.dataDir, p.slice(10)) : path.resolve(host.rootDir || process.cwd(), p))).filter((p) => fs.existsSync(p));
  const entriesDir = path.join(ns, 'kb-api', tenantId, 'entries');
  let kbCache = null;
  // Read-only fingerprint of the host KB folders (file count + one sha256), so health checks can prove they never change.
  let fpCache = null;
  const hostKbFingerprint = () => {
    if (fpCache && Date.now() - fpCache.at < 300000) return fpCache.v;
    const h = require('crypto').createHash('sha256'); let files = 0;
    const walk = (root, d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const f = path.join(d, e.name); if (e.isDirectory()) walk(root, f); else if (e.isFile()) { files++; h.update(path.relative(root, f) + '\0'); h.update(fs.readFileSync(f)); h.update('\0'); } } };
    for (const d of hostDirs) { h.update('#' + d + '\0'); try { walk(d, d); } catch {} }
    fpCache = { at: Date.now(), v: { dirs: hostDirs.length, files, sha256: h.digest('hex').slice(0, 16) } }; return fpCache.v;
  };
  const kb = () => kbCache || (kbCache = new KB({ dirs: hostDirs, overrideDirs: fs.existsSync(entriesDir) ? [entriesDir] : [], allowlist: B.link_allowlist }));
  // KB Light first, KB Full fallback (src/kblight.js, port/KB_LIGHT.md; John, Nov 16, 2026, 3:06-3:08 AM ET).
  // KB Light = this site's Brain box entries only. KB Full = kb() above, searched exactly as before. Per-channel switches
  // in kb.light_first (mail, phone, sms); env KB_LIGHT_FIRST_<CHANNEL>=0 turns one back off. Read-only.
  let lightCache = null;
  const kbLight = () => lightCache || (lightCache = new KB({ dirs: fs.existsSync(entriesDir) ? [entriesDir] : [], allowlist: B.link_allowlist }));
  const lightEnv = Object.fromEntries(Object.entries(hostEnv || {}).filter(([k]) => /^KB_LIGHT_FIRST_(MAIL|PHONE|SMS)$/.test(k)));
  const LF = req('src/kblight.js').createKbLightFirst({ light: kbLight, env: lightEnv, cfg: cfg.kb.light_first || {} });
  const kbMailSearch = (q, k, o) => (LF.channelOn('mail') ? LF.search(kb(), q, k, o) : kb().search(q, k, o));
  const kbReset = () => { kbCache = null; lightCache = null; };

  const custom = (id, ctx) => { const m = cfg.modules[id]; if (!(m && typeof m === 'object' && m.factory)) return null; const f = require(path.resolve(host.rootDir || process.cwd(), m.factory)); return (f.create || f)(ctx); };
  const ctx = { cfg, env, log, now, ns, tenant, kb, kbReset, B };
  // One module failing to start (e.g. a missing secret) turns only that module off; the rest keep working.
  const failed = {};
  const safe = (id, fn) => { try { return fn(); } catch (e) { failed[id] = String(e && e.message || e).slice(0, 200); log('module_failed', { module: id, err: failed[id] }); return null; } };

  // Brain box: owner KB API store (write key) -> admin (editor/agents) -> public /kb.
  const kbApi = req('src/kbapi.js');
  const kbApiStore = on('brainbox_api') ? kbApi.open({ dataDir: ns, now }) : null;
  // One-time seed import (kb.seed_import): copy an exported public KB (e.g. rfsafe.app's Q&A, wording unchanged) into
  // THIS site's Brain box as owner-approved (so locked) entries. Additive: an existing slug is never touched, and a
  // marker with the seed's sha256 stops it from running twice (an entry the owner later disables stays disabled).
  // The source site is never written; the seed is a read-only package file.
  let seedImport = null;
  if (kbApiStore && cfg.kb.seed_import) seedImport = safe('seed_import', () => {
    const file = path.join(ROOT, cfg.kb.seed_import); const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const sha = require('crypto').createHash('sha256').update(JSON.stringify(doc.entries || [])).digest('hex');
    const marker = path.join(ns, 'kb-seed-import.json');
    let prev = null; try { prev = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch {}
    if (prev && prev.sha256 === sha) return { ...prev, ran: false };
    const res = { sha256: sha, from: doc.exported_from || null, source_data_version: doc.source_data_version || null, at: new Date(+now()).toISOString(), imported: 0, kept_existing: 0, errors: [] };
    for (const e of doc.entries || []) {
      if (!e || !kbApi.validateSlug(e.slug)) { res.errors.push(String(e && e.slug).slice(0, 80) + ': bad_slug'); continue; }
      if (kbApiStore.get(tenantId, e.slug)) { res.kept_existing++; continue; }
      const r = kbApiStore.put(tenantId, { slug: e.slug, title: e.title, text: e.text, source: e.source || '', owner_approved: true, enabled: true });
      if (r.ok) res.imported++; else res.errors.push(e.slug + ': ' + r.error);
    }
    res.errors = res.errors.slice(0, 50);
    fs.writeFileSync(marker, JSON.stringify(res, null, 1), { mode: 0o600 }); log('kb_seed_import', { imported: res.imported, kept_existing: res.kept_existing, errors: res.errors.length });
    kbReset(); return { ...res, ran: true };
  });
  let publicKb = null;
  const kbAdmin = on('brainbox_admin') && kbApiStore ? safe('brainbox_admin', () => custom('brainbox_admin', ctx) || req('src/kbadmin/index.js').createKbAdmin({ dataDir: ns, kbApiStore, tenant: () => tenant, kbReset: () => kbReset(), publicReset: () => publicKb && publicKb.reset && publicKb.reset(), catalog: () => req('src/kbcontrol.js').catalog({ tenant, tenantsDir: host.rootDir || null, dataDir: ns, apiStore: kbApiStore }), gapFile, log, now, webResearchSeed: null })) : null;
  // Public /kb layers (all read-only): this site's Brain box entries, then the exported seed KB shipped in the package
  // (public_kb.seed, e.g. rfsafe.app's public KB), then the host's own KB folders through the filtered adapter
  // (public_kb.host_kb). The seed file and the host folders are only read, never written.
  const pk = cfg.public_kb || {};
  const seedFile = pk.seed ? path.join(ROOT, pk.seed) : null; let seedCache = null;
  const seed = seedFile ? () => { const st = fs.statSync(seedFile); if (!seedCache || seedCache.m !== st.mtimeMs) seedCache = { m: st.mtimeMs, d: JSON.parse(fs.readFileSync(seedFile, 'utf8')) }; return seedCache.d; } : null;
  const hk = pk.host_kb && pk.host_kb.enabled ? pk.host_kb : null;
  const hostKbPublic = hk ? req('src/publickb/hostkb.js').createHostKb({ dirs: hostDirs, pageTypes: hk.page_types, publicNumbers: hk.public_numbers || [], publicEmails: hk.public_emails || [], topics: hk.topics || {}, linkBase: () => cfg.site.public_base_url }) : null;
  publicKb = on('public_kb') && kbApiStore ? safe('public_kb', () => custom('public_kb', ctx) || req('src/publickb/index.js').createPublicKb({ kbApiStore, tenantId: () => tenantId, visibility: (tid) => (kbAdmin && kbAdmin.store ? kbAdmin.store.visibility(tid) : {}), siteDir: path.join(ROOT, 'site'), dataDir: ns, now, baseUrl: () => cfg.site.public_base_url, seed, hostKb: hostKbPublic, researchBase: pk.research_base || '', log })) : null;

  // Owner sign-in email: the host's sender when given, else Resend with this site's key and From.
  const sendEmail = host.sendEmail || (async (m) => {
    if (!env.RESEND_MAIL_READ_KEY) return { ok: false, error: 'mail_not_configured' };
    const r = await fetchImpl('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + env.RESEND_MAIL_READ_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ from: B.from, to: [m.to], subject: m.subject, text: m.text, html: m.html }) });
    return { ok: r.ok };
  });

  // Brain box coverage metric + growth loop (src/mailbox/kbgrowth.js): an observer on the Mailbox writer; never changes a reply.
  const HK = req('src/publickb/hostkb.js');
  const growthCfg = cfg.kb.growth || {};
  const growth = on('kb_growth') && kbApiStore ? safe('kb_growth', () => req('src/mailbox/kbgrowth.js').createKbGrowth({
    dir: path.join(ns, 'kb-growth'), kb, tenantId: () => tenantId, brainEntries: () => kbApiStore.list(tenantId), store: kbAdmin && kbAdmin.store,
    hostEntries: () => (hostKbPublic ? hostKbPublic.read().entries : []), siteBase: cfg.site.public_base_url, slugOf: HK.slugOf,
    checkText: (t) => HK.checkText(t, { publicNumbers: (hk && hk.public_numbers) || [], publicEmails: (hk && hk.public_emails) || [] }),
    proposeCap: Number.isInteger(growthCfg.proposals_per_day) ? growthCfg.proposals_per_day : 10, now: () => new Date(+now()), log })) : null;

  // Mail: the /mail inbox and the Mailbox bots (sorter, writer, checker, auto-send gate, order lookup, web research).
  let mailbox = null;
  const mail = on('mail_viewer') ? safe('mail_viewer', () => custom('mail_viewer', ctx) || req('src/mail/index.js').createMail({ base: C.mailBase(cfg), env, mailbox: () => mailbox, kbAdmin: () => kbAdmin, siteName: B.name, log, publicBaseUrl: () => cfg.site.public_base_url, sendEmail, fetchImpl })) : null;
  if (on('mailbox') && mail) {
    mailbox = safe('mailbox', () => custom('mailbox', ctx) || req('src/mailbox/index.js').createMailbox({
      env, client: mail.client, siteName: B.name, fromAddress: B.from, log, now: host.mailNow, publicBaseUrl: () => cfg.site.public_base_url,
      file: path.join(ns, 'mailbox', 'mailbox.json'), fetchImpl, checker: host.mailChecker, bootReprocessWait: host.mailBootWait,
      shopifyCallbackUrl: cfg.site.public_base_url + C.mailBase(cfg) + '/tools/shopify/callback', mailBase: C.mailBase(cfg),
      kb: { search: (q, k, o) => kbMailSearch(q, k, o), urls: () => kb().urls(), version: () => kb().version(), entryBySlug: (s) => kb().entryBySlug(s), entriesOfType: (t) => kb().entriesOfType(t) },
      answerRules: () => '',
      onReplied: growth ? (ev) => growth.onReplied(ev) : undefined,
      productSearch: host.productSearch, orderLookupQuery: host.orderLookupQuery,
      kbGap: (g) => { try { appendJsonl(gapFile, { at: new Date().toISOString(), tenant: tenantId, question: String(g.question || '').slice(0, 200), reason: 'email_unanswered', channel: 'email', source: 'email', message_id: String(g.message_id || '').slice(0, 80) }); } catch {} },
      brainBox: on('web_research') && kbAdmin && kbAdmin.webResearchFor ? () => kbAdmin.webResearchFor() : () => null,
    }));
    if (mailbox && !mailbox.enabled) log('mailbox_disabled', { reason: mailbox.reason });
  }
  const readApi = on('read_api') && mailbox && mailbox.enabled ? req('src/mailreadapi.js').createMailReadApi({ hash: () => env.MAIL_READ_TOKEN_HASH || null, mailbox: () => mailbox, now }) : null;
  const R = req('src/mailrerunapi.js');
  const rerunApi = on('rerun_api') && mailbox && mailbox.enabled ? R.createMailRerunApi({ hash: () => env.MAIL_RERUN_TOKEN_HASH || null, otherHashes: () => [env.MAIL_READ_TOKEN_HASH, env.KB_API_WRITE_TOKEN_HASH].filter(Boolean), mailbox: () => mailbox, dataDir: ns, now, perEmail: R.envInt(hostEnv.MAIL_RERUN_PER_EMAIL_PER_HOUR, 5), dailyCap: R.envInt(hostEnv.MAIL_RERUN_PER_DAY, 50) }) : null;

  // Owner KB API (same behaviour as rfsafe.app's /admin/kb/entries).
  const KB_API_RE = /^\/admin\/kb\/entries(?:\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/(undo|disable))?)?$/;
  const kbRate = new Map();
  async function kbApiRoute(rq, res, pathname) {
    const m = pathname.match(KB_API_RE); if (!m) return false;
    const hash = env.KB_API_WRITE_TOKEN_HASH;
    if (!hash || !kbApi.authorized(rq.headers.authorization, hash)) { json(res, 401, { error: 'unauthorized' }); return true; }
    const ip = String(rq.headers['x-forwarded-for'] || '').split(',')[0].trim() || (rq.socket && rq.socket.remoteAddress) || 'local';
    if (!kbApi.rateLimit(kbRate, ip, { now: +now() })) { json(res, 429, { error: 'too_many_requests' }); return true; }
    const slug = m[1] || ''; const sub = m[2] || '';
    const before = (s) => { try { return kbAdmin && kbApi.validateSlug(s) ? kbAdmin.liveLookup(tenantId, s) : null; } catch { return null; } };
    const reload = () => { try { if (publicKb && publicKb.reset) publicKb.reset(); } catch {} kbReset(); };
    const body = async () => { const ct = String(rq.headers['content-type'] || ''); if (ct && !/application\/json/i.test(ct)) { const e = new Error('json_only'); e.status = 415; throw e; } try { return JSON.parse(await readBody(rq, kbApi.MAX_JSON)); } catch (e) { if (e.status) throw e; const x = new Error('invalid_json'); x.status = 400; throw x; } };
    try {
      if (rq.method === 'GET' && !slug) { json(res, 200, { tenant: tenantId, entries: kbApiStore.list(tenantId) }); return true; }
      if (rq.method === 'GET' && slug && !sub) { const e = kbApiStore.get(tenantId, slug); if (!e) { json(res, 404, { error: 'not_found' }); return true; } json(res, 200, { tenant: tenantId, entry: e, backups: kbApiStore.backups(tenantId, slug) }); return true; }
      if ((rq.method === 'POST' && !slug) || (rq.method === 'PUT' && slug && !sub)) {
        const b = await body(); const pre = before(String((b && (b.slug || b.id)) || slug || '').trim());
        const r = kbApiStore.put(tenantId, b, slug || undefined); if (!r.ok) { json(res, r.status || 400, { error: r.error, detail: r.detail || undefined }); return true; }
        if (kbAdmin) kbAdmin.recordOwnerApi(tenantId, r.entry.slug, r.entry, r.action, pre); reload();
        log('kb_api_' + r.action, { tenant: tenantId, slug: r.entry.slug, text_hash: kbApi.textHash(r.entry.text) });
        json(res, r.action === 'add' ? 201 : 200, { tenant: tenantId, action: r.action, entry: r.entry }); return true;
      }
      if (rq.method === 'POST' && slug && (sub === 'undo' || sub === 'disable')) {
        let b = {}; if (sub === 'undo' && String(rq.headers['content-length'] || '') !== '0' && rq.headers['content-type']) b = await body();
        const pre = before(slug); const r = sub === 'undo' ? kbApiStore.undo(tenantId, slug, b && b.backup) : kbApiStore.disable(tenantId, slug);
        if (!r.ok) { json(res, r.status || 400, { error: r.error, detail: r.detail || undefined }); return true; }
        if (kbAdmin && r.entry) kbAdmin.recordOwnerApi(tenantId, slug, r.entry, sub, pre); reload();
        log('kb_api_' + sub, { tenant: tenantId, slug });
        json(res, 200, { tenant: tenantId, action: sub, entry: r.entry, ...(r.restored_from ? { restored_from: r.restored_from } : {}) }); return true;
      }
      json(res, 405, { error: 'method_not_allowed' }); return true;
    } catch (e) { if (e.status) { json(res, e.status, { error: e.message }); return true; } log('kb_api_error', { err: String(e.message || e).slice(0, 200) }); if (!res.headersSent) json(res, 500, { error: 'internal_error' }); return true; }
  }

  const KB_ASSET = /^\/kb\/assets\/(kb\.css|kb\.js)$/;
  const MB = C.mailBase(cfg); // owner inbox path (mail.base)
  async function route(rq, res, u) {
    const p = u.pathname;
    if (rerunApi && rerunApi.isPath(p)) { await rerunApi.route(rq, res, u); return true; }
    if (readApi && readApi.isPath(p)) { await readApi.route(rq, res, u); return true; }
    if (growth && p === '/admin/mail/kb-coverage' && rq.method === 'GET') {
      // Same read key as /admin/mail/messages. Counts and titles only, never email text or addresses.
      if (!env.MAIL_READ_TOKEN_HASH || !kbApi.authorized(rq.headers.authorization, env.MAIL_READ_TOKEN_HASH)) { json(res, 401, { error: 'unauthorized' }); return true; }
      json(res, 200, { coverage: growth.coverage(), recent: growth.recent(50), seed_import: seedImport }); return true;
    }
    if (kbApiStore && KB_API_RE.test(p)) return kbApiRoute(rq, res, p);
    if (kbAdmin && kbAdmin.isAgentPath && kbAdmin.isAgentPath(p)) { await kbAdmin.agentRoute(rq, res, u); return true; }
    if (publicKb && KB_ASSET.test(p) && rq.method === 'GET') { const f = path.join(ROOT, 'site', 'kb', 'assets', p.match(KB_ASSET)[1]); if (!fs.existsSync(f)) return false; res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' }); res.end(fs.readFileSync(f)); return true; }
    if (publicKb && publicKb.isKbPath && publicKb.isKbPath(p)) { if (await publicKb.route(rq, res, u)) return true; return false; }
    if (mailbox && p === '/api/mail/webhook/resend' && rq.method === 'POST') { if (!mailbox.enabled) { json(res, 401, { error: 'bad_signature' }); return true; } await mailbox.webhookRoute(rq, res); return true; }
    if (mailbox && p === MB + '/tools/shopify/callback' && rq.method === 'GET') { if (!mailbox.enabled) { json(res, 503, { error: 'mailbox_not_configured' }); return true; } await mailbox.shopifyCallback(rq, res, u); return true; }
    if (mail && (p === MB || p.startsWith(MB + '/'))) { await mail.route(rq, res, u); return true; }
    if (mailbox && (p === '/api/mail' || p.startsWith('/api/mail/'))) { if (mailbox.enabled) { await mailbox.botRoute(rq, res, u); return true; } json(res, 503, { error: 'mailbox_not_configured' }); return true; }
    return false;
  }
  const modules = require('./lib/modules').IDS.filter(on);
  log('mounted', { site: cfg.site.id, modules, namespace: cfg.data.namespace });
  return {
    enabled: true, modules, failed, route, kbAdmin, publicKb, mailbox, mail,
    kbSearch: (q, k) => kb().search(q, k), // read-only: the same combined KB the Mailbox writer and checker search
    // Phone/SMS hook (KB Light first): answerFor(hostTenantId, question, 'voice'|'sms', hostKb) returns a KB#answer-shaped
    // result with kb_layer 'light' or 'full', or null when that channel is off or the tenant is not listed (the host then
    // answers exactly as before). hostKb is the host's own phone KB (KB Full for the phone line), used read-only.
    kbLightFirst: { answerFor: (t, q, ch, full) => LF.answerFor(t, q, ch, full), mailSearch: (q, k, o) => kbMailSearch(q, k, o), status: () => LF.status() },
    status: () => ({ enabled: true, site: cfg.site.id, modules, ...(seedImport ? { seed_import: { imported: seedImport.imported, kept_existing: seedImport.kept_existing, ran: seedImport.ran } } : {}), ...(growth ? { brain_box_coverage: (() => { try { const c = growth.coverage(); return { questions: c.questions, share: c.share }; } catch { return null; } })() } : {}), host_kb: (() => { try { return hostKbFingerprint(); } catch { return null; } })(), kb_light_first: (() => { try { return LF.status(); } catch { return null; } })(), ...(Object.keys(failed).length ? { failed: Object.keys(failed) } : {}), ...(mailbox && mailbox.enabled ? { mailbox: mailbox.status() } : {}) }),
    close: () => { try { if (kbAdmin && kbAdmin.closeStreams) kbAdmin.closeStreams(); } catch {} try { if (mailbox && mailbox.close) mailbox.close(); } catch {} },
  };
}
module.exports = { mountSiteMail };
