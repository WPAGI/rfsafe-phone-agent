'use strict';
// Attachments for the bot API: list, download, extract text. Nothing is fetched until a bot calls one of these
// endpoints, nothing is ever executed or rendered, and every fetch is server-side. Only attachments of a message that
// passed the MAIL_DOMAINS filter can be reached (the caller resolves the message first).
const { Worker } = require('node:worker_threads');
function boundedPdf(bytes, options) {
  return new Promise((resolve, reject) => {
    const w = new Worker(require.resolve('./pdf-worker'), { workerData: { bytes, options }, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } });
    let settled = false;
    const finish = (e, value) => { if (settled) return; settled = true; clearTimeout(timer); w.terminate(); if (e) reject(e); else resolve(value); };
    const timer = setTimeout(() => finish(Object.assign(new Error('pdf_extraction_timeout'), { status: 422 })), 9000);
    w.on('message', m => finish(m.error ? Object.assign(new Error(m.error), { status: m.status }) : null, m.result));
    w.on('error', () => finish(Object.assign(new Error('pdf_extraction_failed'), { status: 422 })));
    w.on('exit', () => finish(Object.assign(new Error('pdf_extraction_failed'), { status: 422 })));
  });
}
const API = 'https://api.resend.com';
const MAX_BYTES = 15 * 1024 * 1024; const TIMEOUT_MS = 20000; const PDF_PAGES = 50; const TEXT_CHARS = 400000;
const AID_RE = /^[A-Za-z0-9-]{6,80}$/;
// Signed download links come from Resend's attachment CDN; nothing else is ever fetched (no SSRF via a crafted URL).
const CDN_OK = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && !x.username && !x.password && (!x.port || x.port === '443') && (x.hostname === 'resend.com' || x.hostname.endsWith('.resend.com') || x.hostname.endsWith('.resend.app')); } catch { return false; } };
const kind = (a) => {
  const t = String(a.content_type || '').toLowerCase(); const f = String(a.filename || '').toLowerCase();
  if (t.includes('pdf') || f.endsWith('.pdf')) return 'pdf';
  if (t.includes('csv') || f.endsWith('.csv')) return 'csv';
  if (t.includes('html') || /\.html?$/.test(f)) return 'html';
  if (t.startsWith('text/') || /\.(txt|log|md|tsv|json|xml)$/.test(f)) return 'text';
  return null;
};
class Attachments {
  constructor({ key, fetchImpl = globalThis.fetch, maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS, pdfPages = PDF_PAGES, htmlToText, client }) { Object.assign(this, { key, fetch: fetchImpl, maxBytes, timeoutMs, pdfPages, htmlToText, client }); this.active = 0; }
  async api(p) {
    if (!this.key) throw Object.assign(new Error('mail_not_configured'), { status: 503 });
    const r = await this.fetch(API + p, { headers: { authorization: 'Bearer ' + this.key }, signal: AbortSignal.timeout(15000) });
    if (r.status === 404) return null; if (!r.ok) throw Object.assign(new Error('mail_provider_unavailable'), { status: 502 }); return r.json();
  }
  // msg: the resolved (domain-checked) message. Received emails (r.*) list from Resend; inbox messages fall back
  // to the attachment metadata on the message itself.
  async list(msg) {
    const p = String(msg.id).split('.');
    if (p[0] === 'r') {
      const out = []; let after = null;
      for (let i = 0; i < 5; i++) { const j = await this.api('/emails/receiving/' + encodeURIComponent(p[1]) + '/attachments?limit=100' + (after ? '&after=' + encodeURIComponent(after) : '')); const d = j && Array.isArray(j.data) ? j.data : []; out.push(...d); if (!j || !j.has_more || !d.length) break; after = d[d.length - 1].id; }
      return out.map(a => ({ id: String(a.id), filename: String(a.filename || 'attachment').slice(0, 200), content_type: String(a.content_type || 'application/octet-stream').slice(0, 100), size: Number(a.size) || null, inline: a.content_disposition === 'inline', _url: a.download_url || null }));
    }
    // Inbox email metadata doesn't always carry a download URL. Match its RFC Message-ID to an independently
    // domain-checked received email when available; never guess attachment IDs across messages.
    if (msg.message_id && this.client) {
      const norm = s => String(s || '').replace(/[<>]/g, '').trim();
      const row = (await this.client.listReceived()).find(r => r.message_id && norm(r.message_id) === norm(msg.message_id));
      if (row) { const full = await this.client.get(row.id); if (full) return this.list(full); }
    }
    return (msg.attachments || []).filter(a => a.id).map(a => ({ id: String(a.id), filename: a.filename || 'attachment', content_type: a.content_type || 'application/octet-stream', size: a.size || null, inline: false, _url: a.download_url || null }));
  }
  static public(a) { const { _url, ...x } = a; return { ...x, text_supported: !!kind(a) }; }
  async find(msg, aid) { if (!AID_RE.test(String(aid))) return null; return (await this.list(msg)).find(a => a.id === aid) || null; }
  async bytes(a) {
    if (a.size && a.size > this.maxBytes) throw Object.assign(new Error('attachment_too_large'), { status: 413, limit: this.maxBytes });
    if (!a._url) throw Object.assign(new Error('attachment_unavailable'), { status: 501 });
    if (!CDN_OK(a._url)) throw Object.assign(new Error('attachment_url_rejected'), { status: 502 });
    const r = await this.fetch(a._url, { redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
    if (!r.ok) throw Object.assign(new Error(r.status === 403 || r.status === 410 ? 'attachment_link_expired' : 'attachment_fetch_failed'), { status: 502 });
    const cl = Number(r.headers && r.headers.get ? r.headers.get('content-length') : 0); if (cl && cl > this.maxBytes) throw Object.assign(new Error('attachment_too_large'), { status: 413, limit: this.maxBytes });
    if (r.body && typeof r.body.getReader === 'function') {
      const rd = r.body.getReader(); const parts = []; let n = 0;
      for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; if (n > this.maxBytes) { try { await rd.cancel(); } catch {} throw Object.assign(new Error('attachment_too_large'), { status: 413, limit: this.maxBytes }); } parts.push(Buffer.from(value)); }
      return Buffer.concat(parts);
    }
    const b = Buffer.from(await r.arrayBuffer()); if (b.length > this.maxBytes) throw Object.assign(new Error('attachment_too_large'), { status: 413, limit: this.maxBytes }); return b;
  }
  async text(a) {
    const k = kind(a); if (!k) throw Object.assign(new Error('text_not_supported'), { status: 415, supported: ['pdf', 'text', 'csv', 'html'] });
    const b = await this.bytes(a); let out;
    if (k === 'pdf') {
      if (this.active >= 2) throw Object.assign(new Error('extraction_busy'), { status: 429 });
      this.active++; try { out = await boundedPdf(b, { maxPages: this.pdfPages, timeMs: 8000 }); } finally { this.active--; }
    }
    else { const s = b.toString('utf8').replace(/^\uFEFF/, ''); out = { text: k === 'html' ? this.htmlToText(s) : s, pages: null, truncated: false }; }
    const truncated = out.truncated || out.text.length > TEXT_CHARS;
    return { kind: k, text: out.text.slice(0, TEXT_CHARS), pages: out.pages, total_pages: out.total_pages || null, truncated, bytes: b.length };
  }
}
module.exports = { Attachments, kind, CDN_OK, MAX_BYTES, PDF_PAGES };
