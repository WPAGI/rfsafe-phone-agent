'use strict';
// Owner API wording follows the service's brand: callbots-bdo points to Best Deal On support; unbranded (RF Safe) unchanged.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { startApp } = require('./helpers');
const bdo = JSON.parse(fs.readFileSync(path.join(__dirname, '../deploy/bestdealon/tenants/bestdealon.json'), 'utf8'));
const TOK = 'bdo_7_' + 'a'.repeat(48);
const biz = (phone) => async (url) => ({ status: 200, json: async () => (url.endsWith('/api/v1/me') ? { user_id: 1, token: { id: 7, scopes: ['modules:read'], phone } } : {}) });
async function run(tenants, phone, p = '/status') {
  const a = await startApp(); a.deps.bizinatorFetch = biz(phone); if (tenants) a.deps.tenants.list = () => tenants;
  try { const r = await fetch(a.base + '/api/owner/v1' + p, { headers: { authorization: 'Bearer ' + TOK } }); return { status: r.status, j: await r.json() }; } finally { await a.close(); }
}
test('bdo service: no-phone-bot 404 points to Best Deal On support, no Quanta X Technology staff', async () => {
  const { status, j } = await run([bdo], '8135550100');
  assert.equal(status, 404); assert.equal(j.error, 'no_phone_bot');
  assert.equal(j.message, 'Your business does not have a phone bot connected yet. Best Deal On support (support@bestdealon.app) can set one up.');
});
test('bdo service: texting note names Best Deal On support', async () => {
  const { status, j } = await run([{ ...bdo }], String(bdo.bizinator_phone).replace(/\D/g, ''));
  assert.equal(status, 200); assert.match(j.channels.sms_note, /Best Deal On support \(support@bestdealon\.app\) turns it on\./);
  assert.doesNotMatch(JSON.stringify(j), /Quanta X Technology staff|coming soon/);
});
test('unbranded service (RF Safe): 404 wording unchanged', async () => {
  const { status, j } = await run(null, '8135550100');
  assert.equal(status, 404); assert.equal(j.message, 'Your business does not have a phone bot connected yet. Quanta X Technology staff can set one up.');
});
