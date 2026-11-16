'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fp = (s) => 'fp_' + crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
function scrubFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = typeof v === 'string' ? v.replace(/\+\d{8,15}/g, '[phone]') : v;
  return out;
}
function redactLine(line, secrets) {
  let out = line;
  for (const secret of secrets || []) if (secret && secret.length >= 8) out = out.split(secret).join('[redacted]');
  return out;
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
// Mask phone numbers in logs: +1727***5082
const maskPhone = (p) => String(p || '').replace(/^(\+?\d{4})\d+(\d{4})$/, '$1***$2');
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function appendJsonl(file, obj) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', { mode: 0o600 });
}
module.exports = { fp, safeEq, maskPhone, readBody, scrubFields, redactLine, appendJsonl };
