'use strict';
// Cached QuantaCase catalog for the Callbots mailbox (John, Nov 16 4:11–4:21 AM ET).
// Mailbox only: phone and text lookup paths are unchanged. Read-only Shopify; last good cache wins on failure.
// Daily refresh, plus a live stock check for phones named in the email.
const fs = require('fs');
const path = require('path');

const BLOCK_TITLE = 'QuantaCases available for phones mentioned in this email';
const DEFAULT_COLOR = 'Black';
const DEFAULT_REFRESH_MS = 24 * 60 * 60 * 1000;
const LIVE_STOCK_MS = 2500;
const PAGE_TIMEOUT_MS = 15000;
const PAGE_SIZE = 250;

function counts(products) {
  const list = products || [];
  return { models: list.length, variants: list.reduce((n, p) => n + ((p.variants && p.variants.length) || 1), 0) };
}

function isoOf(now) {
  const n = typeof now === 'function' ? now() : now;
  if (typeof n === 'string') return n;
  if (typeof n === 'number') return new Date(n).toISOString();
  if (n && typeof n.toISOString === 'function') return n.toISOString();
  return new Date().toISOString();
}

function msOf(now) {
  const n = typeof now === 'function' ? now() : now;
  if (typeof n === 'number') return n;
  if (typeof n === 'string') { const t = Date.parse(n); return Number.isFinite(t) ? t : Date.now(); }
  if (n && typeof n.getTime === 'function') return n.getTime();
  return Date.now();
}

function colorName(v, fallback = DEFAULT_COLOR) {
  const t = String((v && v.title) || '').trim();
  return (!t || t === 'Default Title') ? fallback : t;
}

function dollars(v, cents) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    const n = cents ? v / 100 : v;
    if (!Number.isFinite(n)) return null;
    return n.toFixed(2);
  }
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2);
}

function priceOf(p) {
  if (p && p.price && typeof p.price === 'object' && p.price.amount != null) return p.price.amount;
  if (p && p.price != null && p.price !== '') return p.price;
  const v = (p && p.variants || [])[0];
  return v && v.price != null ? v.price : null;
}

function formatPrice(v) {
  const d = dollars(v, false);
  if (d == null) return '';
  const n = Number(d);
  return '$' + (Number.isInteger(n) ? String(n) : d.replace(/\.00$/, ''));
}

function oneColor(p) {
  const vars = (p && p.variants) || [];
  if (vars.length <= 1) return true;
  return vars.every(v => !v.title || v.title === 'Default Title');
}

function formatProductLine(p, fallback = DEFAULT_COLOR) {
  const vars = p.variants || [];
  const stocked = vars.filter(v => v.available !== false);
  const colors = []; const seen = new Set();
  for (const v of (stocked.length ? stocked : vars)) {
    const c = colorName(v, fallback);
    const k = c.toLowerCase(); if (seen.has(k)) continue; seen.add(k); colors.push(c);
  }
  const price = formatPrice(priceOf(p));
  const stock = stocked.length ? 'in stock' : 'currently unavailable';
  const colorPart = oneColor(p) ? ((colors[0] || fallback) + ' (one color)') : (colors.length ? colors.join(', ') : 'see product page');
  const url = String(p.url || '').split('?')[0];
  let line = '- ' + (p.title || 'QuantaCase') + ': ' + (price ? price + ', ' : '') + stock + ' in ' + colorPart + '. ' + url;
  if (!oneColor(p)) {
    for (const v of stocked) {
      const vu = v.url || (v.id && url ? (url + '?variant=' + v.id) : '');
      if (vu) line += '\n  ' + colorName(v, fallback) + ': ' + vu;
    }
  }
  return line;
}

function formatBlock(found, fallback = DEFAULT_COLOR) {
  if (!found || !found.length) return null;
  return [BLOCK_TITLE, ...found.map(x => formatProductLine(x.product, fallback))].join('\n');
}

function catalogFields(hit) {
  if (!hit || !hit.block) return {};
  return {
    quanta_cases_block: hit.block,
    phone_catalog: { title: BLOCK_TITLE, models: hit.models || [], products: (hit.found || []).map(x => x.product) }
  };
}

function findProduct(products, model, phoneKeys) {
  const keysFn = phoneKeys || (() => []);
  const k = ((keysFn(model)[0]) || String(model || '').toLowerCase()).trim();
  if (!k) return null;
  const hits = (products || []).filter(p => {
    const blob = [p.title || '', String(p.handle || '').replace(/-/g, ' '), p.url || ''].join(' ');
    return keysFn(blob).includes(k);
  });
  if (!hits.length) return null;
  const exact = hits.find(p => String(p.handle || '').toLowerCase().includes(k.replace(/\s+/g, '-')));
  return exact || hits[0];
}

function priceTokens(p) {
  const out = new Set();
  const add = (v) => {
    const d = dollars(v, false); if (d == null) return;
    const n = Number(d);
    out.add(d); out.add(String(n)); out.add(n.toFixed(2)); out.add(String(n).replace(/\.00$/, ''));
  };
  add(priceOf(p));
  for (const v of (p.variants || [])) add(v.price);
  return out;
}

function mentionsProduct(text, p, phoneKeys) {
  const t = String(text || '');
  const keys = phoneKeys([p.title || '', String(p.handle || '').replace(/-/g, ' ')].join(' '));
  if (keys.some(k => new RegExp('\\b' + k.replace(/\s+/g, '\\s+') + '\\b', 'i').test(t))) return keys[0] || true;
  const handle = String(p.handle || '').toLowerCase();
  if (handle && handle.length > 3 && t.toLowerCase().includes(handle)) return keys[0] || handle;
  return null;
}

// Deterministic: a dollar amount next to a catalog model that is not that case's price.
function claimProblems(body, products, phoneKeys) {
  const out = [];
  const sentences = String(body || '').split(/(?<=[.!?])\s+|\n+/);
  for (const p of products || []) {
    const keys = phoneKeys([p.title || '', String(p.handle || '').replace(/-/g, ' ')].join(' '));
    const model = keys[0] || p.title;
    const allowed = priceTokens(p);
    if (!allowed.size) continue;
    for (const s of sentences) {
      if (!mentionsProduct(s, p, phoneKeys)) continue;
      for (const m of s.matchAll(/\$\s*(\d+(?:\.\d+)?)/g)) {
        const raw = m[1];
        if (![raw, Number(raw).toFixed(2), String(Number(raw))].some(x => allowed.has(x))) {
          out.push({ model, sentence: s.trim(), fact: formatProductLine(p), reason: 'Price $' + raw + ' does not match the catalog price for the ' + model });
        }
      }
    }
  }
  return out;
}

function variantId(id) {
  if (id == null || id === '') return null;
  const m = String(id).match(/(\d+)\s*$/);
  return m ? m[1] : String(id);
}

function fromStoreProduct(p, domain, opts = {}) {
  if (!p || !(p.handle || p.url)) return null;
  const handle = String(p.handle || '').replace(/^\/+|\/+$/g, '');
  const url = String(p.url || (handle ? ('https://' + domain + '/products/' + handle) : '')).split('?')[0];
  const cents = !!opts.cents;
  const variants = (p.variants || []).map(v => {
    const id = variantId(v.id);
    const title = v.title || v.option1 || '';
    const price = dollars(v.price, cents && typeof v.price === 'number');
    return {
      ...(id ? { id } : {}),
      title,
      price,
      available: v.available !== false,
      ...(id && url ? { url: url + '?variant=' + id } : {})
    };
  });
  const amount = dollars(priceOf({ ...p, variants: variants.length ? variants : [{ price: p.price }] }), cents && typeof (p.price && p.price.amount == null ? p.price : null) === 'number')
    || (variants[0] && variants[0].price) || dollars(typeof p.price === 'object' ? null : p.price, cents && typeof p.price === 'number');
  return {
    title: p.title || 'QuantaCase',
    url,
    ...(handle ? { handle } : {}),
    ...(amount != null ? { price: { amount: String(amount), currency: (p.price && p.price.currency) || p.currency || 'USD' } } : {}),
    ...(p.options ? { options: p.options } : {}),
    variants,
    ...(p.available != null ? { available: p.available } : {})
  };
}

async function fetchJson(fetchImpl, url, timeoutMs) {
  if (!fetchImpl) return null;
  const ac = new AbortController();
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => { try { ac.abort(); } catch {} rej(new Error('timeout')); }, timeoutMs); });
  try {
    const r = await Promise.race([
      Promise.resolve(fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal: ac.signal })),
      timeout
    ]);
    if (!r || !r.ok) return null;
    return await Promise.race([Promise.resolve(r.json()), timeout]);
  } catch {
    return null;
  } finally { clearTimeout(t); }
}

function listPublicCatalog(fetchImpl, domain, { timeoutMs = PAGE_TIMEOUT_MS, pageSize = PAGE_SIZE } = {}) {
  const host = String(domain || 'quantacase.com').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return (async () => {
    const products = [];
    for (let page = 1; page <= 20; page++) {
      const j = await fetchJson(fetchImpl, 'https://' + host + '/products.json?limit=' + pageSize + '&page=' + page, timeoutMs);
      if (!j) throw new Error(page === 1 ? 'catalog_fetch_failed' : 'catalog_page_failed');
      const batch = (j.products || []).map(p => fromStoreProduct(p, host)).filter(Boolean);
      if (!batch.length) break;
      products.push(...batch);
      if ((j.products || []).length < pageSize) break;
    }
    if (!products.length) throw new Error('empty_catalog');
    return products;
  })();
}

async function applyLiveStock(product, { fetchImpl, domain, timeoutMs = LIVE_STOCK_MS } = {}) {
  if (!product || !fetchImpl) return null;
  const handle = String(product.handle || '').trim();
  const host = String(domain || 'quantacase.com').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const url = handle
    ? 'https://' + host + '/products/' + encodeURIComponent(handle) + '.js'
    : (String(product.url || '').split('?')[0] + '.js');
  if (!/^https:\/\//.test(url)) return null;
  const d = await fetchJson(fetchImpl, url, timeoutMs);
  if (!d || !Array.isArray(d.variants)) return null;
  const live = fromStoreProduct({ ...product, ...d, handle: d.handle || handle, title: d.title || product.title, variants: d.variants, options: d.options || product.options, price: d.price != null ? d.price : product.price }, host, { cents: typeof d.price === 'number' || (d.variants[0] && typeof d.variants[0].price === 'number' && d.variants[0].price >= 100) });
  return live;
}

function createPhoneCatalog({ listCatalog, search, dataDir, fileName = 'phone-catalog.json', now = () => new Date(), log = () => {}, refreshMs = DEFAULT_REFRESH_MS, extractPhoneModels, phoneKeys, handleGuesses, fetchImpl, storeDomain = 'quantacase.com', liveStockMs = LIVE_STOCK_MS } = {}) {
  if (!dataDir) throw new Error('phone-catalog: dataDir is required');
  const file = path.join(dataDir, fileName);
  let cache = null;
  let inflight = null;
  let timer = null;

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && Array.isArray(j.products) && j.products.length) { cache = j; return true; }
    } catch {}
    return false;
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, file);
  }

  function setProducts(products, source) {
    const list = Array.isArray(products) ? products.filter(p => p && (p.handle || p.url)) : [];
    if (!list.length) throw new Error('empty_catalog');
    const c = counts(list);
    cache = { refreshed_at: isoOf(now), source: source || 'shopify_read_only', products: list, models: c.models, variants: c.variants };
  }

  function products() { return (cache && cache.products) || []; }

  function merge(product) {
    if (!product || !(product.handle || product.url)) return cache;
    const handle = String(product.handle || '').toLowerCase();
    const url = String(product.url || '').split('?')[0];
    const rest = products().filter(p => {
      if (handle && String(p.handle || '').toLowerCase() === handle) return false;
      if (url && String(p.url || '').split('?')[0] === url) return false;
      return true;
    });
    const prev = cache && cache.refreshed_at;
    setProducts(rest.concat([product]), (cache && cache.source) || 'shopify_read_only');
    if (prev) cache.refreshed_at = prev;
    try { save(); } catch (e) { log('save_failed', { err: String(e && e.message || e).slice(0, 200) }); }
    return cache;
  }

  function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        if (typeof listCatalog !== 'function') throw new Error('no_listCatalog');
        const list = await listCatalog();
        setProducts(list, 'shopify_read_only');
        try { save(); } catch (e) { log('save_failed', { err: String(e && e.message || e).slice(0, 200) }); }
        return cache;
      } catch (e) {
        log('refresh_failed', { err: String(e && e.message || e).slice(0, 200) });
        return cache;
      } finally { inflight = null; }
    })();
    return inflight;
  }

  async function fetchMiss(model) {
    const k = phoneKeys ? (phoneKeys(model)[0] || '') : '';
    if (typeof search === 'function') {
      try {
        const got = (await search(model)) || [];
        const hit = k ? got.find(p => phoneKeys((p.title || '') + ' ' + (p.handle || '').replace(/-/g, ' ') + ' ' + (p.url || '')).includes(k)) : got[0];
        if (hit) {
          const norm = fromStoreProduct(hit, storeDomain) || hit;
          merge(norm);
          return norm;
        }
      } catch {}
    }
    if (typeof handleGuesses === 'function' && fetchImpl) {
      for (const h of handleGuesses(model)) {
        const live = await applyLiveStock({ handle: h, url: 'https://' + storeDomain + '/products/' + h }, { fetchImpl, domain: storeDomain, timeoutMs: liveStockMs });
        if (live) { merge(live); return live; }
      }
    }
    return null;
  }

  function match(subject, text, names) {
    const models = extractPhoneModels ? extractPhoneModels(subject, text, names) : [];
    const found = []; const missing = [];
    for (const model of models) {
      const product = findProduct(products(), model, phoneKeys || (() => []));
      if (product) found.push({ model, product }); else missing.push(model);
    }
    return { models, found, missing, block: formatBlock(found) };
  }

  async function resolve(subject, text, names) {
    let hit = match(subject, text, names);
    if (hit.missing.length) {
      for (const model of hit.missing) await fetchMiss(model);
      hit = match(subject, text, names);
    }
    if (hit.found.length && fetchImpl) {
      const updated = [];
      for (const item of hit.found) {
        const live = await applyLiveStock(item.product, { fetchImpl, domain: storeDomain, timeoutMs: liveStockMs });
        if (live) {
          try { merge(live); } catch {}
          updated.push({ ...item, product: live, live: true });
        } else {
          updated.push({ ...item, live: false });
        }
      }
      hit = { ...hit, found: updated, block: formatBlock(updated) };
    }
    return hit;
  }

  function status() {
    if (!cache) return { ok: false, models: 0, variants: 0, refreshed_at: null };
    return { ok: true, models: cache.models || products().length, variants: cache.variants || 0, refreshed_at: cache.refreshed_at || null };
  }

  function start() {
    load();
    let age = Infinity;
    if (cache && cache.refreshed_at) {
      const t = Date.parse(cache.refreshed_at);
      if (Number.isFinite(t)) age = msOf(now) - t;
    }
    if (!cache || age >= refreshMs) refresh().catch(() => {});
    timer = setInterval(() => { refresh().catch(() => {}); }, refreshMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return api;
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  const api = { load, refresh, merge, match, resolve, products, status, start, stop, setProducts: (list, source) => { setProducts(list, source || 'seed'); try { save(); } catch {} return cache; } };
  return api;
}

module.exports = { BLOCK_TITLE, DEFAULT_COLOR, DEFAULT_REFRESH_MS, LIVE_STOCK_MS, counts, colorName, formatProductLine, formatBlock, catalogFields, findProduct, claimProblems, fromStoreProduct, listPublicCatalog, applyLiveStock, createPhoneCatalog };
