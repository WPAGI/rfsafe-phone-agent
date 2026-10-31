'use strict';
// Owner PIN: scrypt hash in DATA_DIR/owner-pins.json (0600), never in the tenant file, never logged.
// Lockout: 5 failed tries per tenant per day locks PIN checks until the next local day.
const fs = require('fs'); const crypto = require('crypto');
const MAX_FAILS = 5;
class PinStore {
  constructor({ file }) { this.file = file; this.fails = new Map(); }
  _read() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; } }
  _write(o) { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(o), { mode: 0o600 }); fs.renameSync(tmp, this.file); }
  static valid(pin) { return /^\d{4,8}$/.test(String(pin || '')); }
  set(tenantId, pin) {
    if (!PinStore.valid(pin)) return false;
    const salt = crypto.randomBytes(16); const hash = crypto.scryptSync(String(pin), salt, 32);
    const o = this._read(); o[tenantId] = { salt: salt.toString('base64'), hash: hash.toString('base64'), set_at: new Date().toISOString() }; this._write(o); return true;
  }
  clear(tenantId) { const o = this._read(); delete o[tenantId]; this._write(o); }
  has(tenantId) { return !!this._read()[tenantId]; }
  locked(tenantId, day) { const f = this.fails.get(tenantId); return !!(f && f.day === day && f.n >= MAX_FAILS); }
  // Accepts spoken forms ("one two three four") and keypad digits.
  static digits(input) {
    const words = { zero: 0, oh: 0, o: 0, one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, ate: 8, nine: 9 };
    return String(input || '').toLowerCase().split(/[^a-z0-9]+/).map((w) => (/^\d+$/.test(w) ? w : w in words ? String(words[w]) : '')).join('');
  }
  verify(tenantId, input, day) {
    if (this.locked(tenantId, day)) return { ok: false, reason: 'locked' };
    const rec = this._read()[tenantId]; if (!rec) return { ok: false, reason: 'no_pin_set' };
    const got = crypto.scryptSync(PinStore.digits(input), Buffer.from(rec.salt, 'base64'), 32);
    if (crypto.timingSafeEqual(got, Buffer.from(rec.hash, 'base64'))) { this.fails.delete(tenantId); return { ok: true }; }
    const f = this.fails.get(tenantId); const n = f && f.day === day ? f.n + 1 : 1; this.fails.set(tenantId, { day, n });
    return { ok: false, reason: n >= MAX_FAILS ? 'locked' : 'wrong_pin', fails: n };
  }
}
module.exports = { PinStore, MAX_FAILS };
