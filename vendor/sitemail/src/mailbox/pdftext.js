'use strict';
// Small pure-JS PDF text extractor for bot attachment reads (order PDFs, invoices). No dependencies, never runs
// anything in the file: it only parses objects, inflates Flate streams with node:zlib and reads text operators.
// Handles classic xref and object streams, literal/hex strings, Tj/TJ/'/", and ToUnicode CMaps. Bounded by a page cap,
// a decompressed-bytes cap and a time budget.
const zlib = require('zlib');

const WS = /[\0\t\n\f\r ]/;
function inflate(buf, maxOut) {
  try { return zlib.inflateSync(buf, { maxOutputLength: maxOut }); } catch (e) {
    try { return zlib.inflateRawSync(buf.subarray(2), { maxOutputLength: maxOut }); } catch { return null; }
  }
}
// ---- tiny tokenizer/parser for PDF objects ----
class Lexer {
  constructor(s, pos = 0) { this.s = s; this.i = pos; }
  skip() { const s = this.s; for (;;) { while (this.i < s.length && WS.test(s[this.i])) this.i++; if (s[this.i] === '%') { while (this.i < s.length && s[this.i] !== '\n' && s[this.i] !== '\r') this.i++; } else return; } }
  value(depth = 0) {
    if (depth > 40) throw new Error('too_deep');
    this.skip(); const s = this.s; const c = s[this.i];
    if (c === undefined) return undefined;
    if (c === '/') { let j = this.i + 1; while (j < s.length && !WS.test(s[j]) && !'/[]<>(){}%'.includes(s[j])) j++; const n = s.slice(this.i + 1, j).replace(/#([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))); this.i = j; return { name: n }; }
    if (c === '(') return { str: this.literal() };
    if (c === '<' && s[this.i + 1] === '<') { this.i += 2; const d = {}; for (;;) { this.skip(); if (s[this.i] === '>' && s[this.i + 1] === '>') { this.i += 2; return { dict: d }; } const k = this.value(depth + 1); if (!k || k.name === undefined) { if (k === undefined) return { dict: d }; continue; } d[k.name] = this.value(depth + 1); } }
    if (c === '<') { const j = s.indexOf('>', this.i); const h = s.slice(this.i + 1, j).replace(/[^0-9a-f]/gi, ''); this.i = j + 1; return { hex: h.length % 2 ? h + '0' : h }; }
    if (c === '[') { this.i++; const a = []; for (;;) { this.skip(); if (s[this.i] === ']') { this.i++; return { arr: a }; } if (this.i >= s.length) return { arr: a }; a.push(this.value(depth + 1)); } }
    const m = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(s.slice(this.i, this.i + 32));
    if (m) {
      this.i += m[0].length; const r = /^\s+(\d+)\s+R(?![A-Za-z])/.exec(s.slice(this.i, this.i + 24));
      if (r && /^\d+$/.test(m[0])) { this.i += r[0].length; return { ref: +m[0] }; }
      return +m[0];
    }
    let j = this.i; while (j < s.length && !WS.test(s[j]) && !'/[]<>(){}%'.includes(s[j])) j++;
    if (j === this.i) { this.i++; return { op: c }; }
    const w = s.slice(this.i, j); this.i = j; return w === 'true' ? true : w === 'false' ? false : w === 'null' ? null : { op: w };
  }
  literal() {
    const s = this.s; let i = this.i + 1, depth = 1, out = '';
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') { const n = s[i + 1]; const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
        if (n in map) { out += map[n]; i += 2; continue; }
        if (/[0-7]/.test(n)) { const m = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4))[0]; out += String.fromCharCode(parseInt(m, 8) & 255); i += 1 + m.length; continue; }
        if (n === '\r' || n === '\n') { i += (n === '\r' && s[i + 2] === '\n') ? 3 : 2; continue; }
        i++; continue; }
      if (c === '(') depth++; else if (c === ')' && --depth === 0) break;
      out += c; i++;
    }
    this.i = i + 1; return out;
  }
}
function extractPdfText(buf, { maxPages = 50, maxBytes = 30 * 1024 * 1024, timeMs = 8000 } = {}) {
  const t0 = Date.now(); const s = buf.toString('latin1');
  if (!s.startsWith('%PDF-')) throw Object.assign(new Error('not_a_pdf'), { status: 422 });
  if (/\/Encrypt\s/.test(s)) throw Object.assign(new Error('pdf_encrypted'), { status: 422 });
  const objs = new Map(); let budget = maxBytes;
  const late = () => Date.now() - t0 > timeMs;
  // Every "n g obj ... endobj" in the file (later definitions win, like incremental updates).
  const re = /(\d+)\s+(\d+)\s+obj\b/g; let m;
  while ((m = re.exec(s))) {
    if (late()) break;
    const L = new Lexer(s, re.lastIndex); let v; try { v = L.value(); } catch { continue; }
    L.skip(); let stream = null;
    if (v && v.dict && s.startsWith('stream', L.i)) {
      let st = L.i + 6; if (s[st] === '\r') st++; if (s[st] === '\n') st++;
      let len = v.dict.Length; if (len && len.ref !== undefined) len = null;
      let end = typeof len === 'number' && s.startsWith('endstream', st + len) || (typeof len === 'number' && /^\s*endstream/.test(s.slice(st + len, st + len + 12))) ? st + len : s.indexOf('endstream', st);
      if (end < 0) end = s.length; stream = buf.subarray(st, end); re.lastIndex = end;
    }
    objs.set(+m[1], { v, stream });
  }
  const get = (x) => { let n = 0; while (x && x.ref !== undefined && n++ < 20) { const o = objs.get(x.ref); x = o ? o.v : null; } return x; };
  const filters = (d) => { const f = get(d.Filter); return f ? (f.arr ? f.arr.map(get).map(x => x && x.name) : [f.name]) : []; };
  const data = (o) => {
    if (!o || !o.stream) return null; const fs = filters(o.v.dict); let b = o.stream;
    for (const f of fs) { if (f === 'FlateDecode' || f === 'Fl') { b = inflate(b, Math.max(0, budget)); if (!b) return null; budget -= b.length; if (budget < 0) throw Object.assign(new Error('pdf_too_large'), { status: 413 }); } else return null; }
    return b;
  };
  // Object streams (PDF 1.5+): objects packed inside a compressed stream.
  for (const [, o] of [...objs]) {
    const d = o.v && o.v.dict; if (!d || !d.Type || d.Type.name !== 'ObjStm') continue;
    const b = data(o); if (!b) continue; const t = b.toString('latin1'); const N = get(d.N) | 0, first = get(d.First) | 0;
    const head = t.slice(0, first).trim().split(/\s+/).map(Number);
    for (let k = 0; k < N && k * 2 + 1 < head.length; k++) { const num = head[k * 2], off = head[k * 2 + 1]; if (objs.has(num) && !objs.get(num).fromStm) continue; try { objs.set(num, { v: new Lexer(t, first + off).value(), stream: null, fromStm: true }); } catch {} }
  }
  // Pages in order, from the catalog's page tree.
  const pages = [];
  const trailerRoot = (() => { const r = /\/Root\s+(\d+)\s+\d+\s+R/g; let x, last = null; while ((x = r.exec(s))) last = +x[1]; return last; })();
  const walk = (node, inherited, depth) => {
    if (pages.length >= maxPages || depth > 30) return; const d = get(node); if (!d || !d.dict) return;
    const res = d.dict.Resources || inherited;
    if (d.dict.Type && d.dict.Type.name === 'Page') { pages.push({ d: d.dict, res }); return; }
    const kids = get(d.dict.Kids); if (kids && kids.arr) for (const k of kids.arr) walk(k, res, depth + 1);
  };
  const root = trailerRoot != null ? get({ ref: trailerRoot }) : null;
  if (root && root.dict) walk(root.dict.Pages, null, 0);
  if (!pages.length) for (const [, o] of objs) { if (pages.length >= maxPages) break; const d = o.v && o.v.dict; if (d && d.Type && d.Type.name === 'Page') pages.push({ d, res: d.Resources }); }
  let totalPages = pages.length; if (root && root.dict) { const pt = get(root.dict.Pages); const c = pt && pt.dict && get(pt.dict.Count); if (typeof c === 'number') totalPages = c; }
  const cmapCache = new Map();
  const cmapFor = (fontRef) => {
    const key = fontRef && fontRef.ref; if (key != null && cmapCache.has(key)) return cmapCache.get(key);
    const f = get(fontRef); let map = null;
    if (f && f.dict && f.dict.ToUnicode) {
      const o = f.dict.ToUnicode.ref !== undefined ? objs.get(f.dict.ToUnicode.ref) : null; const b = data(o);
      if (b) { map = { two: false, m: new Map() }; const t = b.toString('latin1');
        const u16 = (h) => { let out = ''; for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); if (h.length === 2) out = String.fromCharCode(parseInt(h, 16)); return out; };
        for (const sec of t.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const p of sec[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) { if (p[1].length >= 4) map.two = true; map.m.set(parseInt(p[1], 16), u16(p[2])); }
        for (const sec of t.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) for (const p of sec[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
          if (p[1].length >= 4) map.two = true; const lo = parseInt(p[1], 16), hi = Math.min(parseInt(p[2], 16), lo + 65535);
          if (p[3][0] === '<') { const base = p[3].slice(1, -1); const b0 = parseInt(base.slice(-4) || '0', 16); const pre = u16(base.slice(0, -4)); for (let c = lo; c <= hi; c++) map.m.set(c, pre + String.fromCharCode(b0 + c - lo)); }
          else { const items = [...p[3].matchAll(/<([0-9a-fA-F]*)>/g)].map(x => u16(x[1])); for (let c = lo; c <= hi && c - lo < items.length; c++) map.m.set(c, items[c - lo]); }
        }
      }
    }
    if (key != null) cmapCache.set(key, map); return map;
  };
  const decode = (raw, map) => {
    if (!map) return raw.replace(/[\u0080-\u009f]/g, '');
    let out = ''; const step = map.two ? 2 : 1;
    for (let i = 0; i + step <= raw.length; i += step) { const c = step === 2 ? (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1) : raw.charCodeAt(i); out += map.m.has(c) ? map.m.get(c) : (step === 1 ? raw[i] : ''); }
    return out;
  };
  const hexRaw = (h) => { let o = ''; for (let i = 0; i < h.length; i += 2) o += String.fromCharCode(parseInt(h.slice(i, i + 2), 16)); return o; };
  const texts = [];
  for (const pg of pages) {
    if (late()) break;
    const res = get(pg.res); const fonts = res && res.dict ? get(res.dict.Font) : null;
    let cs = get(pg.d.Contents); const parts = cs && cs.arr ? cs.arr : [pg.d.Contents];
    let content = ''; for (const p of parts) { const o = p && p.ref !== undefined ? objs.get(p.ref) : null; const b = data(o); if (b) content += b.toString('latin1') + '\n'; }
    const L = new Lexer(content); const stack = []; let map = null; let line = ''; const lines = []; let lastY = null;
    const emit = (t) => { line += t; };
    const nl = () => { if (line.trim()) lines.push(line.replace(/\s+$/, '')); line = ''; };
    let guard = 0;
    while (L.i < content.length && guard++ < 2e6) {
      let v; try { v = L.value(); } catch { break; } if (v === undefined) break;
      if (!v || v.op === undefined) { stack.push(v); if (stack.length > 64) stack.shift(); continue; }
      const op = v.op; const a = stack.splice(0);
      const str = (x) => x && (x.str !== undefined ? decode(x.str, map) : x.hex !== undefined ? decode(hexRaw(x.hex), map) : '');
      if (op === 'Tf') { const fn = a[0] && a[0].name; map = fonts && fonts.dict && fn ? cmapFor(fonts.dict[fn]) : null; }
      else if (op === 'Tj') emit(str(a[0]));
      else if (op === "'" || op === '"') { nl(); emit(str(a[a.length - 1])); }
      else if (op === 'TJ') { const arr = a[0] && a[0].arr || []; for (const x of arr) { if (typeof x === 'number') { if (x < -200) emit(' '); } else emit(str(x)); } }
      else if (op === 'T*' ) nl();
      else if (op === 'Td' || op === 'TD') { if (typeof a[1] === 'number' && a[1] !== 0) nl(); else if (typeof a[0] === 'number' && a[0] > 0 && line && !/\s$/.test(line)) emit(' '); }
      else if (op === 'Tm') { const y = a[5]; if (typeof y === 'number' && lastY !== null && Math.abs(y - lastY) > 1) nl(); else if (line && !/\s$/.test(line)) emit(' '); lastY = y; }
      else if (op === 'ET') { /* keep line open: next BT may continue the row */ }
      else if (op === 'BI') { const e = content.indexOf('EI', L.i); L.i = e < 0 ? content.length : e + 2; }
    }
    nl(); texts.push(lines.join('\n'));
  }
  return { text: texts.join('\n\n\f\n\n').replace(/[\u0000-\u0008\u000b\u000e-\u001f]/g, '').trim(), pages: texts.length, total_pages: totalPages, truncated: totalPages > texts.length || late() };
}
module.exports = { extractPdfText };
