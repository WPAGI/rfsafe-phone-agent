'use strict';
const B = require('./brand');
const HOST = B.site || 'rfsafe.app'; // public site that serves SAR pages and the catalog JSON
// Read-only SAR lookup against RF Safe's public catalog (site/assets/data/sar_app.json on rfsafe.app).
// Values are FCC-reported 1-g SAR in W/kg. Nothing is invented: if no phone matches, we say so.
const CATALOG_URL = 'https://' + HOST + '/assets/data/sar_app.json';
const TTL_MS = 6 * 60 * 60 * 1000;
const norm = (s) => String(s || '').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9+]+/g, ' ').trim();
const slugOf = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : null; };
const sarPage = (slug) => 'https://' + HOST + '/sar/' + slug;
const sharePage = (slug) => 'https://' + HOST + '/sar/share/' + slug;
const rankPage = () => 'https://' + HOST + '/phones';

class SarCatalog {
  constructor({ fetchImpl, url = CATALOG_URL, now = () => Date.now() } = {}) { this.fetch = fetchImpl; this.url = url; this.now = now; this.rows = null; this.at = 0; }
  async load() {
    if (this.rows && this.now() - this.at < TTL_MS) return this.rows;
    const res = await this.fetch(this.url, { method: 'GET', redirect: 'manual', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('sar catalog fetch failed: ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('sar catalog not a list');
    this.rows = data; this.at = this.now(); return data;
  }
  async lookup(query) {
    const q = norm(query).replace(/\b(sar|radiation|level|levels|the|phone|cell)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (!q) return { found: false };
    const qt = q.split(' ');
    const rows = await this.load();
    const scored = rows.map((r) => {
      const name = norm(r.post_name || (r.brand + ' ' + r.model));
      const nt = name.split(' ');
      const hit = qt.filter((t) => nt.includes(t)).length;
      const extra = nt.length - hit;
      return { r, name, s: hit === qt.length ? 100 - extra : hit * 10 - extra };
    }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    if (!scored.length || scored[0].s < 50) return { found: false, close: scored.slice(0, 3).map((x) => x.r.post_name) };
    const r = scored[0].r; const name = r.post_name || (r.brand + ' ' + r.model); const slug = slugOf(name);
    const sar = {
      head_cellular: num(r.ushead), body_cellular: num(r.usbody), hotspot: num(r.hotspot),
      head_simultaneous_wifi_on: num(r.simulheadus), body_simultaneous_wifi_on: num(r.simulbodyus),
    };
    return {
      found: true, phone: name, fcc_id: r.fccid || null, units: 'W/kg (1-g, FCC-reported); US limit 1.6', sar,
      sar_page: sarPage(slug),
      kids_visual: sharePage(slug),
      ranking: rankPage(),
      other_matches: scored.slice(1, 3).map((x) => x.r.post_name),
    };
  }
  // Lowest-SAR phones from the same catalog. metric: head | body | combined (head + body). Optional brand filter.
  async lowest({ metric = 'combined', brand = '', limit = 5 } = {}) {
    const rows = await this.load(); const b = norm(brand);
    const pick = (r) => { const h = num(r.ushead), bo = num(r.usbody); if (metric === 'head') return h; if (metric === 'body') return bo; return h != null && bo != null ? +(h + bo).toFixed(2) : null; };
    const list = rows.filter((r) => pick(r) != null && (!b || norm(r.brand).includes(b) || norm(r.post_name).includes(b)))
      .sort((x, y) => pick(x) - pick(y)).slice(0, Math.max(1, Math.min(10, limit | 0 || 5)))
      .map((r) => { const name = r.post_name || (r.brand + ' ' + r.model); return { phone: name, head_cellular: num(r.ushead), body_cellular: num(r.usbody), release: r.releasedate ? String(r.releasedate).slice(0, 10) : null, sar_page: sarPage(slugOf(name)) }; });
    return { found: list.length > 0, metric, units: 'W/kg (1-g, FCC-reported); US limit 1.6', phones: list, ranking: rankPage(), catalog_size: rows.length };
  }
}

// Snap a free-text or short model query to a real catalog name (manufacturer + model only).
function matchCanonical(query, names) {
  const q = norm(query).replace(/\b(sar|radiation|level|levels|the|phone|cell|case|quantacase|truthcase)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q || !Array.isArray(names) || !names.length) return null;
  const qt = q.split(' ').filter(Boolean);
  const scored = names.map((name) => {
    const nt = norm(name).split(' ').filter(Boolean);
    const hit = qt.filter((tok) => nt.includes(tok)).length;
    const extra = nt.length - hit;
    return { name, s: hit === qt.length ? 100 - extra : hit * 10 - extra };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  if (!scored.length || scored[0].s < 50) return null;
  return scored[0].name;
}

module.exports = { SarCatalog, slugOf, matchCanonical };

