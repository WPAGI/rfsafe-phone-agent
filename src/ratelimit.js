'use strict';
// Per-caller and per-call caps for link texts. The file stores hashes and timestamps only.
const fs = require('fs');
const path = require('path');
const { fp } = require('./util');

class SmsRateLimit {
  constructor({ perCall = 3, perHour = 5, perDay = 10, now = () => Date.now(), file = null } = {}) {
    this.perCall = perCall; this.perHour = perHour; this.perDay = perDay; this.now = now; this.file = file;
    this.events = [];
    if (file && fs.existsSync(file)) {
      try { this.events = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.events = []; }
      if (!Array.isArray(this.events)) this.events = [];
    }
  }
  allow({ tenant, caller, callId }) {
    const now = this.now();
    const callerKey = fp(tenant + '|caller|' + caller);
    const callKey = callId ? fp(tenant + '|call|' + callId) : null;
    this.events = this.events.filter((e) => now - e.t < 2 * 86400 * 1000);
    const hour = this.events.filter((e) => e.k === callerKey && now - e.t < 3600 * 1000).length;
    const day = this.events.filter((e) => e.k === callerKey && now - e.t < 86400 * 1000).length;
    const callCount = callKey ? this.events.filter((e) => e.k === callKey).length : 0;
    if (callKey && callCount >= this.perCall) return { ok: false, reason: 'per_call_cap' };
    if (hour >= this.perHour) return { ok: false, reason: 'hourly_cap' };
    if (day >= this.perDay) return { ok: false, reason: 'daily_cap' };
    if (callKey) this.events.push({ k: callKey, t: now });
    this.events.push({ k: callerKey, t: now });
    this.save();
    return { ok: true };
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.events), { mode: 0o600 });
  }
}

module.exports = { SmsRateLimit };
