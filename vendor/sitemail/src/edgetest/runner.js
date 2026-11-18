'use strict';
// Edge testing dry run (John, Nov 17, 2026, 10:36 PM ET): every saved test email goes through the real sorter ->
// writer -> checker pipeline (MailBots, the same class and prompts the Mailbox uses), and nothing can leave.
// How "never sends" is guaranteed by construction, not by a flag:
//  - Each test gets a brand-new MailboxStore in its own temp folder (new random key), deleted afterward. The live
//    Mailbox store, threads, drafts, sent log and settings are never passed in, so they cannot be read or written.
//  - autoSend is a spy that only records "would send". There is no mail client, Resend key or send function here.
//  - createDraft writes only to the temp store. No onReplied, kbGap or web research hooks (no KB or gap writes).
//  - Orders are off: no order lookup or order index, connectedForOrders() is false, and the Shopify order_status and
//    inventory actions are refused. env holds only the xAI key, so the order-lookup flag is off as well.
//  - All HTTP goes through guardFetch: only xAI chat/models and GET of the public storefront product pages and
//    search (quantacase.com, rfsafe.com) are allowed. Everything else is refused and counted (mail APIs, Shopify
//    Admin, myshopify.com, any POST to a store).
const fs = require('fs'); const os = require('os'); const path = require('path');

const STORE_HOST = /^(?:www\.)?(?:quantacase\.com|rfsafe\.com)$/i;
const ALLOW = [
  { method: 'POST', host: /^api\.x\.ai$/i, path: /^\/v1\/chat\/completions$/ },
  { method: 'GET', host: /^api\.x\.ai$/i, path: /^\/v1\/(?:language-models|models)(?:\/[\w.-]+)?$/ },
  { method: 'GET', host: STORE_HOST, path: /^\/(?:products\/[^/]+\.js|search\/suggest\.json)$/ },
];
function guardFetch(realFetch, blocked = []) {
  return async function edgeFetch(url, opt = {}) {
    let u; try { u = new URL(String(url)); } catch { blocked.push({ host: '?', path: '?', method: '?' }); return refused(); }
    const method = String(opt.method || 'GET').toUpperCase();
    const hdr = opt.headers || {}; const hasAuth = Object.keys(hdr).some(k => /^(authorization|x-shopify-access-token)$/i.test(k));
    const ok = u.protocol === 'https:' && ALLOW.some(a => a.method === method && a.host.test(u.hostname) && a.path.test(u.pathname)) && !(STORE_HOST.test(u.hostname) && hasAuth);
    if (!ok) { blocked.push({ method, host: u.hostname, path: u.pathname.slice(0, 120) }); return refused(); }
    return realFetch(u.toString(), opt);
  };
}
function refused() { return { ok: false, status: 451, headers: { get: () => null }, json: async () => ({ error: 'blocked_by_edge_dry_run' }), text: async () => 'blocked_by_edge_dry_run' }; }

// Read-only store lookup from the public storefront (no Admin API, no token): search, then each product's public .js.
async function publicProducts(q, fetchImpl, limit = 4) {
  const base = 'https://quantacase.com';
  try {
    const r = await fetchImpl(base + '/search/suggest.json?q=' + encodeURIComponent(String(q || '').slice(0, 100)) + '&resources%5Btype%5D=product&resources%5Blimit%5D=' + limit, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
    if (!r || !r.ok) return [];
    const j = await r.json(); const hits = ((((j || {}).resources || {}).results || {}).products || []).slice(0, limit);
    const out = [];
    for (const h of hits) {
      const handle = String(h.handle || '').trim(); if (!handle || /[\/?#]/.test(handle)) continue;
      let d = null; try { const pr = await fetchImpl(base + '/products/' + encodeURIComponent(handle) + '.js', { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) }); d = pr && pr.ok ? await pr.json() : null; } catch { d = null; }
      const variants = ((d && d.variants) || []).slice(0, 20).map(v => ({ id: String(v.id), title: v.title, price: v.price != null ? String(Number(v.price) / 100) : null, in_stock: null, available: !!v.available }));
      const price = variants[0] && variants[0].price ? { amount: variants[0].price, currency: 'USD' } : (h.price ? { amount: String(h.price), currency: 'USD' } : null);
      out.push({ title: (d && d.title) || h.title || handle, url: base + '/products/' + handle, handle, price, ...(d && Array.isArray(d.options) ? { options: d.options.filter(o => (o.values || []).length).map(o => ({ name: o.name, values: o.values })) } : {}), variants });
    }
    return out;
  } catch { return []; }
}

// Tools for the dry-run MailBots: knowledge base reads from the live KB object; products from publicProducts (or a
// mock in tests); every other action refused.
function edgeTools({ kb, kbUrls, kbVersion, entryBySlug, products }) {
  return {
    state: () => ({ shopify: { connected: true }, kb: !!kb }),
    kbUrls: () => (typeof kbUrls === 'function' ? kbUrls() : []) || [],
    kbVersion: () => (typeof kbVersion === 'function' ? kbVersion() : 'edge') || 'edge',
    entryBySlug: (s) => (typeof entryBySlug === 'function' ? entryBySlug(s) : null),
    connectedForOrders: () => false,
    action: async (actor, id, action, b = {}) => {
      if (id === 'kb' && action === 'search') { if (!kb) return { hits: [] }; return { hits: kb.search(String(b.query || '').slice(0, 500), Math.min(5, Math.max(1, Number(b.k) || 3)), typeof b.title === 'string' && b.title.length <= 300 ? { title: b.title } : undefined) || [] }; }
      if (id === 'shopify' && action === 'product_link') return { products: await products(String(b.query || '').slice(0, 120)) };
      throw Object.assign(new Error('blocked_by_edge_dry_run'), { status: 403 });
    },
  };
}

// One test through a fresh, isolated MailBots. Returns the result record (no PII beyond the saved test itself).
async function runOneTest({ test, mods, key, fetchImpl, tools, defs, capUsd, answerRules, ownDomains, siteName, newsletterJoinUrl, now = () => Date.now(), maxMs = 6 * 60000, tmpRoot }) {
  const { MailBots, MailboxStore, Sealer, newKey } = mods;
  const dir = fs.mkdtempSync(path.join(tmpRoot || os.tmpdir(), 'edge-run-'));
  const sent = []; const t0 = Date.now();
  try {
    const store = new MailboxStore({ file: path.join(dir, 'mailbox.json'), sealer: new Sealer(newKey()) });
    store.setSettings({ auto_send: true, daily_cap: 1000 }, 'edge-dry-run');
    const mid = 'edge.' + test.id;
    const msg = { id: mid, subject: test.subject, text: test.question, from: test.from || 'Edge Test <edge-test@mail.grokbot.com>', created_at: new Date(now()).toISOString(), folder: 'inbox' };
    store.putCopy(mid, msg);
    const bots = new MailBots({ store, env: { XAI_API_KEY: key }, fetchImpl, now, tools, ownDomains, answerRules: answerRules || null, siteName: siteName || null, newsletterJoinUrl: newsletterJoinUrl || null,
      newsletterMember: newsletterJoinUrl ? async () => ({ subscriber: false }) : null,
      received: async () => [{ id: mid, created_at: msg.created_at }], original: async (id) => (id === mid ? msg : null),
      createDraft: async (who, b) => { const d = store.createDraft({ author: who, reply_to_id: b.reply_to_id, to: msg.from, subject: 'Re: ' + (msg.subject || ''), body: b.body, reason: b.reason }); return { code: 201, body: { draft: { id: d.id } } }; },
      autoSend: async (d) => { sent.push({ id: d.id, body: d.body }); store.updateDraft(d.id, {}, 'sent'); store.noteAutoSent(); return { auto: true, sent_id: 'edge-dry-run-not-sent', resend_id: 'edge-dry-run-not-sent' }; } });
    bots.db.cap = Math.max(0, Number(capUsd) || 0);
    for (const [id, def] of Object.entries(defs || {})) { const r = bots.db.installed[id]; if (r && def && def.custom) r.custom = JSON.parse(JSON.stringify(def.custom)); }
    for (const id of ['sorter', 'replier', 'checker']) { try { bots.toggle(id, true); } catch { /* invalid custom layer: recorded below */ } }
    for (const r of Object.values(bots.db.installed)) if (r.enabled) r.enabled_at = 0;
    const w = await bots.wake('owner');
    if (w && w.skipped) return { source: 'dry_run', reply: '', disposition: 'skipped_cost_cap', hold_reason: 'Not run: the edge-run budget left for today is too small (' + w.skipped + ').', checker_verdict: null, checker_notes: '', checker_rounds: 0, steps: [], cost_usd: 0, would_send_count: 0, ms: Date.now() - t0, timed_out: false, at: new Date(now()).toISOString() };
    // wake() returns when the message is done; an automatic retry starts 50 ms later (bots.again), so idle twice in a row means finished.
    while (Date.now() - t0 < maxMs) {
      if (!bots.running && !bots.again) { await new Promise(r => setTimeout(r, 150)); if (!bots.running && !bots.again) break; }
      await new Promise(r => setTimeout(r, 150));
    }
    const tl = bots.timeline(mid);
    const checks = tl.filter(x => x.step === 'check' && /^(pass|fail|unsure)$/.test(x.status));
    const last = checks[checks.length - 1] || null;
    let body = sent.length ? sent[sent.length - 1].body : '';
    if (!body) { try { const ds = Object.keys(store.db.drafts || {}).map(k => store.draft(k)).filter(d => d && d.reply_to_id === mid).sort((a, b) => String(a.updated).localeCompare(String(b.updated))); body = ds.length ? ds[ds.length - 1].body || '' : ''; } catch { body = ''; } }
    const held = tl.filter(x => x.status === 'held').pop(); const err = tl.filter(x => x.status === 'error').pop();
    const folder = store.state(mid).folder;
    const capHit = tl.some(x => x.status === 'error' && x.code === 'monthly_cap');
    const disposition = sent.length ? 'would_send' : capHit ? 'skipped_cost_cap' : held ? 'held' : err ? 'error' : folder !== 'inbox' ? folder : body ? 'held' : 'no_reply';
    const cost = (bots.db.usage || []).reduce((n, x) => n + (Number(x.cost) || 0), 0);
    return { source: 'dry_run', reply: String(body || ''), disposition, hold_reason: held ? String(held.reason || '').slice(0, 600) : err ? String(err.reason || '').slice(0, 600) : '',
      checker_verdict: last ? last.status : null, checker_notes: last ? String(last.reason || '').slice(0, 1500) : '', checker_rounds: checks.length,
      steps: tl.map(x => x.step + ':' + x.status).slice(0, 60), cost_usd: Math.round(cost * 1e6) / 1e6, would_send_count: sent.length, ms: Date.now() - t0,
      timed_out: Date.now() - t0 >= maxMs, at: new Date(now()).toISOString() };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { guardFetch, publicProducts, edgeTools, runOneTest, ALLOW };
