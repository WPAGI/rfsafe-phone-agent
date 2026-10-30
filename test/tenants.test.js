'use strict';
const test = require('node:test'); const assert = require('node:assert'); const crypto = require('crypto');
const { TenantRegistry, SecretStore, resolveSecret, validateTenant, normNumber } = require('../src/tenants');
const base = { id: 't1', name: 'T1', numbers: ['+15555550001'], link_allowlist: ['example.com'] };
test('tenant validation rejects inline secrets and payments', () => {
  assert.deepStrictEqual(validateTenant(base), []);
  assert.ok(validateTenant({ ...base, secrets: { twilio_auth_token: 'abc123' } }).join().includes('reference'));
  assert.ok(validateTenant({ ...base, payments_enabled: true }).join().includes('never'));
  assert.ok(validateTenant({ ...base, link_allowlist: ['https://example.com/'] }).length);
  assert.ok(validateTenant({ ...base, transfer_target: '7275550100' }).length);
});
test('a number can belong to only one tenant; lookup normalises formats', () => {
  const r = new TenantRegistry(); r.add(base);
  assert.throws(() => r.add({ ...base, id: 't2' }), /already assigned/);
  assert.strictEqual(r.forNumber('sip:+15555550001@sip.voice.x.ai').id, 't1');
  assert.strictEqual(r.forNumber('(555) 555-0001').id, 't1');
  assert.strictEqual(normNumber('tel:15555550001'), '+15555550001');
});
test('secret store is per-tenant (AAD bound) and env refs resolve only declared names', () => {
  const s = new SecretStore(null, crypto.randomBytes(32).toString('base64'));
  s.put('a', 'tok', 'secret-A');
  assert.strictEqual(s.get('a', 'tok'), 'secret-A'); assert.strictEqual(s.get('b', 'tok'), null);
  s.data['b.tok'] = s.data['a.tok']; // copy ciphertext across tenants
  assert.throws(() => s.get('b', 'tok'));
  const t = { id: 'a', secrets: { x: 'env:A_X' } };
  assert.strictEqual(resolveSecret(t, 'x', { env: { A_X: 'v', B_X: 'w' } }), 'v');
  assert.strictEqual(resolveSecret(t, 'y', { env: { A_X: 'v' } }), null);
});
