'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { EventEmitter } = require('events');
const bdo = require('../src/bdoverify');
const SECRET = 'test-shared-secret';
const tenants = { list: () => [{ id: 'bestdealon', numbers: ['+17276320002'] }, { id: 'rfsafe', numbers: ['+17276775572'] }] };
function req(method, url, body, headers = {}) { const r = new EventEmitter(); r.method = method; r.url = url; r.headers = headers; process.nextTick(() => { r.emit('data', Buffer.from(body)); r.emit('end'); }); return r; }
function res() { const o = { code: 0, body: '', writeHead(c) { o.code = c; }, end(b) { o.body = b || ''; } }; return o; }
async function call(v, body, sig = SECRET) { const b = JSON.stringify(body); const r = res(); await v.route(req('POST', '/bdo/verify-call', b, { 'x-bdo-signature': bdo.sign(sig, Math.floor(Date.now() / 1000), b) }), r, new URL('http://x/bdo/verify-call')); return { code: r.code, j: JSON.parse(r.body) }; }
const good = { tenant: 'bestdealon', to: '+17275550100', listing_phone: '7275550100', mode: 'read', code: '123456', ref: '1', business: 'Test Shop' };

test('flag off (default): no call', async () => { const drv = new bdo.DryRunCallDriver(); const v = bdo.createBdoVerify({ env: { BDO_CALLBOT_SHARED_SECRET: SECRET }, tenants, driver: drv }); assert.strictEqual((await call(v, good)).code, 403); assert.strictEqual(drv.placed.length, 0); });
test('dryrun: signed request dials only the listing number from the BDO number', async () => {
  const drv = new bdo.DryRunCallDriver(); const v = bdo.createBdoVerify({ env: { BDO_VERIFY_CALLS: 'dryrun', BDO_CALLBOT_SHARED_SECRET: SECRET }, tenants, driver: drv, publicBaseUrl: 'https://bot' });
  assert.strictEqual((await call(v, good, 'wrong')).code, 401, 'bad signature');
  assert.strictEqual((await call(v, { ...good, to: '+15555550123' })).code, 422, 'to must equal listing number');
  assert.strictEqual((await call(v, { ...good, to: '+17276775572', listing_phone: '7276775572' })).code, 403, 'RF Safe refused');
  assert.strictEqual((await call(v, { ...good, to: '+17276320002', listing_phone: '7276320002' })).code, 403, 'own number refused');
  assert.strictEqual((await call(v, { ...good, tenant: 'rfsafe' })).code, 403, 'other tenant refused');
  const r = await call(v, good); assert.strictEqual(r.code, 200); assert.strictEqual(drv.placed.length, 1);
  assert.strictEqual(drv.placed[0].to, '+17275550100'); assert.strictEqual(drv.placed[0].from, '+17276320002'); assert.match(drv.placed[0].twiml, /1, 2, 3, 4, 5, 6/);
  await call(v, good); await call(v, good); assert.strictEqual((await call(v, good)).code, 429, 'per-number hourly limit');
});
test('keyin TwiML gathers 6 digits to the gather URL, no code spoken', () => {
  const x = bdo.verifyTwiml({ mode: 'keyin', code: null, business: 'A & B', gatherUrl: 'https://bot/bdo/verify-gather?l=7275550100&r=1' });
  assert.match(x, /<Gather input="dtmf" numDigits="6"/); assert.match(x, /A &amp; B/); assert.match(x, /l=7275550100&amp;r=1/);
});
test('gather: Twilio-signed only, To must match listing, posts digits to the site', async () => {
  const seen = []; const site = { verifyCheck: async (l, c) => { seen.push([l, c]); return { ok: c === '123456' }; } };
  let sigOk = false; const v = bdo.createBdoVerify({ env: { BDO_VERIFY_CALLS: 'dryrun' }, tenants, site, verifyTwilio: () => sigOk });
  const go = async (body, q = '?l=7275550100') => { const r = res(); await v.route(req('POST', '/bdo/verify-gather' + q, body), r, new URL('http://x/bdo/verify-gather' + q)); return r; };
  assert.strictEqual((await go('To=%2B17275550100&Digits=123456')).code, 403, 'unsigned refused'); sigOk = true;
  assert.strictEqual((await go('To=%2B15555550000&Digits=123456')).code, 403, 'To mismatch refused');
  const r = await go('To=%2B17275550100&Digits=123456'); assert.match(r.body, /now verified/); assert.deepStrictEqual(seen, [['7275550100', '123456']]);
});
test('signature helpers: stale and tampered refused', () => {
  const t = Math.floor(Date.now() / 1000); assert.ok(bdo.verifySig(SECRET, bdo.sign(SECRET, t, 'x'), 'x', t));
  assert.ok(!bdo.verifySig(SECRET, bdo.sign(SECRET, t - 400, 'x'), 'x', t)); assert.ok(!bdo.verifySig(SECRET, bdo.sign(SECRET, t, 'x'), 'y', t)); assert.ok(!bdo.verifySig('', bdo.sign('', t, 'x'), 'x', t));
});
test('claim tools: only bestdealon + bdo_claims + flag on; yes required; pending only', async () => {
  const calls = []; const site = { configured: () => true, callerLookup: async (c) => { calls.push(['lookup', c]); return { eligible: true, name: 'Test Shop' }; }, claim: async (c) => { calls.push(['claim', c]); return { ok: true, say: 'saved' }; } };
  const bt = { id: 'bestdealon', bdo_claims: true };
  assert.ok(!bdo.claimToolsEnabled(bt, {}, site), 'flag off'); assert.ok(!bdo.claimToolsEnabled({ id: 'rfsafe', bdo_claims: true }, { BDO_INBOUND_CLAIM: 'on' }, site), 'RF Safe never');
  assert.ok(!bdo.claimToolsEnabled({ id: 'bestdealon' }, { BDO_INBOUND_CLAIM: 'on' }, site), 'tenant opt-in needed'); assert.ok(bdo.claimToolsEnabled(bt, { BDO_INBOUND_CLAIM: 'on' }, site));
  const ctx = { channel: 'voice', caller: '+17275550100' };
  assert.deepStrictEqual(await bdo.runClaimTool('bdo_listing_for_caller', {}, ctx, site), { ok: true, eligible: true, name: 'Test Shop', pending_claim: false });
  assert.strictEqual((await bdo.runClaimTool('bdo_start_claim', {}, ctx, site)).error, 'needs_yes');
  assert.strictEqual((await bdo.runClaimTool('bdo_start_claim', { caller_said_yes: true }, ctx, site)).claim, 'pending');
  assert.strictEqual((await bdo.runClaimTool('bdo_start_claim', { caller_said_yes: true }, { channel: 'sms', caller: '+17275550100' }, site)).error, 'voice_only');
  assert.deepStrictEqual(calls, [['lookup', '+17275550100'], ['claim', '+17275550100']]);
});
test('Tools exposes claim tools only when enabled, RF Safe definitions unchanged', () => {
  const { Tools } = require('../src/tools'); const site = { configured: () => true };
  const names = (t, env) => new Tools(t, { env, bdoSite: site }).definitions().map((d) => d.name);
  assert.ok(names({ id: 'bestdealon', bdo_claims: true }, { BDO_INBOUND_CLAIM: 'on' }).includes('bdo_start_claim'));
  assert.ok(!names({ id: 'rfsafe', bdo_claims: true }, { BDO_INBOUND_CLAIM: 'on' }).some((n) => n.startsWith('bdo_')));
});
