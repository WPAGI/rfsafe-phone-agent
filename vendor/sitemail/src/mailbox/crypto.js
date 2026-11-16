'use strict';
// AES-256-GCM for the site's stored mail copies (message text, drafts, sent copies). The key lives only in the
// server env (MAILBOX_ENC_KEY, 32 bytes as base64 or 64 hex chars). Without a valid key nothing is stored.
const crypto = require('crypto');
function parseKey(raw) {
  const s = String(raw || '').trim(); if (!s) return null;
  let b = null;
  if (/^[0-9a-f]{64}$/i.test(s)) b = Buffer.from(s, 'hex');
  else { try { b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); } catch { b = null; } }
  return b && b.length === 32 ? b : null;
}
class Sealer {
  constructor(rawKey) { this.key = parseKey(rawKey); if (!this.key) throw new Error('mailbox_key_invalid'); }
  seal(obj) {
    const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return 'v1.' + iv.toString('base64url') + '.' + c.getAuthTag().toString('base64url') + '.' + ct.toString('base64url');
  }
  open(s) {
    const [v, iv, tag, ct] = String(s || '').split('.'); if (v !== 'v1' || !iv || !tag || ct == null) throw new Error('mailbox_cipher_invalid');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url')); d.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8'));
  }
}
const newKey = () => crypto.randomBytes(32).toString('base64');
module.exports = { Sealer, parseKey, newKey };
