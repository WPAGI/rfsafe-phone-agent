'use strict';
// Outbound Twilio voice calls (REST). Live uses the tenant's Twilio credentials; demo/tests use MockVoice.
class TwilioVoiceRest {
  constructor({ accountSid, authToken, fetchImpl = globalThis.fetch }) { this.sid = accountSid; this.tok = authToken; this.fetch = fetchImpl; }
  async createCall({ from, to, url, statusCallback, timeout = 25 }) {
    const form = new URLSearchParams({ From: from, To: to, Url: url, Method: 'POST', Timeout: String(timeout), MachineDetection: 'DetectMessageEnd', MachineDetectionTimeout: '30' });
    if (statusCallback) { form.set('StatusCallback', statusCallback); form.set('StatusCallbackMethod', 'POST'); for (const e of ['completed']) form.append('StatusCallbackEvent', e); }
    const r = await this.fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Calls.json`, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(this.sid + ':' + this.tok).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: form });
    const j = await r.json(); if (!r.ok) throw new Error('twilio ' + r.status + ' ' + (j.code || '')); return { sid: j.sid };
  }
}
class MockVoice { constructor() { this.calls = []; } async createCall(c) { this.calls.push(c); return { sid: 'CA_mock_' + this.calls.length }; } }
module.exports = { TwilioVoiceRest, MockVoice };
