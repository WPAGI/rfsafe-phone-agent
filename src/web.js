'use strict';
// Fetch one allowlisted https page. Redirects are refused so a public page cannot point us elsewhere.
const { checkUrl, looksLikeCard } = require('./linkguard');

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function readLimited(res, max = 200000) {
  if (res.text) {
    const t = await res.text();
    return t.slice(0, max);
  }
  return '';
}

async function fetchAllowlistedPage(raw, fetchImpl, allowlist) {
  const c = checkUrl(raw, allowlist);
  if (!c.ok) return { ok: false, error: c.reason };
  const res = await fetchImpl(c.url, { method: 'GET', redirect: 'manual', headers: { accept: 'text/html,text/plain' } });
  if (res.status >= 300 && res.status < 400) return { ok: false, error: 'redirect_blocked' };
  if (!res.ok) return { ok: false, error: 'fetch_failed', status: res.status };
  let excerpt = stripHtml(await readLimited(res)).slice(0, 600);
  if (looksLikeCard(excerpt)) excerpt = excerpt.replace(/(?:\d[ -]?){13,19}/g, '[removed]');
  return { ok: true, url: c.url, excerpt };
}

module.exports = { fetchAllowlistedPage, stripHtml };
