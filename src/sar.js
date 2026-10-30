'use strict';
// Read-only SAR lookup against RF Safe's public catalog (the same JSON rfsafe.org/mel/SAR.php renders).
// Values are FCC-reported 1-g SAR in W/kg. Nothing is invented: if no phone matches, we say so.
const CATALOG_URL = 'https://rfsafe.org/cache/sar2_cache.json';
const TTL_MS = 6 * 60 * 60 * 1000;
const norm = (s) => String(s || '').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9+]+/g, ' ').trim();
const slugOf = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : null; };

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
      sar_page: 'https://rfsafe.org/mel/SAR.php?phone=' + slug,
      kids_visual: 'https://www.rfsafe.org/SAR-share/sar.kids.php?slug=' + slug + '&region=head',
      ranking: r.id ? 'https://rfsafe.org/mel/RANK.php?pid=' + encodeURIComponent(r.post_id || r.id) : 'https://rfsafe.org/mel/RANK.php',
      other_matches: scored.slice(1, 3).map((x) => x.r.post_name),
    };
  }
}

module.exports = { SarCatalog, slugOf };
