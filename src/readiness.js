'use strict';
// Live-mode checklist. Values are never included, only whether each item is set.
const { resolveSecret } = require('./tenants');

const DEMO_ADMIN = 'demo-admin-token-EXAMPLE';

function masterKeyOk(value) {
  if (!value) return false;
  try { return Buffer.from(value, 'base64').length === 32; } catch { return false; }
}

function publicUrlOk(value) {
  return /^https:\/\/[^/\s]+(?::\d+)?$/.test(value || '');
}

function collectChecks({ env = {}, tenants = [], dataDir, dataWritable = false, mode = 'demo' }) {
  const checks = [];
  const add = (id, ok, required, detail) => checks.push({ id, ok: !!ok, required: !!required, detail });
  add('PUBLIC_BASE_URL', publicUrlOk(env.PUBLIC_BASE_URL), true, env.PUBLIC_BASE_URL ? 'must be the https origin with no path and no trailing slash' : 'missing');
  add('PA_ADMIN_TOKEN', !!env.PA_ADMIN_TOKEN && env.PA_ADMIN_TOKEN !== DEMO_ADMIN, true, !env.PA_ADMIN_TOKEN ? 'missing' : (env.PA_ADMIN_TOKEN === DEMO_ADMIN ? 'still the local demo token' : 'set'));
  add('PA_STATE_SECRET', !!env.PA_STATE_SECRET, true, env.PA_STATE_SECRET ? 'set' : 'missing');
  add('PA_MASTER_KEY', masterKeyOk(env.PA_MASTER_KEY), true, masterKeyOk(env.PA_MASTER_KEY) ? 'set' : 'missing or not 32 bytes base64');
  add('XAI_API_KEY', !!env.XAI_API_KEY, true, env.XAI_API_KEY ? 'set' : 'missing');
  add('DATA_DIR', !!env.DATA_DIR && dataWritable, true, !env.DATA_DIR ? 'missing' : (dataWritable ? 'writable' : 'not writable'));
  add('TENANTS_DIR', tenants.length > 0, true, tenants.length ? tenants.length + ' tenant file(s) loaded' : 'no tenant files loaded');
  for (const t of tenants) {
    for (const name of ['xai_webhook_secret', 'twilio_auth_token']) {
      const ref = (t.secrets || {})[name];
      if (!ref) { add('tenant:' + t.id + ':' + name, false, true, 'not declared on the tenant'); continue; }
      const resolved = !!resolveSecret(t, name, { env });
      add('tenant:' + t.id + ':' + name, resolved, true, resolved ? 'set' : 'reference ' + ref + ' is empty');
    }
    add('tenant:' + t.id + ':a2p_sms', !!t.sms_enabled, false, t.sms_enabled ? 'texting on' : 'sms_enabled is false until the A2P 10DLC campaign is approved');
    const example = !!(t._note && /EXAMPLE/.test(t._note));
    add('tenant:' + t.id + ':production_tenant', !example, false, example ? 'this file is EXAMPLE DATA; replace it before live calls' : 'production tenant file');
  }
  add('TWILIO_ACCOUNT_SID', !!(env.TWILIO_ACCOUNT_SID || env.RFSAFE_TWILIO_ACCOUNT_SID), false, (env.TWILIO_ACCOUNT_SID || env.RFSAFE_TWILIO_ACCOUNT_SID) ? 'set' : 'missing; the provision script needs it');
  add('RFSAFE_PHONE_NUMBER', !!(env.RFSAFE_PHONE_NUMBER || env.TWILIO_PHONE_NUMBER), false, (env.RFSAFE_PHONE_NUMBER || env.TWILIO_PHONE_NUMBER) ? 'set' : 'missing until the Twilio number is bought');
  add('SHOPIFY_STOREFRONT_TOKEN', !!(env.RFSAFE_SHOPIFY_STOREFRONT_TOKEN), false, env.RFSAFE_SHOPIFY_STOREFRONT_TOKEN ? 'set' : 'optional; public product JSON works without a token');
  const required = checks.filter((c) => c.required);
  return {
    service: 'callbots.org',
    business: 'Quanta X Technology',
    mode,
    data_dir_configured: !!env.DATA_DIR,
    ready_for_live: required.length > 0 && required.every((c) => c.ok),
    checks,
  };
}

function assertLiveReady(report) {
  const bad = report.checks.filter((c) => c.required && !c.ok);
  if (!bad.length) return;
  const lines = bad.map((c) => '- ' + c.id + ': ' + c.detail);
  throw new Error('live mode missing env: ' + bad.map((c) => c.id).join(', ') + '\n' + lines.join('\n'));
}

module.exports = { collectChecks, assertLiveReady, DEMO_ADMIN, publicUrlOk, masterKeyOk };
