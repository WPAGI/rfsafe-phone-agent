'use strict';
// RF Safe knowledge-base answers, grounded ONLY in local KB files (exported from the brain wiki /
// rfsafe.org pages). Each file: optional front matter with `title:` and `source:` (URL). Answers return
// passages + citations; the voice model must speak only from them. No medical advice is generated here.
const fs = require('fs');
const path = require('path');
const { hostAllowed } = require('./linkguard');

const STOP = new Set('a an and are as at be by can do does for from has have how i if in is it its me my of on or our that the this to was what when where which who why will with you your'.split(' '));
const tok = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));

function parse(text, file) {
  let title = path.basename(file, '.md'); let source = null; let body = text;
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) { body = text.slice(m[0].length); for (const line of m[1].split('\n')) { const [k, ...v] = line.split(':'); const val = v.join(':').trim().replace(/^["']|["']$/g, ''); if (k.trim() === 'title') title = val; if (k.trim() === 'source') source = val; } }
  return { title, source, body };
}

class KB {
  constructor({ dirs = [], allowlist = [], maxDocs = 20000 } = {}) {
    this.docs = []; this.df = new Map(); this.allowlist = allowlist;
    for (const d of dirs) this.loadDir(d, maxDocs);
  }
  loadDir(dir, maxDocs) {
    const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); if (e.isDirectory()) walk(q); else if (e.name.endsWith('.md') && this.docs.length < maxDocs) this.addDoc(parse(fs.readFileSync(q, 'utf8'), q)); } };
    walk(dir);
  }
  addDoc(doc) {
    // split into ~600-char passages on paragraph boundaries
    const paras = doc.body.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    let buf = '';
    const flush = () => { if (!buf) return; const terms = tok(doc.title + ' ' + buf); const tf = new Map(); for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1); for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1); this.docs.push({ title: doc.title, source: doc.source, text: buf, tf, len: terms.length }); buf = ''; };
    for (const p of paras) { if ((buf + '\n' + p).length > 600) flush(); buf = buf ? buf + '\n' + p : p; }
    flush();
  }
  search(q, k = 3) {
    const qt = [...new Set(tok(q))]; const N = this.docs.length || 1;
    const avg = this.docs.reduce((a, d) => a + d.len, 0) / N || 1;
    const scored = this.docs.map((d) => {
      let s = 0;
      for (const t of qt) { const f = d.tf.get(t) || 0; if (!f) continue; const idf = Math.log(1 + (N - this.df.get(t) + 0.5) / (this.df.get(t) + 0.5)); s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.len / avg)); }
      return { d, s };
    }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k);
    return scored.map(({ d, s }) => ({ title: d.title, text: d.text.slice(0, 600), score: +s.toFixed(3), source: d.source && this.safeSource(d.source) }));
  }
  safeSource(u) { try { const x = new URL(u); return x.protocol === 'https:' && hostAllowed(x.hostname, this.allowlist) ? x.toString() : null; } catch { return null; } }
  answer(question) {
    const hits = this.search(question, 3);
    if (!hits.length) return { found: false, guidance: 'No KB passage matches. Say you do not have that information and offer to text a link to rfsafe.org or take a message. Do not guess.' };
    return { found: true, guidance: 'Answer ONLY from these passages, briefly, in plain words. No medical advice or health claims beyond this wording. Offer to text the source link.', passages: hits };
  }
}

module.exports = { KB, tok };
