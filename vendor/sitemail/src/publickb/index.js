'use strict';
// Public knowledge base at /kb (John, Nov 15 2026 2:49-2:51 PM ET). Read-only, no sign-in, no cookies.
// Routes: /kb, /kb/topics, /kb/topics/<id>, /kb/<slug>, /kb/body-systems, /kb/safety-claims, /kb/for-ai, /kb/search,
// /kb/llms.txt, /kb/all.md, /kb/api/v1/kb.json, /kb/api/v1/entries/<slug>.json, /kb/api/v1/search-index.json.
// Static assets under /kb/assets/ are served by the static site (site/kb/assets). The owner admin stays at /mail/kb.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const D = require('./data');
const R = require('./render');

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_AGE = 5; // seconds; browsers and proxies may reuse a response for at most this long

function createPublicKb({ kbApiStore, tenantId, visibility, siteDir, dataDir, now, baseUrl, ttlMs, seed, hostKb, researchBase, log = () => {} }) {
  const data = D.createData({ kbApiStore, tenantId, visibility, siteDir, dataDir, now, ttlMs, baseUrl, seed, hostKb, researchBase });
  const assetVer = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(siteDir, 'kb', 'assets', f))).digest('hex').slice(0, 10); } catch { return '0'; } };
  const assets = { css: assetVer('kb.css'), js: assetVer('kb.js') };
  const rcache = { v: null, m: new Map() };

  function send(req, res, code, type, body, { etag, extra = {} } = {}) {
    const buf = Buffer.from(body, 'utf8');
    const tag = etag ? '"kb-' + etag + '-' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10) + '"' : null;
    const h = { 'content-type': type, 'cache-control': code === 200 ? 'public, max-age=' + MAX_AGE + ', must-revalidate' : 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', ...extra };
    if (tag) h.etag = tag;
    if (tag && code === 200 && String(req.headers['if-none-match'] || '') === tag) { res.writeHead(304, h); return res.end(), true; }
    h['content-length'] = buf.length;
    res.writeHead(code, h); res.end(req.method === 'HEAD' ? undefined : buf); return true;
  }
  const html = (req, res, code, body, s) => send(req, res, code, 'text/html; charset=utf-8', body, { etag: s.dataVersion, extra: { 'content-security-policy': R.CSP, 'x-frame-options': 'SAMEORIGIN' } });
  const text = (req, res, type, body, s) => send(req, res, 200, type, body, { etag: s.dataVersion, extra: { 'access-control-allow-origin': '*' } });
  const json = (req, res, code, obj, s) => send(req, res, code, 'application/json; charset=utf-8', JSON.stringify(obj), { etag: s ? s.dataVersion : null, extra: { 'access-control-allow-origin': '*' } });

  const isKbPath = (p) => p === '/kb' || (p.startsWith('/kb/') && !p.startsWith('/kb/assets/'));
  async function route(req, res, u) {
    const p = u.pathname;
    if (!isKbPath(p)) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: 'method_not_allowed' })); return true; }
    if (p !== '/kb' && p.endsWith('/') ) { res.writeHead(301, { location: p.replace(/\/+$/, '') || '/kb', 'cache-control': 'no-store' }); res.end(); return true; }
    const s = data.snapshot();
    const rest = p.slice('/kb'.length); let m;
    // Rendered pages and files are cached per data version (search results are not), so crawlers cost little.
    if (rcache.v !== s.dataVersion) { rcache.v = s.dataVersion; rcache.m.clear(); }
    const memo = (k, fn) => { if (rcache.m.has(k)) return rcache.m.get(k); const v = fn(); if (rcache.m.size < 400) rcache.m.set(k, v); return v; };
    if (R.hidden && R.hidden(rest)) return html(req, res, 404, R.notFoundPage(s, assets), s); // section hidden for this site (brand.json public_kb.hide)
    if (rest === '') return html(req, res, 200, memo('start', () => R.startPage(s, assets)), s);
    if (rest === '/llms.txt') return text(req, res, 'text/plain; charset=utf-8', memo('llms', () => R.llmsTxt(s)), s);
    if (rest === '/all.md') return text(req, res, 'text/markdown; charset=utf-8', memo('allmd', () => R.allMd(s)), s);
    if (rest === '/api/v1/kb.json' || rest === '/api/v1' || rest === '/kb.json') return json(req, res, 200, memo('kbjson', () => R.kbJson(s)), s);
    if (rest === '/api/v1/search-index.json') return json(req, res, 200, memo('index', () => R.searchIndex(s)), s);
    if ((m = rest.match(/^\/api\/v1\/entries\/([^/]+)\.json$/))) { const e = SLUG.test(m[1]) ? s.bySlug.get(m[1]) : null; return e ? json(req, res, 200, R.entryJson(s, e), s) : json(req, res, 404, { error: 'not_found' }); }
    if (rest.startsWith('/api/')) return json(req, res, 404, { error: 'not_found', see: '/kb/for-ai' });
    if (rest === '/topics') return html(req, res, 200, R.topicsPage(s, assets), s);
    if ((m = rest.match(/^\/topics\/([a-z0-9-]{1,60})$/))) { const t = s.topics.find((x) => x.id === m[1]); return t ? html(req, res, 200, memo('t:' + t.id, () => R.topicPage(s, t, assets)), s) : html(req, res, 404, R.notFoundPage(s, assets), s); }
    if (rest === '/body-systems') return html(req, res, 200, R.bodySystemsPage(s, assets), s);
    if (rest === '/safety-claims' || rest === '/critiques') return html(req, res, 200, R.claimsPage(s, assets), s);
    if (rest === '/for-ai') return html(req, res, 200, R.forAiPage(s, assets), s);
    if (rest === '/search') return html(req, res, 200, R.searchPage(s, String(u.searchParams.get('q') || '').slice(0, 200), assets), s);
    if ((m = rest.match(/^\/([a-z0-9]+(?:-[a-z0-9]+)*)$/))) { const e = s.bySlug.get(m[1]); if (e) return html(req, res, 200, memo('e:' + e.slug, () => R.entryPage(s, e, assets)), s); }
    return html(req, res, 404, R.notFoundPage(s, assets), s);
  }
  return { route, isKbPath, reset: data.reset, snapshot: data.snapshot };
}

module.exports = { createPublicKb };
