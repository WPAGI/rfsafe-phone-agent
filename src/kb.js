'use strict';
// RF Safe knowledge-base answers, grounded ONLY in local KB files (exported from the brain wiki /
// rfsafe.org pages). Each file: optional front matter with `title:` and `source:` (URL). Answers return
// passages + citations; the voice model must speak only from them. No medical advice is generated here.
const fs = require('fs');
const path = require('path');
const { hostAllowed } = require('./linkguard');

const STOP = new Set('a an and are as at be by can do does for from has have how i if in is it its me my of on or our that the this to was what when where which who why will with you your'.split(' '));
// Spoken / spelled variants collapse to one token so 'Li-Fi', 'LiFi', 'lie fi', 'light fidelity' all match.
const SYN = [[/\b(?:li[\s-]?fi|lie[\s-]?fi|lye[\s-]?fi|light[\s-]fidelity)\b/gi, ' lifi '], [/\bwi[\s-]?fi\b/gi, ' wifi '], [/\bchildren\b|\bkids?\b/gi, ' child '], [/\bnon[\s-]thermal\b/gi, ' nonthermal '], [/\bnational toxicology program\b/gi, ' ntp '], [/\bs4[\s-]+mito[\s-–]+spin\b|\bs\s?four mito spin\b/gi, ' s4mitospin '], [/\bcell\s?lm\b|\bc\.?e\.?l\.?l\.?m\b|\bsell m\b/gi, ' cellm '], [/\blow[\s-]fidelity\b/gi, ' lowfidelity '], [/\b(?:public law|p\.?\s?l\.?)\s*90[\s-]?602\b/gi, ' pl90602 '], [/\bsection\s*704\b/gi, ' section704 ']];
const norm = (s) => SYN.reduce((a, [re, r]) => a.replace(re, r), String(s).normalize('NFKC').replace(/[\u2010-\u2015\u2212]/g, '-'));
const tok = (s) => norm(s).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));

function parse(text, file) {
  let aliases = ''; let type = '';
  let title = path.basename(file, '.md'); let source = null; let body = text;
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) { body = text.slice(m[0].length); for (const line of m[1].split('\n')) { const [k, ...v] = line.split(':'); const val = v.join(':').trim().replace(/^["']|["']$/g, ''); if (k.trim() === 'title') title = val; if (k.trim() === 'source') source = val; if (k.trim() === 'aliases') aliases = val; if (k.trim() === 'page_type') type = val; } }
  return { title, source, aliases, type, body, curated: /[\\/]curated[\\/]/.test(file) };
}

class KB {
  // Inverted index (term -> flat [passageIdx, tf, ...]) so the whole wiki fits a 512 MB instance.
  constructor({ dirs = [], allowlist = [], maxDocs = 400000 } = {}) {
    this.docs = []; this.post = new Map(); this.totalLen = 0; this.allowlist = allowlist;
    for (const d of dirs) this.loadDir(d, maxDocs);
  }
  get df() { const m = new Map(); for (const [t, p] of this.post) m.set(t, p.length / 2); return m; }
  loadDir(dir, maxDocs) {
    const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) { const q = path.join(p, e.name); if (e.isDirectory()) walk(q); else if (e.name.endsWith('.md') && this.docs.length < maxDocs) this.addDoc(parse(fs.readFileSync(q, 'utf8'), q)); } };
    walk(dir);
  }
  addDoc(doc) {
    // split into ~600-char passages on paragraph boundaries; title/alias terms count extra; curated and position pages rank higher
    const head = doc.title + ' ' + (doc.aliases || ''); const headTerms = new Set(tok(head));
    const boost = doc.curated ? 2 : /^(position|answer|topic)/.test(doc.type || '') ? 1.5 : 1;
    const paras = doc.body.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    let buf = '';
    const flush = () => {
      if (!buf) return; const terms = tok(head + ' ' + buf); const tf = new Map();
      for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
      for (const t of headTerms) tf.set(t, (tf.get(t) || 0) + 2);
      const i = this.docs.length;
      for (const [t, f] of tf) { let p = this.post.get(t); if (!p) this.post.set(t, (p = [])); p.push(i, f); }
      this.docs.push({ title: doc.title, source: doc.source, text: buf, len: terms.length, boost }); this.totalLen += terms.length; buf = '';
    };
    for (const p of paras) { if ((buf + '\n' + p).length > 600) flush(); buf = buf ? buf + '\n' + p : p; }
    flush();
  }
  search(q, k = 3) {
    const qt = [...new Set(tok(q))]; const N = this.docs.length || 1; const avg = this.totalLen / N || 1;
    const acc = new Map();
    for (const t of qt) {
      const p = this.post.get(t); if (!p) continue; const n = p.length / 2;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      for (let j = 0; j < p.length; j += 2) { const d = this.docs[p[j]]; const f = p[j + 1]; acc.set(p[j], (acc.get(p[j]) || 0) + idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.len / avg))); }
    }
    const scored = [...acc].map(([i, s]) => ({ d: this.docs[i], s: s * this.docs[i].boost })).sort((a, b) => b.s - a.s);
    // at most 2 passages per page (a study's graph-node copy counts as the same page)
    const seen = new Map(); const top = [];
    for (const x of scored) { const key = x.d.title.replace(/^Graph node\s*[—-]\s*/i, '').toLowerCase().slice(0, 80); if ((seen.get(key) || 0) >= 2) continue; seen.set(key, (seen.get(key) || 0) + 1); top.push(x); if (top.length >= k) break; }
    return top.map(({ d, s }) => ({ title: d.title, text: d.text.slice(0, 600), score: +s.toFixed(3), source: d.source && this.safeSource(d.source) }));
  }
  safeSource(u) { try { const x = new URL(u); return x.protocol === 'https:' && hostAllowed(x.hostname, this.allowlist) ? x.toString() : null; } catch { return null; } }
  answer(question) {
    const hits = this.search(question, 3);
    if (!hits.length) return { found: false, guidance: 'No KB passage matches. Say you do not have that information and offer to text a link to rfsafe.org or take a message. Do not guess.' };
    return { found: true, guidance: 'Answer ONLY from these passages, briefly, in plain words. When a passage gives RF Safe\'s position, say it is RF Safe\'s position. No medical advice or health claims beyond this wording. Offer to text the source link.', passages: hits };
  }
}

module.exports = { KB, tok, norm };
