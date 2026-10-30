'use strict';
const crypto = require('crypto');
const fp = (s) => 'fp_' + crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
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
module.exports = { fp, safeEq, maskPhone, readBody };
