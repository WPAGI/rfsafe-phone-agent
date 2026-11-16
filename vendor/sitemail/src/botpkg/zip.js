'use strict';
// In-memory zip for bot packages: write (deflate) and read (stored or deflate) with hard limits.
// Same on-disk format the modular agent site's src/zip.js reads and writes. No symlinks, no absolute
// paths, no "..", no encrypted entries, no zip64. Pure Node (zlib only).
const zlib = require('zlib');
const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, EOCD = 0x06054b50;
const LIMITS = { entries: 300, total: 8 * 1024 * 1024, entry: 2 * 1024 * 1024, zip: 4 * 1024 * 1024 };
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let b = 0; b < 8; b++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function dosTime(d) { return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() }; }
const safeName = (n) => typeof n === 'string' && n.length > 0 && n.length < 400 && !n.startsWith('/') && !/\\|\0/.test(n) && !n.split('/').some((p) => p === '..' || p === '.') && !/^[a-z]:/i.test(n);
// files: { 'rel/path': string|Buffer }. root: folder name inside the zip (like the modular site's "<Bot Name>/").
function pack(files, root, when = new Date()) {
  const t = dosTime(when); const locals = []; const centrals = []; let off = 0;
  for (const rel of Object.keys(files).sort()) {
    const name = (root ? root.replace(/\/+$/, '') + '/' : '') + rel; if (!safeName(name)) throw new Error('bad_zip_name');
    const data = Buffer.isBuffer(files[rel]) ? files[rel] : Buffer.from(String(files[rel]), 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 }); const nm = Buffer.from(name, 'utf8'); const crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(LOCAL, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(t.time, 10); lh.writeUInt16LE(t.date, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(CENTRAL, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(t.time, 12); ch.writeUInt16LE(t.date, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, comp); centrals.push(ch, nm); off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(centrals); const e = Buffer.alloc(22); const n = centrals.length / 2;
  e.writeUInt32LE(EOCD, 0); e.writeUInt16LE(n, 8); e.writeUInt16LE(n, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}
function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === EOCD && i + 22 + buf.readUInt16LE(i + 20) === buf.length) return i;
  throw Object.assign(new Error('not_a_zip'), { status: 400 });
}
// Returns { files: {name: Buffer} } with the shared top folder stripped. Throws {status:400|413} on anything odd.
function read(buf, lim = {}) {
  const L = { ...LIMITS, ...lim }; const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw bad('not_a_zip'); if (buf.length > L.zip) throw bad('zip_too_large', 413);
  const eocd = findEocd(buf); const n = buf.readUInt16LE(eocd + 10); let off = buf.readUInt32LE(eocd + 16);
  if (n > L.entries) throw bad('too_many_files', 413);
  const out = {}; let total = 0;
  for (let k = 0; k < n; k++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CENTRAL) throw bad('bad_zip');
    const flags = buf.readUInt16LE(off + 8); const method = buf.readUInt16LE(off + 10); const comp = buf.readUInt32LE(off + 20); const size = buf.readUInt32LE(off + 24); const crc = buf.readUInt32LE(off + 16);
    const nl = buf.readUInt16LE(off + 28), xl = buf.readUInt16LE(off + 30), cl = buf.readUInt16LE(off + 32); const attr = buf.readUInt32LE(off + 38); const lo = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nl).toString('utf8'); off += 46 + nl + xl + cl;
    if (name.endsWith('/')) continue;
    if (!safeName(name)) throw bad('unsafe_path'); if (flags & 1) throw bad('encrypted_zip'); if (((attr >>> 16) & 0o170000) === 0o120000) throw bad('symlink_in_zip');
    if (size > L.entry) throw bad('file_too_large', 413); total += size; if (total > L.total) throw bad('package_too_large', 413);
    if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== LOCAL) throw bad('bad_zip');
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28); const raw = buf.slice(start, start + comp);
    let data; if (method === 0) data = Buffer.from(raw); else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: L.entry + 1 }); else throw bad('unsupported_zip_method');
    if (data.length !== size || crc32(data) !== crc) throw bad('zip_crc_mismatch');
    out[name] = data;
  }
  // Strip one shared top folder ("<Bot Name>/...") the way the modular site's importer flattens its root.
  const names = Object.keys(out); const tops = new Set(names.map((x) => x.split('/')[0]));
  if (tops.size === 1 && names.every((x) => x.includes('/'))) { const t = [...tops][0] + '/'; const f = {}; for (const x of names) f[x.slice(t.length)] = out[x]; return { root: [...tops][0], files: f }; }
  return { root: null, files: out };
}
module.exports = { pack, read, crc32, LIMITS };
