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
  const kbReset = () => { kbCache = null; };

  const custom = (id, ctx) => { const m = cfg.modules[id]; if (!(m && typeof m === 'object' && m.factory)) return null; const f = require(path.resolve(host.rootDir || process.cwd(), m.factory)); return (f.create || f)(ctx); };
  const ctx = { cfg, env, log, now, ns, tenant, kb, kbReset, B };
  // One module failing to start (e.g. a missing secret) turns only that module off; the rest keep working.
  const failed = {};
  const safe = (id, fn) => { try { return fn(); } catch (e) { failed[id] = String(e && e.message || e).slice(0, 200); log('module_failed', { module: id, err: failed[id] }); return null; } };

  // Brain box: owner KB API store (write key) -> admin (editor/agents) -> public /kb.
  const kbApi = req('src/kbapi.js');
  const kbApiStore = on('brainbox_api') ? kbApi.open({ dataDir: ns, now }) : null;
  let publicKb = null;
  const kbAdmin = on('brainbox_admin') && kbApiStore ? safe('brainbox_admin', () => custom('brainbox_admin', ctx) || req('src/kbadmin/index.js').createKbAdmin({ dataDir: ns, kbApiStore, tenant: () => tenant, kbReset: () => kbReset(), publicReset: () => publicKb && publicKb.reset && publicKb.reset(), catalog: () => req('src/kbcontrol.js').catalog({ tenant, tenantsDir: host.rootDir || null, dataDir: ns, apiStore: kbApiStore }), gapFile, log, now, webResearchSeed: null })) : null;
  publicKb = on('public_kb') && kbApiStore ? safe('public_kb', () => custom('public_kb', ctx) || req('src/publickb/index.js').createPublicKb({ kbApiStore, tenantId: () => tenantId, visibility: (tid) => (kbAdmin && kbAdmin.store ? kbAdmin.store.visibility(tid) : {}), siteDir: path.join(ROOT, 'site'), dataDir: ns, now, baseUrl: () => cfg.site.public_base_url, log })) : null;

  // Owner sign-in email: the host's sender when given, else Resend with this site's key and From.
  const sendEmail = host.sendEmail || (async (m) => {
    if (!env.RESEND_MAIL_READ_KEY) return { ok: false, error: 'mail_not_configured' };
    const r = await fetchImpl('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + env.RESEND_MAIL_READ_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ from: B.from, to: [m.to], subject: m.subject, text: m.text, html: m.html }) });
    return { ok: r.ok };
  });

  // Mail: the /mail inbox and the Mailbox bots (sorter, writer, checker, auto-send gate, order lookup, web research).
  let mailbox = null;
  const mail = on('mail_viewer') ? safe('mail_viewer', () => custom('mail_viewer', ctx) || req('src/mail/index.js').createMail({ base: C.mailBase(cfg), env, mailbox: () => mailbox, kbAdmin: () => kbAdmin, siteName: B.name, log, publicBaseUrl: () => cfg.site.public_base_url, sendEmail, fetchImpl })) : null;
  if (on('mailbox') && mail) {
    mailbox = safe('mailbox', () => custom('mailbox', ctx) || req('src/mailbox/index.js').createMailbox({
      env, client: mail.client, siteName: B.name, fromAddress: B.from, log, now: host.mailNow, publicBaseUrl: () => cfg.site.public_base_url,
      file: path.join(ns, 'mailbox', 'mailbox.json'), fetchImpl, checker: host.mailChecker, bootReprocessWait: host.mailBootWait,
      shopifyCallbackUrl: cfg.site.public_base_url + C.mailBase(cfg) + '/tools/shopify/callback', mailBase: C.mailBase(cfg),
      kb: { search: (q, k, o) => kb().search(q, k, o), urls: () => kb().urls(), version: () => kb().version(), entryBySlug: (s) => kb().entryBySlug(s), entriesOfType: (t) => kb().entriesOfType(t) },
      answerRules: () => '',
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
    status: () => ({ enabled: true, site: cfg.site.id, modules, host_kb: (() => { try { return hostKbFingerprint(); } catch { return null; } })(), ...(Object.keys(failed).length ? { failed: Object.keys(failed) } : {}), ...(mailbox && mailbox.enabled ? { mailbox: mailbox.status() } : {}) }),
    close: () => { try { if (kbAdmin && kbAdmin.closeStreams) kbAdmin.closeStreams(); } catch {} try { if (mailbox && mailbox.close) mailbox.close(); } catch {} },
  };
}
module.exports = { mountSiteMail };
