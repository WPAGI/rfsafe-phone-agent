'use strict';
// Site Mailbox v2: folders, undoable moves, drafts with a confirmed Send, Sent copies, bot keys and a bot API, and an
// auto-send checker path that ships OFF. Mounted by src/mail (owner page, /mail/api/v2/*) and src/app.js (/api/mail/*).
// Mail is never deleted at Resend; Trash only hides. MAIL_DOMAINS is enforced by the reader for every message.
const crypto = require('crypto');
const { Sealer } = require('./crypto');
const { MailboxStore, FOLDERS, MOVABLE } = require('./store');
const { BotKeys, SCOPES } = require('./keys');
const { SentMail } = require('./sent');
const P = require('./policy');
const { GUIDE } = require('./guide');
const { Attachments } = require('./attachments');
const { MailTools } = require('./tools');
const { MailBots, dateParts } = require('./bots');
const { WebResearch } = require('./webresearch');
const pkg = require('../botpkg');
const { verify: verifyWebhook } = require('../mail-forward');
const { htmlToText } = require('../mail'); const { renderEmail } = require('./footer'); const { repliesFor, draftFor } = require('./replies');
const { addrDomain } = require('../mail/client');
const { documentHtml } = require('../mail/sanitizer');
const HEADERS = { 'cache-control': 'no-store, max-age=0', pragma: 'no-cache', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" };
const FRAME_CSP = (img) => `default-src 'none'; style-src 'unsafe-inline'; img-src ${img ? 'https: data:' : "'none'"}; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-popups allow-popups-to-escape-sandbox`;
const BOT_FOLDERS = ['inbox', 'spam', 'archive', 'trash'];
const readBody = (req, max = 65536) => new Promise((resolve, reject) => { let s = ''; req.on('data', c => { s += c; if (s.length > max) { reject(Object.assign(new Error('too_large'), { status: 413 })); req.destroy(); } }); req.on('end', () => resolve(s)); req.on('error', reject); });
async function jsonBody(req) { const s = await readBody(req); if (!s) return {}; try { const o = JSON.parse(s); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { throw Object.assign(new Error('bad_json'), { status: 400 }); } }
const addrOf = (x) => { const m = String(x || '').match(/([^<>\s@]+@[^<>\s@]+?)>?\s*$/); return m ? m[1].toLowerCase() : ''; };
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const ID_RE = /^(?:r\.[A-Za-z0-9-]{8,80}|i(?:\.[A-Za-z0-9-]{8,80}){3})$/;

function createMailbox(o = {}) {
  const env = o.env || process.env; const now = o.now || (() => Date.now()); const log = o.log || (() => {});
  const client = o.client; const allowed = client ? client.allowed : new Set();
  const siteName = o.siteName || 'Site'; const primary = [...allowed][0] || '';
  const fromAddress = o.fromAddress && allowed.has(addrDomain(o.fromAddress)) ? o.fromAddress : (primary ? `${siteName} <info@${primary}>` : '');
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  let sealer = null; let reason = null;
  try { sealer = new Sealer(env.MAILBOX_ENC_KEY); } catch { reason = 'MAILBOX_ENC_KEY missing or invalid'; }
  if (!reason && !primary) reason = 'MAIL_DOMAINS is empty';
  if (!reason && !o.file) reason = 'no data directory';
  if (reason) return { enabled: false, reason, ownerRoute: null, botRoute: null };
  const store = new MailboxStore({ file: o.file, sealer, now });
  const keys = new BotKeys({ store, site: primary, now, perMinute: o.perMinute || 30, perDay: o.perDay || 2000 });
  const sentMail = new SentMail({ key: env.RESEND_MAIL_READ_KEY, allowed, fetchImpl, now });
  const checker = o.checker || new P.XaiChecker({ apiKey: env.XAI_API_KEY, model: env.XAI_TEXT_MODEL || 'grok-4.7', fetchImpl });
  const sendKey = env.RESEND_MAIL_READ_KEY;
  const att = new Attachments({ key: env.RESEND_MAIL_READ_KEY, fetchImpl, htmlToText, client, maxBytes: o.attachmentMaxBytes, pdfPages: o.pdfPages });
  let listCache = null;
  const tools = new MailTools({ store, env, fetchImpl, now, kb: o.kb, shopifyOAuth: o.shopifyOAuth, callbackUrl: o.shopifyCallbackUrl });
  // Web research fallback: reads its switch, limits and RF Safe perspective live from the Brain box (o.brainBox), reports
  // review items back there, and spends from the same XAI_API_KEY and monthly cap as the other Mailbox bots. Off by default.
  const brain = () => { try { return typeof o.brainBox === 'function' ? o.brainBox() : (o.brainBox || null); } catch { return null; } };
  const webResearch = new WebResearch({ apiKey: env.XAI_API_KEY, fetchImpl, now, store,
    brain: { config: () => { const b = brain(); return b ? b.config() : null; }, logItem: (x) => { const b = brain(); return b ? b.logItem(x) : null; }, updateItem: (id, x) => { const b = brain(); return b ? b.updateItem(id, x) : null; } },
    canSpend: (usd) => { const u = bots.usage(); return !u.paused && u.cost + usd <= u.cap; },
    prices: (m) => bots.models.price(m),
    onUsage: (u) => { bots.db.usage.push({ day: dateParts(now()), bot: 'web_research', model: u.model, input: u.input, output: u.output, cost: u.cost, estimated: u.cost_source !== 'provider', cost_source: u.cost_source }); store.save(); } });
  const bots = new MailBots({ store, env, fetchImpl, now, tools, received: () => received(true), original, createDraft: createBotDraft, autoSend: (d, g) => runAutoSend(d, g), ownDomains: [...allowed], answerRules: o.answerRules, sarLookup: o.sarLookup || null, newsletterMember: o.newsletterMember || null, newsletterJoinUrl: o.newsletterJoinUrl || null, siteName: o.siteName, productSearch: o.productSearch, hostOrderQuery: o.orderLookupQuery || o.hostOrderQuery || null, kbGap: o.kbGap || null, webResearch });
  if (typeof o.onReplied === 'function') bots.onReplied = o.onReplied; // optional observer (port/mount.js kb growth loop)
  if (o.mailBase) bots.mailBase = o.mailBase; // owner inbox path (portable package mail.base; rfsafe.app: /mail)
  // A boot-applied reprocess must not run during the restart itself (the site's own data, e.g. the SAR catalog, is
  // briefly unreachable). Wait at least minMs, then until the public /health answers OK `need` times in a row
  // (everyMs apart), or maxMs at most.
  const bootWait = { minMs: 20000, everyMs: 5000, maxMs: 180000, need: 2, ...(o.bootReprocessWait || {}) };
  function bootReprocess(rid, why) {
    const t0 = Date.now(); let ok = 0; let checks = 0;
    const tick = async () => {
      let healthy = false; checks++;
      try { const base = typeof o.publicBaseUrl === 'function' ? o.publicBaseUrl() : o.publicBaseUrl; if (base) { const r = await fetchImpl(String(base).replace(/\/$/, '') + '/health', { signal: AbortSignal.timeout(5000) }); healthy = !!(r && r.ok); } } catch { healthy = false; }
      ok = healthy ? ok + 1 : 0;
      const timedOut = Date.now() - t0 >= bootWait.maxMs;
      if (ok >= bootWait.need || timedOut) { for (const one of [].concat(rid)) { log('mailbox.bootstrap_reprocess', { id: one, healthy: ok >= bootWait.need, checks, waited_ms: Date.now() - t0 }); try { bots.reprocess(one, why); } catch { /* recorded on the timeline */ } } return; }
      setTimeout(tick, bootWait.everyMs).unref?.();
    };
    setTimeout(tick, bootWait.minMs).unref?.();
  }
  // Retry auto-send on existing unsent drafts after a boot wait, without writing a new reply. Used when the daily cap
  // is raised so a checker-passed draft held only by that cap can go out. Already-sent mail is left alone.
  function unsentBotDraft(mid) {
    return store.drafts().filter(d => d.reply_to_id === mid && String(d.author || '').startsWith('bot:')).sort((a, b) => String(b.updated).localeCompare(String(a.updated)))[0] || null;
  }
  function lastAutoHold(mid, d) {
    const tl = bots.timeline(mid).filter(x => x.step === 'auto_send');
    const last = tl[tl.length - 1];
    if (last && last.status === 'held') return last.code || (/\bdaily cap\b/i.test(last.reason || '') ? 'daily_cap' : last.reason);
    const hn = [...(d.notes || [])].reverse().find(n => n.hold);
    return hn ? hn.reason : null;
  }
  function givenCheckerPass(mid, d) {
    const pool = [...(d.notes || []), ...(bots.notes(mid) || [])];
    const last = [...pool].reverse().find(n => n.verdict === 'pass' || n.reason === 'checker_pass');
    return last ? { verdict: 'pass', notes: String(last.notes || '') } : null;
  }
  async function releaseHeld(mid, why) {
    if (bots.sentFor(mid)) { log('mailbox.bootstrap_autosend', { id: mid, skipped: 'already_sent' }); bots.step(mid, 'auto_send', 'skipped', 'Already has a reply; not sent twice (' + why + ')'); return { id: mid, skipped: 'already_sent' }; }
    const d = unsentBotDraft(mid);
    if (!d) { log('mailbox.bootstrap_autosend', { id: mid, skipped: 'no_draft' }); return { id: mid, skipped: 'no_draft' }; }
    const hold = lastAutoHold(mid, d);
    if (hold !== 'daily_cap') { log('mailbox.bootstrap_autosend', { id: mid, skipped: 'not_daily_cap', hold }); bots.step(mid, 'auto_send', 'skipped', 'Not released: hold was ' + (hold || 'unknown') + ', not the daily cap alone (' + why + ')'); return { id: mid, skipped: 'not_daily_cap', hold }; }
    const given = givenCheckerPass(mid, d);
    if (!given) { log('mailbox.bootstrap_autosend', { id: mid, skipped: 'checker_not_pass' }); bots.step(mid, 'auto_send', 'skipped', 'Not released: no checker pass on the existing draft (' + why + ')'); return { id: mid, skipped: 'checker_not_pass' }; }
    bots.step(mid, 'auto_send', 'requested', 'Retry auto-send of the existing passed draft, after the daily cap was raised (' + why + ')');
    const a = await runAutoSend(d, given);
    if (a.auto) bots.step(mid, 'auto_send', 'sent', 'Sent the existing passed draft (' + why + ')');
    else bots.step(mid, 'auto_send', 'held', 'Still held: ' + String(a.reason || 'unknown').replace(/_/g, ' ') + ' (' + why + ')', { code: a.reason || null });
    log('mailbox.bootstrap_autosend', { id: mid, auto: !!a.auto, reason: a.reason || null });
    return { id: mid, auto: !!a.auto, reason: a.reason || null, resend_id: a.resend_id || null, sent_id: a.sent_id || null };
  }
  function bootAutosend(ids, why) {
    const t0 = Date.now(); let ok = 0; let checks = 0;
    const tick = async () => {
      let healthy = false; checks++;
      try { const base = typeof o.publicBaseUrl === 'function' ? o.publicBaseUrl() : o.publicBaseUrl; if (base) { const r = await fetchImpl(String(base).replace(/\/$/, '') + '/health', { signal: AbortSignal.timeout(5000) }); healthy = !!(r && r.ok); } } catch { healthy = false; }
      ok = healthy ? ok + 1 : 0;
      const timedOut = Date.now() - t0 >= bootWait.maxMs;
      if (ok >= bootWait.need || timedOut) {
        log('mailbox.bootstrap_autosend', { ids, healthy: ok >= bootWait.need, checks, waited_ms: Date.now() - t0 });
        for (const mid of ids) { try { await releaseHeld(mid, why); } catch (e) { log('mailbox.bootstrap_autosend', { id: mid, error: e.message }); } }
        return;
      }
      setTimeout(tick, bootWait.everyMs).unref?.();
    };
    setTimeout(tick, bootWait.minMs).unref?.();
  }
  // One-time owner bootstrap (MAILBOX_OWNER_BOOTSTRAP JSON). Applied at boot at most once per store, ever: after any
  // bootstrap has been recorded, later values (or the same one) are ignored, so it can never re-enable a switch the
  // owner turned off. It can only turn bots/auto-send ON and use the existing store connection. The monthly spend cap
  // and the kill switch are never changed. daily_cap is changed only when a new audited bootstrap explicitly sets it
  // (an integer 0-200). autosend retries auto-send on existing unsent drafts for the given message ids (no new reply).
  // It refuses while the kill switch is on. Empty/missing is a no-op.
  function applyBootstrap(raw) {
    const t = String(raw || '').trim(); if (!t) return { applied: false, reason: 'empty' };
    let b; try { b = JSON.parse(t); } catch { log('mailbox.bootstrap_rejected', { reason: 'bad_json' }); return { applied: false, reason: 'bad_json' }; }
    const id = String(b && b.id || ''); if (!/^[A-Za-z0-9_.:-]{6,80}$/.test(id)) { log('mailbox.bootstrap_rejected', { reason: 'bad_id' }); return { applied: false, reason: 'bad_id' }; }
    store.db.audit ||= [];
    // Each bootstrap id is applied at most once, ever. A later owner change is never undone by the same id; only a new,
    // separately audited owner request (new id) can switch something on again.
    store.db.bootstraps ||= store.db.bootstrap ? [store.db.bootstrap.id] : [];
    if (store.db.bootstraps.includes(id)) { log('mailbox.bootstrap_ignored', { id }); return { applied: false, reason: 'already_applied' }; }
    const note = String(b.note || "enabled at owner's request").slice(0, 160); const who = 'bootstrap: ' + note; const done = [];
    const record = (status, extra = {}) => { store.db.bootstraps.push(id); store.db.bootstrap = { id, at: store.iso(), note, status, done, ...extra }; store.db.audit.push({ at: store.iso(), who, action: 'bootstrap', id, status, done }); store.save(); log('mailbox.bootstrap', { id, status, done }); };
    if (store.settings().kill_switch) { record('refused_kill_switch'); return { applied: false, reason: 'kill_switch' }; }
    const errors = [];
    for (const [botId, on] of Object.entries(b.bots || {})) { if (on !== true) continue; try { bots.toggle(botId, true); done.push('bot:' + botId); } catch (e) { errors.push('bot:' + botId + ':' + e.message); } }
    if (b.shopify === 'existing') { try { tools.connect('shopify', { method: 'existing', confirm: 'CONNECT' }); done.push('shopify:existing'); } catch (e) { errors.push('shopify:' + e.message); } }
    // One id, or a short list of up to 10 ids the owner approved together (5 until John's 7:30 PM ET backlog of 7) (John, Nov 15, 7:04 PM ET). Every id must be
    // valid or none runs; each is rerun once, after the same boot wait, through the normal writer, checker and gate.
    if (typeof b.reprocess === 'string' && b.reprocess) { if (!ID_RE.test(b.reprocess)) errors.push('reprocess:bad_id'); else { done.push('reprocess'); bootReprocess(b.reprocess, 'bootstrap ' + id); } }
    else if (Array.isArray(b.reprocess) && b.reprocess.length) { const ids = [...new Set(b.reprocess)]; if (ids.length > 10 || !ids.every(x => typeof x === 'string' && ID_RE.test(x))) errors.push('reprocess:bad_id'); else { done.push('reprocess'); bootReprocess(ids, 'bootstrap ' + id); } }
    if ('daily_cap' in b) { const n = Number(b.daily_cap); if (!Number.isInteger(n) || n < 0 || n > 200) errors.push('daily_cap:range'); else { store.setSettings({ daily_cap: n }, who); done.push('daily_cap'); } }
    const autoIds = [].concat(b.autosend == null ? [] : b.autosend).filter(x => typeof x === 'string' && x);
    if (autoIds.length) { const bad = autoIds.filter(x => !ID_RE.test(x)); if (bad.length) errors.push('autosend:bad_id'); const okIds = autoIds.filter(x => ID_RE.test(x)); if (okIds.length) { done.push('autosend'); bootAutosend(okIds, 'bootstrap ' + id); } }
    if ((typeof b.resolve_kb_gaps === 'string' && b.resolve_kb_gaps) || Array.isArray(b.resolve_kb_gaps)) { try { const seenG = new Set(); const r = typeof o.resolveGaps === 'function' ? [].concat(b.resolve_kb_gaps).filter(x => typeof x === 'string' && x).flatMap(n => o.resolveGaps(n, who)).filter(x => !seenG.has(x.id) && seenG.add(x.id)) : []; done.push('kb_gaps_resolved:' + r.filter(x => x.ok).map(x => x.id).join(',')); log('mailbox.kb_gaps_resolved', { ids: r.filter(x => x.ok).map(x => x.id) }); } catch (e) { errors.push('resolve_kb_gaps:' + e.message); } }
    if (b.auto_send === true) { if (!checker.available) errors.push('auto_send:checker_unavailable'); else { store.setSettings({ auto_send: true }, who); done.push('auto_send'); } }
    record(errors.length ? 'partial' : 'applied', { errors }); return { applied: true, done, errors };
  }
  const bootstrap = applyBootstrap(env.MAILBOX_OWNER_BOOTSTRAP);
  function status() { const s = store.settings(); const bl = bots.list(); return { bots_on: bl.bots.filter(x => x.enabled).map(x => x.id), auto_sent_today: store.autoSentToday(), auto_send: !!s.auto_send && !s.kill_switch, kill_switch: !!s.kill_switch, daily_cap: s.daily_cap, monthly_cap_usd: bl.usage.cap, month_cost_usd: Math.round(bl.usage.cost * 100) / 100, paused: bl.usage.paused, shopify: tools.state().shopify.connected ? tools.state().shopify.via : 'off', kb: !!tools.state().kb, webhook_secret_set: !!env.MAILBOX_RESEND_WEBHOOK_SECRET, bootstrap: store.db.bootstrap ? { id: store.db.bootstrap.id, status: store.db.bootstrap.status, at: store.db.bootstrap.at } : null }; }
  // No timer work/reads/provider requests while all bots are OFF. Timer is unref'd and may be stopped in tests.
  const timer = o.noSchedule ? null : setInterval(() => { if (bots.anyOn()) void bots.wake('schedule'); }, 60000);
  if (timer) timer.unref();
  async function webhookRoute(req, res) {
    let body; try { body = await readBody(req, 128 * 1024); } catch { return json(res, 413, { error: 'too_large' }); }
    const h = req.headers;
    if (!verifyWebhook(env.MAILBOX_RESEND_WEBHOOK_SECRET, h['svix-id'], h['svix-timestamp'], h['svix-signature'], body, Math.floor(now() / 1000))) return json(res, 401, { error: 'bad_signature' });
    let ev; try { ev = JSON.parse(body); } catch { return json(res, 400, { error: 'bad_json' }); }
    if (!['email.received', 'inbox.email.received'].includes(ev.type)) return json(res, 200, { ok: true, action: 'ignored' });
    const eventId = String(h['svix-id'] || '').slice(0, 100);
    if (bots.db.events.includes(eventId)) return json(res, 200, { ok: true, action: 'duplicate' });
    // Enforce site domain from event metadata before waking; full reads still enforce MAIL_DOMAINS.
    const to = [].concat(ev.data?.to || []); if (!to.some(x => allowed.has(addrDomain(x)))) return json(res, 200, { ok: true, action: 'not_our_domain' });
    bots.db.events.push(eventId); bots.db.events = bots.db.events.slice(-2000);
    const action = bots.anyOn() ? 'wake' : 'all_bots_off';
    store.logCall({ key: null, bot: 'webhook', method: 'POST', path: '/api/mail/webhook/resend', status: 200, action });
    // Acknowledge delivery quickly. With bots OFF this only logs (no mail/provider calls).
    // Queue the exact message from the event, so it is processed even if the provider's list lags behind the webhook.
    if (action === 'wake') {
      const d = ev.data || {}; const eid = String(d.email_id || d.id || '');
      const mid = /^[ri]\./.test(eid) ? eid : d.inbox_id && d.thread_id && eid ? 'i.' + d.inbox_id + '.' + d.thread_id + '.' + eid : (eid ? 'r.' + eid : '');
      if (mid && ID_RE.test(mid)) bots.enqueue(mid);
      log('mailbox.pipeline', { event: 'webhook_wake', queued: !!mid });
      bots.pending = Promise.resolve().then(() => bots.wake('webhook')).then(r => { if (r && r.ok === false) log('mailbox.pipeline', { event: 'wake_error', error: r.error }); }).catch(() => {});
    }
    return json(res, 200, { ok: true, action });
  }
  async function shopifyCallback(req, res, u) {
    try { await tools.callback(u.searchParams); res.writeHead(303, { ...HEADERS, location: (o.mailBase || '/mail') + '#tools' }); res.end(); return true; }
    catch (e) { return json(res, e.status || 502, { error: e.status ? e.message : 'shopify_connect_failed' }); }
  }


  function out(res, code, body, type, extra = {}) { res.writeHead(code, { ...HEADERS, 'content-type': type || 'application/json; charset=utf-8', ...extra }); res.end(body); return true; }
  const json = (res, code, obj) => out(res, code, JSON.stringify(obj));

  async function received(force) {
    if (!force && listCache && now() - listCache.at < 30000) return listCache.rows;
    const r = await client.list(); if (r.errors.length && !r.messages.length) throw new Error('mail_unavailable');
    listCache = { at: now(), rows: r.messages }; return r.messages;
  }
  // Full message, from the sealed copy when we have one. Attachments are listed by name only and never fetched.
  async function original(id) {
    if (!ID_RE.test(id)) return null;
    let c = store.copy(id);
    if (!c || c.copy_version !== 2) {
      const m = await client.get(id); if (!m) return null;
      c = { copy_version: 2, id, from: m.from, to: m.to, subject: m.subject, created_at: m.created_at, message_id: m.message_id || null, text: m.text || htmlToText(m.html), hasHtml: !!m.html, attachments: (m.attachments || []).map(a => ({ id: a.id ? clip(a.id, 80) : null, filename: clip(a.filename, 200), content_type: clip(a.content_type, 100), size: a.size || null })) };
      store.putCopy(id, c);
    }
    return { ...c, ...store.state(id) };
  }
  // Sorting first: promotional mail goes to Spam before any draft can be written. Bounded work per call.
  async function autoSort(rows, max = 10) {
    if (!store.settings().auto_sort_promo) return;
    let n = 0;
    for (const r of rows) {
      if (n >= max) break; const meta = store.db.meta[r.id]; if (meta && (meta.checked || meta.folder)) continue;
      n++; let m; try { m = await original(r.id); } catch { continue; } if (!m) continue;
      if (P.isPromo(m)) store.move(r.id, 'spam', { who: 'auto-sort', why: 'Sales or promotional mail (sorted before drafting)' });
      store.db.meta[r.id] = { ...(store.db.meta[r.id] || {}), checked: true }; store.save();
    }
  }
  async function folderRows(folder, { unread } = {}) {
    if (folder === 'drafts') return store.drafts().map(d => ({ id: d.id, kind: 'draft', from: d.author, to: [d.to], subject: d.subject, created_at: d.updated, status: d.status, reason: d.reason, folder: 'drafts' }));
    if (folder === 'sent') {
      const local = store.sentList().map(s => ({ id: s.id, kind: 'sent', from: s.from, to: [s.to], subject: s.subject, created_at: s.at, approved_by: s.approved_by, folder: 'sent' }));
      let remote = []; try { remote = (await sentMail.list()).map(s => ({ ...s, kind: 'site_sent', folder: 'sent' })); } catch { remote = []; }
      const ids = new Set(local.map(s => s.resend_id).filter(Boolean));
      return [...local, ...remote.filter(r => !ids.has(r.id.slice(2)))].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    }
    const rows = await received(); await autoSort(rows); const sentAll = store.sentList();
    const replied = (id) => { const x = repliesFor(id, sentAll, bots.timeline(id)); return x ? { count: x.count, last_at: x.latest.at, label: x.latest.label } : null; };
    // Draft badge (John, Nov 15, 10:43 PM ET): the latest unsent draft when no reply went out; display only.
    const draftOf = (id, rep, folder) => { if (rep) return null; const d = draftFor(id, store.db.drafts, { replies: rep, folder, timeline: bots.timeline(id) }); return d && { id: d.id, status: d.status, label: d.label, reason: d.reason }; };
    return rows.map(r => { const st = store.state(r.id); const rep = replied(r.id); return { id: r.id, kind: 'mail', from: r.from, to: r.to, subject: r.subject, created_at: r.created_at, ...st, replied: rep, draft: draftOf(r.id, rep, st.folder), kb_gap: (bots.db.kb_gaps || {})[r.id] || null }; })
      .filter(r => r.folder === folder && (!unread || !r.read));
  }

  // ---------- sending (owner, or auto-send after every rule and the checker pass) ----------
  async function deliver(d, { approved_by, grade, via }) {
    if (!sendKey) return { ok: false, reason: 'mail_not_configured' };
    const to = addrOf(d.to); if (!to || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(to)) return { ok: false, reason: 'bad_recipient' };
    let headers; if (d.reply_to_id) { const orig = store.copy(d.reply_to_id); if (orig && orig.message_id) headers = { 'In-Reply-To': orig.message_id, References: orig.message_id }; }
    const r = await fetchImpl('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + sendKey, 'content-type': 'application/json', 'idempotency-key': 'mbx-' + d.id }, body: JSON.stringify({ from: fromAddress, to: [to], subject: d.subject, ...(() => { const m = renderEmail(d.body, d.footer); return m.html ? { text: m.text, html: m.html } : { text: m.text }; })(), ...(headers ? { headers } : {}) }), signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { ok: false, reason: 'provider_' + r.status };
    const j = await r.json().catch(() => ({}));
    const s = store.addSent({ to, from: fromAddress, subject: d.subject, body: renderEmail(d.body, d.footer).text, approved_by, grade, resend_id: j.id || null, reply_to_id: d.reply_to_id, via });
    store.updateDraft(d.id, { sent_id: s.id }, 'sent'); log('mailbox.sent', { via, approved_by: approved_by === 'owner' ? 'owner' : 'checker' });
    return { ok: true, sent: s };
  }
  async function runAutoSend(d, given = null) {
    const live = (x) => { const c = x && store.draft(x.id); return !!c && c.status !== 'discarded' && c.status !== 'sent'; };
    if (!live(d)) return { auto: false, reason: 'draft_discarded' };
    const settings = store.settings(); if (bots.usage().paused) return { auto: false, reason: 'monthly_cap' }; let orig = null;
    try { orig = d.reply_to_id ? await original(d.reply_to_id) : null; } catch { orig = null; }
    // Read live from the KB store at send time (John, Nov 15, 3:55 PM ET); a medical reply without it never goes out.
    let disclaimer = ''; try { disclaimer = P.disclaimerFromEntry(tools.entryBySlug ? tools.entryBySlug(P.DISCLAIMER_SLUG) : null); } catch { disclaimer = ''; }
    const gate = P.autoSendGate({ settings, available: checker.available, original: orig, draft: d, sentToday: store.autoSentToday(), ownDomains: [...allowed], disclaimer, researched: !!d.web_research });
    const note = (x) => store.updateDraft(d.id, { notes: [...(d.notes || []), { at: new Date(now()).toISOString(), ...x }] }, x.hold ? 'held' : undefined);
    if (!gate.ok) { if (gate.reason !== 'auto_send_off') note({ hold: true, reason: gate.reason, detail: gate.detail || null, matches: gate.matches || null }); return { auto: false, reason: gate.reason, detail: gate.detail, matches: gate.matches }; }
    // When the Checker bot already passed this draft its verdict is the grade; otherwise the built-in checker grades it.
    const g = given && given.verdict === 'pass' ? { verdict: 'pass', notes: String(given.notes || '').slice(0, 500), by: 'checker_bot' } : await checker.grade({ original: [orig.subject, orig.text].join('\n\n'), draft: d.subject + '\n\n' + d.body, siteName });
    const s2 = store.settings(); // the switch may have been flipped while grading
    if (s2.kill_switch || !s2.auto_send) { note({ hold: true, reason: 'kill_switch' }); return { auto: false, reason: 'kill_switch' }; }
    if (g.verdict !== 'pass') { note({ hold: true, reason: 'checker_' + g.verdict, notes: g.notes }); return { auto: false, reason: 'checker_' + g.verdict }; }
    if (!live(d)) return { auto: false, reason: 'draft_discarded' }; // discarded by the owner while it was being graded
    const r = await deliver(d, { approved_by: 'checker', grade: g, via: 'auto' });
    if (!r.ok) { note({ hold: true, reason: r.reason }); return { auto: false, reason: r.reason }; }
    store.noteAutoSent(); return { auto: true, sent_id: r.sent.id, resend_id: r.sent.resend_id || null };
  }
  async function createBotDraft(who, b, opts = {}) {
    const id = String(b.reply_to_id || ''); if (!ID_RE.test(id)) return { code: 400, body: { error: 'reply_to_id_required' } };
    const orig = await original(id); if (!orig) return { code: 404, body: { error: 'not_found' } };
    if (orig.folder === 'trash') return { code: 409, body: { error: 'message_in_trash' } };
    if (orig.folder !== 'spam' && P.isPromo(orig)) store.move(id, 'spam', { who: 'auto-sort', why: 'Sales or promotional mail (sorted before drafting)' });
    if (store.state(id).folder === 'spam' || P.isPromo(orig)) return { code: 409, body: { error: 'promotional_mail_no_drafts', detail: 'Sales and promotional mail is sorted to Spam and never drafted.' } };
    const subject = clip(b.subject || ('Re: ' + String(orig.subject || '').replace(/^\s*re:\s*/i, '')), 200).trim(); const body = clip(b.body, 20000).trim(); const why = clip(b.reason, 300).trim();
    if (!body) return { code: 400, body: { error: 'body_required' } }; if (!why) return { code: 400, body: { error: 'reason_required' } };
    const d = store.createDraft({ author: who, reply_to_id: id, to: addrOf(orig.from), subject, body, reason: why });
    const so = { from: orig.from, senderNames: P.stripSignature(orig.text).names }; const esc = [...new Set([...P.escalations([orig.subject, orig.text], store.settings().staff_names, so), ...P.draftEscalations([subject, body], store.settings().staff_names, so)])]; const hb = P.hardBlock(P.ownSubject(subject, orig.subject) + '\n' + body);
    // The bot pipeline sends only after its Checker step (opts.autoSend === false); the bot API keeps the built-in path.
    const auto = opts.autoSend === false ? { auto: false, reason: 'after_checker' } : await runAutoSend(d);
    const fin = store.draft(d.id);
    return { code: 201, body: { ok: true, draft: { id: fin.id, status: fin.status, reply_to_id: id, needs_john: esc, hard_block: hb }, auto_send: auto } };
  }

  // ---------- bot API (/api/mail/*) ----------
  async function botRoute(req, res, u) {
    const p = u.pathname; if (p !== '/api/mail' && !p.startsWith('/api/mail/')) return false;
    if (p === '/api/mail/guide' || p === '/api/mail/guide.md') { if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method_not_allowed' }); return out(res, 200, GUIDE({ site: primary, base: o.publicBaseUrl ? o.publicBaseUrl() : '' }), 'text/markdown; charset=utf-8'); }
    const key = keys.verify(req.headers.authorization); const path = p.replace(/\/(?:r\.[^/]+|i\.[^/]+)/, '/:id').replace(/(\/attachments)\/[^/]+/, '$1/:aid');
    const done = (code, body, action) => { store.logCall({ key: key ? key.id : null, bot: key ? key.name : null, method: req.method, path, status: code, action: action || null }); return json(res, code, body); };
    if (!key) { log('mailbox.bot_unauthorized', {}); return done(401, { error: 'unauthorized', guide: '/api/mail/guide' }); }
    if (!keys.allow(key.id)) return done(429, { error: 'rate_limited', retry_after_seconds: 60 });
    keys.touch(key);
    const need = (s) => key.scopes.includes(s);
    try {
      // Never available to bot keys, whatever the scope.
      if (req.method === 'DELETE' || /\/(?:send|delete|purge|keys?|settings|auto-send|owner)(?:\/|$)/.test(p)) return done(403, { error: 'not_allowed', detail: 'Bot keys cannot send, delete, manage keys or settings.' });
      const toolMatch = p.match(/^\/api\/mail\/tools\/(kb|shopify)\/(search|inventory|order_status|product_link)$/);
      if (toolMatch && req.method === 'POST') {
        if (!need('read')) return done(403, { error: 'missing_scope', scope: 'read' });
        const b = await jsonBody(req);
        // Order contact must be the sender of an actual site message, not arbitrary input from a bot.
        if (toolMatch[2] === 'order_status') { const msg = await original(String(b.message_id || '')); if (!msg) return done(404, { error: 'message_required' }); b.email = addrOf(msg.from); delete b.phone; }
        const result = await tools.action('key:' + key.id, toolMatch[1], toolMatch[2], b);
        if (toolMatch[2] === 'product_link' && b.draft_id) {
          if (!need('draft')) return done(403, { error: 'missing_scope', scope: 'draft' });
          const d = store.draft(String(b.draft_id)); if (!d || d.author !== 'bot:' + key.name || !['draft', 'held'].includes(d.status)) return done(403, { error: 'draft_not_owned' });
          const product = result.products?.[0]; if (product) store.updateDraft(d.id, { body: (d.body + '\n\n' + product.title + ': ' + product.url).slice(0, 20000) });
        }
        return done(200, result, 'tool:' + toolMatch[1] + ':' + toolMatch[2]);
      }
      if (p === '/api/mail/messages' && req.method === 'GET') {
        if (!need('read')) return done(403, { error: 'missing_scope', scope: 'read' });
        const folder = (u.searchParams.get('folder') || 'inbox').toLowerCase(); if (!BOT_FOLDERS.includes(folder)) return done(400, { error: 'bad_folder', folders: BOT_FOLDERS });
        const lim = Math.min(100, Math.max(1, Number(u.searchParams.get('limit')) || 50));
        const rows = (await folderRows(folder, { unread: u.searchParams.get('unread') === '1' })).slice(0, lim).map(r => ({ id: r.id, from: r.from, to: r.to, subject: r.subject, received_at: r.created_at, folder: r.folder, read: r.read }));
        return done(200, { folder, count: rows.length, messages: rows }, 'list');
      }
      let m = p.match(/^\/api\/mail\/messages\/([^/]+)$/);
      if (m && req.method === 'GET') {
        if (!need('read')) return done(403, { error: 'missing_scope', scope: 'read' });
        const msg = ID_RE.test(m[1]) ? await original(m[1]) : null; if (!msg) return done(404, { error: 'not_found' });
        return done(200, { id: msg.id, from: msg.from, to: msg.to, subject: msg.subject, received_at: msg.created_at, folder: msg.folder, read: msg.read, text: String(msg.text || ''), attachments: (msg.attachments || []).map(a => ({ id: a.id || null, filename: a.filename, content_type: a.content_type, size: a.size })), attachments_note: 'Attachments are never opened automatically. Use GET /api/mail/messages/:id/attachments, then /attachments/:aid (download) or /attachments/:aid/text (text).' }, 'read');
      }
      // Attachments: fetched server-side from Resend only when a bot asks; never executed or rendered.
      m = p.match(/^\/api\/mail\/messages\/([^/]+)\/attachments(?:\/([^/]+)(\/text)?)?$/);
      if (m && req.method === 'GET') {
        if (!need('read')) return done(403, { error: 'missing_scope', scope: 'read' });
        const msg = ID_RE.test(m[1]) ? await original(m[1]) : null; if (!msg) return done(404, { error: 'not_found' });
        if (!m[2]) { const list = (await att.list(msg.id.startsWith('i.') ? await client.get(msg.id) : msg)).map(Attachments.public); return done(200, { id: msg.id, count: list.length, attachments: list, max_bytes: att.maxBytes }, 'attachments'); }
        const a = await att.find(msg.id.startsWith('i.') ? await client.get(msg.id) : msg, m[2]); if (!a) return done(404, { error: 'attachment_not_found' });
        try {
          if (m[3]) { const t = await att.text(a); return done(200, { id: msg.id, attachment: Attachments.public(a), ...t }, 'attachment_text'); }
          const b = await att.bytes(a);
          store.logCall({ key: key.id, bot: key.name, method: req.method, path, status: 200, action: 'attachment_download' });
          const fn = String(a.filename || 'attachment').replace(/[\r\n"\\]/g, '_');
          res.writeHead(200, { ...HEADERS, 'content-type': 'application/octet-stream', 'content-length': b.length, 'content-disposition': `attachment; filename="${fn.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fn)}`, 'x-attachment-content-type': String(a.content_type || '').replace(/[^\x20-\x7e]/g, ''), 'content-security-policy': "default-src 'none'; sandbox" });
          res.end(b); return true;
        } catch (e) { return done(e.status || 502, { error: e.message, ...(e.limit ? { max_bytes: e.limit } : {}), ...(e.supported ? { supported: e.supported } : {}) }, 'attachment_error'); }
      }
      m = p.match(/^\/api\/mail\/messages\/([^/]+)\/(move|read)$/);
      if (m && req.method === 'POST') {
        if (!need('sort')) return done(403, { error: 'missing_scope', scope: 'sort' });
        const b = await jsonBody(req); const msg = ID_RE.test(m[1]) ? await original(m[1]) : null; if (!msg) return done(404, { error: 'not_found' });
        if (m[2] === 'read') { store.markRead(m[1], b.read !== false); return done(200, { ok: true, id: m[1], read: b.read !== false }, 'mark_read'); }
        const folder = String(b.folder || '').toLowerCase(); if (!MOVABLE.includes(folder)) return done(400, { error: 'bad_folder', folders: MOVABLE });
        const why = clip(b.reason, 300).trim(); if (!why) return done(400, { error: 'reason_required' });
        const mv = store.move(m[1], folder, { who: 'bot:' + key.name, why });
        return done(200, { ok: true, id: m[1], folder, move_id: mv ? mv.id : null }, 'move:' + folder);
      }
      if (p === '/api/mail/drafts' && req.method === 'POST') {
        if (!need('draft')) return done(403, { error: 'missing_scope', scope: 'draft' });
        const r = await createBotDraft('bot:' + key.name, await jsonBody(req)); return done(r.code, r.body, 'draft');
      }
      return done(404, { error: 'not_found', guide: '/api/mail/guide' });
    } catch (e) { log('mailbox.bot_error', { reason: e.message }); return done(e.status || 502, { error: e.status ? e.message : 'mail_unavailable' }); }
  }

  // ---------- owner API (/mail/api/v2/*, owner session + CSRF header checked by the caller) ----------
  async function ownerRoute(req, res, sub, u) {
    const p = sub.replace(/^\/api\/v2/, ''); const who = 'owner';
    try {
      if (req.method === 'GET') {
        if (p === '/bots') return json(res, 200, bots.list());
        if (p === '/bots/run-status') { const id = String(u.searchParams.get('id') || ''); if (!ID_RE.test(id)) return json(res, 400, { error: 'bad_id' }); return json(res, 200, bots.runStatus(id)); }
        if (p === '/bots/models') return json(res, 200, await bots.models.list());
        if (p === '/bots/usage') { await bots.models.list(); return json(res, 200, bots.usage()); }
        if (p === '/tools') return json(res, 200, { cards: tools.cards(), log: tools.state().log.slice(-100).reverse() });
        let bm = p.match(/^\/bots\/([a-z0-9-]+)(?:\/(export|download))?$/);
        if (bm) {
          if (!bm[2]) return json(res, 200, bots.get(bm[1]));
          const r = bots.get(bm[1]);
          if (bm[2] === 'download') return out(res, 200, pkg.toMarkdown(r.effective, { site: primary }), 'text/markdown; charset=utf-8', { 'content-disposition': `attachment; filename="${bm[1]}.md"` });
          const bundle = bots.bundle(bm[1]); const bytes = pkg.bundleZip(bundle);
          return out(res, 200, bytes, 'application/zip', { 'content-disposition': `attachment; filename="${bm[1]}-bot.zip"` });
        }
        if (p === '/folder') {
          const folder = (u.searchParams.get('f') || 'inbox').toLowerCase(); if (!FOLDERS.includes(folder)) return json(res, 400, { error: 'bad_folder' });
          if (u.searchParams.get('refresh') === '1') { listCache = null; sentMail.cache = null; }
          const rows = await folderRows(folder); const all = await received().catch(() => []);
          const c = { drafts: store.drafts().length };
          for (const f of MOVABLE) c[f] = all.filter(r => store.state(r.id).folder === f && (f !== 'inbox' || !store.state(r.id).read)).length;
          return json(res, 200, { folder, items: rows, counts: c, updated: new Date(now()).toISOString() });
        }
        let m = p.match(/^\/message\/([^/]+)$/);
        if (m) {
          const id = m[1];
          if (id.startsWith('d_')) { const d = store.draft(id); return d ? json(res, 200, { kind: 'draft', ...d, original: d.reply_to_id ? await original(d.reply_to_id).catch(() => null) : null }) : json(res, 404, { error: 'not_found' }); }
          if (id.startsWith('s_')) { const s = store.sentCopy(id); return s ? json(res, 200, { kind: 'sent', ...s }) : json(res, 404, { error: 'not_found' }); }
          if (id.startsWith('x.')) { const s = await sentMail.get(id); return s ? json(res, 200, { kind: 'site_sent', ...s }) : json(res, 404, { error: 'not_found' }); }
          const msg = await original(id); if (!msg) return json(res, 404, { error: 'not_found' });
          if (!msg.read) store.markRead(id, true);
          return json(res, 200, { kind: 'mail', ...msg, read: true, moves: store.db.moves.filter(x => x.msg === id).slice(-20).reverse(), promo: P.isPromo(msg), needs_john: P.escalations([msg.subject, msg.text], store.settings().staff_names, { from: msg.from }), replies: repliesFor(msg.id, store.sentList(), bots.timeline(msg.id)), draft: draftFor(msg.id, store.db.drafts, { replies: repliesFor(msg.id, store.sentList(), bots.timeline(msg.id)), folder: store.state(msg.id).folder, timeline: bots.timeline(msg.id) }), kb_gap: (bots.db.kb_gaps || {})[msg.id] || null, checker_notes: bots.notes(msg.id), timeline: bots.timeline(msg.id) });
        }
        m = p.match(/^\/message\/([^/]+)\/html$/);
        if (m) {
          if (!ID_RE.test(m[1])) return json(res, 404, { error: 'not_found' });
          const full = await client.get(m[1]); if (!full) return json(res, 404, { error: 'not_found' });
          const img = u.searchParams.get('images') === '1';
          return out(res, 200, documentHtml(full.html || '', { images: img }), 'text/html; charset=utf-8', { 'content-security-policy': FRAME_CSP(img), 'x-frame-options': 'SAMEORIGIN' });
        }
        if (p === '/activity') return json(res, 200, { moves: store.moves(200) });
        if (p === '/keys') return json(res, 200, { keys: keys.list(), scopes: SCOPES, site: keys.site });
        m = p.match(/^\/keys\/(bk_[a-f0-9]{12})\/history$/); if (m) return json(res, 200, { history: keys.history(m[1]) });
        if (p === '/settings') return json(res, 200, { settings: store.settings(), checker_available: checker.available, checker_key_var: 'XAI_API_KEY', auto_sent_today: store.autoSentToday(), from: fromAddress, log: store.db.settings_log.slice(-20).reverse() });
        return json(res, 404, { error: 'not_found' });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
      const b = p === '/bots/import' ? JSON.parse(await readBody(req, 5700000)) : await jsonBody(req);
      if (p === '/bots/reprocess') {
        const id = String(b.id || ''); if (!ID_RE.test(id)) return json(res, 400, { error: 'bad_id' });
        store.db.audit ||= []; store.db.audit.push({ at: store.iso(), who, action: 'reprocess', id }); store.save();
        const r = bots.reprocess(id, who); return json(res, r.already_running ? 409 : 202, { ok: !r.already_running, ...(r.already_running ? { error: 'already_running', detail: 'A run on this message is already in progress.' } : {}), run: r.run });
      }
      if (p === '/bots/redraft') {
        const id = String(b.id || ''); if (!ID_RE.test(id)) return json(res, 400, { error: 'bad_id' });
        store.db.audit ||= []; store.db.audit.push({ at: store.iso(), who, action: 'redraft', id }); store.save();
        const r = bots.redraft(id, who);
        if (r.already_replied) return json(res, 409, { ok: false, error: 'already_replied', detail: 'A reply was already sent for this email.' });
        if (r.no_draft) return json(res, 409, { ok: false, error: 'no_draft', detail: 'There is no current draft to redraft. Use Rerun to write a new one.' });
        return json(res, r.already_running ? 409 : 202, { ok: !r.already_running, ...(r.already_running ? { error: 'already_running', detail: 'A run on this message is already in progress.' } : {}), run: r.run });
      }
      if (p === '/bots/import') {
        if (typeof b.data !== 'string' || b.data.length > 5600000 || !/^[A-Za-z0-9+/=\r\n]+$/.test(b.data)) return json(res, 400, { error: 'base64_file_required' });
        return json(res, 201, bots.import(Buffer.from(b.data, 'base64'), clip(b.filename, 200)));
      }
      if (p === '/bots/cap') { bots.setCap(Number(b.cap)); return json(res, 200, bots.usage()); }
      if (p === '/bots/run') return json(res, 200, await bots.wake('owner'));
      let bm = p.match(/^\/bots\/([a-z0-9-]+)\/(toggle|copy|save|reset|restore|remove)$/);
      if (bm) {
        const id = bm[1]; let result;
        if (bm[2] === 'toggle') { if (typeof b.enabled !== 'boolean') return json(res, 400, { error: 'boolean_required' }); result = bots.toggle(id, b.enabled); }
        if (bm[2] === 'copy') result = bots.copy(id);
        if (bm[2] === 'save') { if (b.limits && b.limits.model && !(await bots.models.has(b.limits.model))) return json(res, 400, { error: 'model_not_available' }); result = bots.edit(id, b); }
        if (bm[2] === 'reset') result = bots.reset(id);
        if (bm[2] === 'restore') result = bots.restore(id, b.version);
        if (bm[2] === 'remove') { bots.remove(id); result = { ok: true }; }
        return json(res, 200, result);
      }
      bm = p.match(/^\/tools\/(kb|shopify)\/(connect|disconnect)$/);
      if (bm) {
        let result = { ok: true };
        if (bm[2] === 'connect') result = tools.connect(bm[1], b);
        if (bm[2] === 'disconnect') result = tools.disconnect(bm[1], b);
        return json(res, 200, result);
      }
      if (p === '/move') { const id = String(b.id || ''); if (!(await original(id))) return json(res, 404, { error: 'not_found' }); const mv = store.move(id, String(b.folder || '').toLowerCase(), { who, why: clip(b.reason || 'Moved by owner', 300) }); return json(res, 200, { ok: true, move: mv }); }
      if (p === '/read') { const id = String(b.id || ''); if (!ID_RE.test(id)) return json(res, 404, { error: 'not_found' }); store.markRead(id, b.read !== false); return json(res, 200, { ok: true }); }
      if (p === '/undo') { const r = store.undo(String(b.move || ''), { who }); return json(res, r.ok ? 200 : 409, r); }
      if (p === '/drafts/new') {
        let to = addrOf(b.to); let subject = clip(b.subject, 200); const replyId = ID_RE.test(String(b.reply_to_id || '')) ? b.reply_to_id : null;
        if (replyId) { const o2 = await original(replyId); if (!o2) return json(res, 404, { error: 'not_found' }); to = addrOf(o2.from); subject = subject || 'Re: ' + String(o2.subject || '').replace(/^\s*re:\s*/i, ''); }
        const d = store.createDraft({ author: 'owner', reply_to_id: replyId, to, subject, body: clip(b.body, 20000), reason: '' }); return json(res, 201, { ok: true, draft: d });
      }
      let m = p.match(/^\/drafts\/(d_[A-Za-z0-9_-]+)\/(save|send|discard)$/);
      if (m) {
        const d = store.draft(m[1]); if (!d || d.status === 'sent' || d.status === 'discarded') return json(res, 404, { error: 'not_found' });
        if (m[2] === 'save') { const patch = { subject: clip(b.subject ?? d.subject, 200), body: clip(b.body ?? d.body, 20000) }; if (!d.reply_to_id && b.to != null) patch.to = addrOf(b.to); return json(res, 200, { ok: true, draft: store.updateDraft(d.id, patch) }); }
        if (m[2] === 'discard') { store.updateDraft(d.id, {}, 'discarded'); return json(res, 200, { ok: true }); }
        if (b.confirm !== 'SEND') return json(res, 428, { error: 'confirm_required', detail: 'Send needs {"confirm":"SEND"} from the confirmation step.' });
        const edited = store.updateDraft(d.id, { subject: clip(b.subject ?? d.subject, 200), body: clip(b.body ?? d.body, 20000), ...(!d.reply_to_id && b.to != null ? { to: addrOf(b.to) } : {}) });
        const r = await deliver(edited, { approved_by: 'owner', via: 'owner' }); return json(res, r.ok ? 200 : 502, r.ok ? { ok: true, sent_id: r.sent.id } : { error: r.reason });
      }
      if (p === '/keys/new') { const r = keys.create({ name: b.name, scopes: b.scopes }); if (!r.ok) return json(res, 400, { error: r.reason }); log('mailbox.key_created', { id: r.id }); return json(res, 201, { ok: true, id: r.id, key: r.key, record: r.record, note: 'Shown once. Only a hash is stored.' }); }
      m = p.match(/^\/keys\/(bk_[a-f0-9]{12})\/revoke$/); if (m) { if (!keys.revoke(m[1])) return json(res, 404, { error: 'not_found' }); log('mailbox.key_revoked', { id: m[1] }); return json(res, 200, { ok: true }); }
      if (p === '/settings') {
        const patch = {};
        if ('auto_send' in b) { if (typeof b.auto_send !== 'boolean') return json(res, 400, { error: 'auto_send must be boolean' }); if (b.auto_send && !checker.available) return json(res, 409, { error: 'checker_unavailable' }); if (b.auto_send && b.confirm !== 'ON') return json(res, 428, { error: 'confirm_required' }); patch.auto_send = b.auto_send; }
        if ('kill_switch' in b) { if (typeof b.kill_switch !== 'boolean') return json(res, 400, { error: 'kill_switch must be boolean' }); patch.kill_switch = b.kill_switch; if (b.kill_switch) patch.auto_send = false; }
        if ('daily_cap' in b) { const n = Number(b.daily_cap); if (!Number.isInteger(n) || n < 0 || n > 200) return json(res, 400, { error: 'daily_cap must be 0-200' }); patch.daily_cap = n; }
        if ('auto_sort_promo' in b) { if (typeof b.auto_sort_promo !== 'boolean') return json(res, 400, { error: 'auto_sort_promo must be boolean' }); patch.auto_sort_promo = b.auto_sort_promo; }
        if ('staff_names' in b) { if (!Array.isArray(b.staff_names)) return json(res, 400, { error: 'staff_names must be a list' }); patch.staff_names = b.staff_names.map(x => clip(x, 40).trim()).filter(Boolean).slice(0, 30); }
        log('mailbox.settings', { keys: Object.keys(patch) }); return json(res, 200, { ok: true, settings: store.setSettings(patch, who) });
      }
      return json(res, 404, { error: 'not_found' });
    } catch (e) { log('mailbox.owner_error', { reason: e.message }); return json(res, e.status || 502, { error: e.status ? e.message : 'mail_unavailable' }); }
  }
  // ---------- read-only monitoring view (src/mailreadapi.js, docs/MAIL_READ_API.md; John, Nov 15, 7:30 PM ET) ----------
  // What the owner page shows per message, without any write: status, short reason, every step, drafts and sent text.
  // Customer email bodies are not returned (length only); subject and sender are.
  function readStatus(row) {
    const id = row.id; const tl = bots.timeline(id); const sentAll = store.sentList(); const rep = repliesFor(id, sentAll, tl);
    const live = bots.live.get(id); const st = store.state(id) || {};
    let start = 0; for (let i = tl.length - 1; i >= 0; i--) if (tl[i].step === 'pipeline' && /^(?:started|requested)$/.test(tl[i].status)) { start = i; break; }
    const run = tl.slice(start); const last = (re) => [...run].reverse().find(x => re.test(String(x.status || '')));
    const drafts = store.drafts().filter(d => d.reply_to_id === id && String(d.author || '').startsWith('bot:'));
    let status, reason = null;
    if (rep) { status = 'sent'; reason = 'Sent ' + rep.latest.at + (rep.count > 1 ? ' (' + rep.count + ' replies)' : ''); }
    else if (live && /^(?:queued|running)$/.test(live.status)) { status = 'running'; reason = live.label || null; }
    else if (last(/^error$/)) { status = 'failed'; reason = last(/^error$/).reason; }
    else if (last(/^(?:held|fail)$/) || drafts.some(d => d.status === 'held' || d.status === 'draft')) { const h = last(/^(?:held|fail)$/); status = 'held'; reason = h ? h.step + ': ' + h.reason : 'Unsent draft waiting for the owner'; }
    else if (st.folder && st.folder !== 'inbox') { status = 'not_replied'; reason = 'In ' + st.folder; }
    else if (!tl.length) { status = 'pending'; reason = 'Not processed yet'; }
    else { status = 'not_replied'; const x = run[run.length - 1]; reason = x ? x.step + ': ' + x.reason : null; }
    return { id, received_at: row.created_at || null, subject: String(row.subject || '').slice(0, 200), from: String(row.from || '').slice(0, 200), folder: st.folder || 'inbox', status, reason: reason ? String(reason).slice(0, 300) : null };
  }
  async function readList({ status = 'all', since = null, limit = 50 } = {}) {
    const rows = await received(true); const t = since ? Date.parse(since) : NaN;
    const out = [];
    for (const r of rows) {
      if (!isNaN(t) && Date.parse(r.created_at) < t) continue;
      const x = readStatus(r);
      if (status === 'all' || x.status === status || (status === 'unsent' && x.status !== 'sent') || (status === 'failed' && x.status === 'failed')) out.push(x);
      if (out.length >= limit) break;
    }
    return out;
  }
  // Jarvis rerun key (John, Nov 15, 9:11 PM ET: "Yes, have Coder build a rerun-only key for unanswered emails"). Checks
  // whether one unanswered email may be rerun, then runs the normal pipeline once (sorter, writer, checker, auto-send) via
  // the same reprocess the owner's Rerun button uses. Nothing is forced past the checker or the send gate.
  async function rerunCheck(id) {
    if (!ID_RE.test(String(id || ''))) return { code: 404, error: 'not_found' };
    const m = await original(id).catch(() => null); if (!m) return { code: 404, error: 'not_found' };
    if (bots.sentFor(id) || readStatus({ id, created_at: m.created_at, subject: m.subject, from: m.from }).status === 'sent') return { code: 409, error: 'already_replied', detail: 'A reply was already sent for this email.' };
    const folder = (store.state(id) || {}).folder;
    if (folder === 'trash' || folder === 'spam') return { code: 409, error: 'in_' + folder, detail: 'The email is in ' + folder + '.' };
    const live = bots.live.get(id); if ((live && (live.status === 'queued' || live.status === 'running')) || (bots.db.pending || []).some(x => x.id === id) || bots.locks.has(id)) return { code: 409, error: 'already_running', detail: 'A run on this email is queued or in progress.' };
    return { code: 200 };
  }
  function rerunByKey(id) {
    store.db.audit ||= []; store.db.audit.push({ at: store.iso(), who: 'Jarvis rerun key', action: 'reprocess', id }); store.save();
    return bots.reprocess(id, 'Jarvis rerun key');
  }
  function redraftByKey(id) {
    store.db.audit ||= []; store.db.audit.push({ at: store.iso(), who: 'Jarvis rerun key', action: 'redraft', id }); store.save();
    return bots.redraft(id, 'Jarvis rerun key');
  }
  async function readActivity(id) {
    if (!ID_RE.test(id)) return null; const m = await original(id).catch(() => null); if (!m) return null;
    const head = readStatus({ id, created_at: m.created_at, subject: m.subject, from: m.from });
    const tl = bots.timeline(id); const pick = (re) => tl.filter(x => re.test(x.step)).map(x => ({ at: x.at, step: x.step, status: x.status, reason: x.reason, ...(x.bot ? { bot: x.bot } : {}), ...(x.code ? { code: x.code } : {}) }));
    const live = bots.live.get(id);
    return { ...head, email_text_chars: String(m.text || '').length,
      run: live ? { status: live.status, label: live.label || null, started: live.started ? new Date(live.started).toISOString() : null, finished: live.finished ? new Date(live.finished).toISOString() : null } : null,
      steps: { pipeline: pick(/^pipeline$/), sorter: pick(/^sort$/), writer: pick(/^reply$/).filter(x => !/^web_research$/.test(x.status)), web_research: pick(/^reply$/).filter(x => x.status === 'web_research'), checker: pick(/^check$/), auto_send: pick(/^auto_send$/) },
      timeline: tl.map(x => ({ at: x.at, step: x.step, status: x.status, reason: x.reason })),
      checker_notes: bots.notes(id),
      drafts: Object.keys(store.db.drafts).map(k => store.draft(k)).filter(d => d && d.reply_to_id === id).sort((a, b) => String(a.updated).localeCompare(String(b.updated))).map(d => ({ id: d.id, author: d.author, status: d.status, updated: d.updated, subject: d.subject, reason: d.reason || null, body: d.body, ...(d.versions && d.versions.length ? { versions: d.versions } : {}) })),
      sent: store.sentList().filter(s => s.reply_to_id === id).map(s => ({ id: s.id, at: s.at, via: s.via || null, approved_by: s.approved_by || null, resend_id: s.resend_id || null, subject: s.subject, body: s.body })) };
  }
  return { enabled: true, reason: null, webResearch, readList, readActivity, rerunCheck, rerunByKey, redraftByKey, store, keys, checker, botRoute, ownerRoute, createBotDraft, runAutoSend, fromAddress, site: primary, bots, tools, bootstrap, status, applyBootstrap, webhookRoute, shopifyCallback, close: () => { if (timer) clearInterval(timer); } };
}
module.exports = { createMailbox, ID_RE };
