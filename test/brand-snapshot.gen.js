'use strict';
// Builds every brand-bearing output for the RF Safe tenants. test/brand-snapshot.test.js compares this
// against test/fixtures/rfsafe-brand-snapshot.json (captured on main before the brand change).
const path = require('path'); const fs = require('fs');
const xai = require('../src/xai'); const sms = require('../src/sms'); const email = require('../src/email');
const { Tools } = require('../src/tools'); const readiness = require('../src/readiness'); const prov = require('../src/provision');
async function snapshot() {
  const out = {};
  const files = { deploy: path.join(__dirname, '../deploy/rfsafe.tenant.json'), demo: path.join(__dirname, '../demo/tenants/rfsafe.json') };
  for (const [k, f] of Object.entries(files)) {
    const { TenantRegistry } = require('../src/tenants'); const reg = new TenantRegistry(null);
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const variant of [{}, { email_enabled: true }, { email_enabled: true, sms_enabled: true }]) {
      const t = reg.add({ ...raw, ...variant, id: raw.id + '-' + Object.keys(variant).length, numbers: ['+1727555' + String(1000 + Object.keys(variant).length + (k === 'demo' ? 10 : 0))] });
      const key = k + ':' + Object.keys(variant).join('+');
      const sent = []; const emailer = { send: async (m) => { sent.push(m); return { ok: true }; } };
      const tools = new Tools(t, { kbFor: () => ({ answer: () => ({ found: false, guidance: 'g' }) }), sarFor: () => ({}), emailFor: () => emailer, log() {}, now: () => new Date('2026-10-29T14:00:00Z'), kbGapFile: null, approvals: { }, consent: { record() {}, optedOut: () => false, allowed: () => true } });
      const defs = tools.definitions();
      out[key] = {
        instructions: xai.buildInstructions(t, { afterHours: false }),
        instructionsAfter: xai.buildInstructions(t, { afterHours: true, callerLast4: '0142' }),
        session: xai.sessionUpdate(t, defs),
        sms: sms.buildSmsInstructions(t),
        shorten: sms.shortenWithOffer('A long answer. '.repeat(80) + ' https://rfsafe.org/x', t),
        leak: sms.fixLeakedInstructions('Offer to take a message.', t),
        unanswered: await tools.run('note_unanswered', { question: 'q' }, { channel: 'voice', callId: 'c1' }),
      };
    }
  }
  out.email = {
    plain: email.buildEmail({ links: [{ url: 'https://rfsafe.org/a', title: 'A' }], note: 'n', summary: null, name: 'Jo' }),
    summary: email.buildEmail({ links: [{ url: 'https://rfsafe.org/a' }], summary: 'P1\n\nP2', name: 'Jo', newsletter: { confirmUrl: 'https://x/c', unsubscribeUrl: 'https://x/u' } }),
    sub: email.buildEmail({ links: [{ url: 'https://rfsafe.org/a' }], summary: 'P1', name: 'Jo', newsletter: { subscriber: true, unsubscribeUrl: 'https://x/u' } }),
    subjects: [email.subjectFor('FCC limits', true), email.subjectFor('FCC limits', false), email.subjectFor('', true), email.subjectFor('', false)],
    from: email.FROM,
  };
  out.readiness = readiness.collectChecks({ env: { RFSAFE_PHONE_NUMBER: '+17276775572', RFSAFE_TWILIO_AUTH_TOKEN: 'x', TWILIO_ACCOUNT_SID: 'AC1' }, tenants: [], mode: 'demo' });
  out.provision = prov.buildProvisionPlan({ env: { RFSAFE_PHONE_NUMBER: '+17276775572', RFSAFE_TWILIO_AUTH_TOKEN: 'x', TWILIO_ACCOUNT_SID: 'AC1', XAI_API_KEY: 'k', PUBLIC_BASE_URL: 'https://e.test' } });
  return JSON.parse(JSON.stringify(out));
}
module.exports = { snapshot };
if (require.main === module) snapshot().then((s) => fs.writeFileSync(path.join(__dirname, 'fixtures/rfsafe-brand-snapshot.json'), JSON.stringify(s, null, 1) + '\n'));
