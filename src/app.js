'use strict';
// HTTP app. All external effects (xAI WS/REST, Twilio REST, Shopify, token exchange, notify) are injected,
// so the same code runs in demo (mocks) and production (real clients built in bin/server.js).
const { URL } = require('url');
const { readBody, safeEq, fp } = require('./util');
const { normNumber, resolveSecret } = require('./tenants');
const { WebhookVerifier, sipHeader, CallSession, buildInstructions } = require('./xai');
const { verifyTwilio, twiml } = require('./twilio');
const { Tools, Approvals, inHours } = require('./tools');
const { handleInboundSms } = require('./sms');
const ob = require('./onboarding');

function createApp(d) {
  // d: { tenants, secrets, env, consent, kbFor, shopifyFor, smsFor, callControlFor, openRealtime, brain,
  //      notify, log, publicBaseUrl, adminToken, stateSecret, shopifyApp:{clientId,secret}, exchange, now }
  const log = d.log || (() => {});
  const verifier = new WebhookVerifier({ now: d.clock });
  const approvals = d.approvals || new Approvals();
  const calls = new Map();
  const toolsFor = (t, callControl) => new Tools(t, { kbFor: d.kbFor, shopifyFor: d.shopifyFor, smsFor: d.smsFor, consent: d.consent, callControl: callControl || d.callControlFor(t), notify: d.notify, approvals, log, now: () => (d.now ? d.now() : new Date()) });
  const sec = (t, name) => resolveSecret(t, name, { env: d.env, store: d.secrets });
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const isAdmin = (req) => { const h = req.headers.authorization || ''; return !!d.adminToken && h.startsWith('Bearer ') && safeEq(h.slice(7), d.adminToken); };

  async function xaiWebhook(req, res) {
    const body = await readBody(req);
    let ev; try { ev = JSON.parse(body); } catch { return json(res, 400, { error: 'bad_json' }); }
    // Route by the dialed number (untrusted until the tenant's own secret verifies the signature).
    const to = normNumber(sipHeader(ev.data || {}, 'To') || '');
    const tenant = d.tenants.forNumber(to);
    const secret = tenant && sec(tenant, 'xai_webhook_secret');
    const v = verifier.verify(secret, req.headers, body);
    if (!tenant || !v.ok) { log('xai.webhook_rejected', { reason: tenant ? v.reason : 'unknown_number' }); return json(res, 401, { error: 'unauthorized' }); }
    if (ev.type !== 'realtime.call.incoming') return json(res, 200, { ignored: ev.type });
    const callId = ev.data.call_id; const caller = normNumber(sipHeader(ev.data, 'From') || '');
    d.consent.record(tenant.id, caller, 'inbound'); // calling first = opt-in to replies with requested links
    json(res, 200, { accepted: true });
    const ws = await d.openRealtime(tenant, callId);
    const afterHours = !inHours(tenant.hours, d.now ? d.now() : new Date());
    const cc = d.callControlFor(tenant);
    const session = new CallSession({ ws, tenant, callId, caller, tools: toolsFor(tenant, cc), afterHours, log,
      onEnd: (summary, transcript) => { calls.delete(callId); d.notify(tenant, { kind: 'call_summary', caller, ...summary, transcript }); } });
    calls.set(callId, session);
    log('call.started', { tenant: tenant.id, call: callId, from: fp(caller), afterHours });
  }

  async function twilioSms(req, res) {
    const body = await readBody(req);
    const params = Object.fromEntries(new URLSearchParams(body));
    const tenant = d.tenants.forNumber(params.To);
    const fullUrl = d.publicBaseUrl + req.url;
    if (!tenant || !verifyTwilio(sec(tenant, 'twilio_auth_token'), fullUrl, params, req.headers['x-twilio-signature'])) { log('twilio.webhook_rejected', {}); res.writeHead(403); return res.end(); }
    const from = normNumber(params.From);
    const reply = await handleInboundSms({ tenant, from, body: params.Body, consent: d.consent, toolsFor: (t) => toolsFor(t), brain: d.brain, instructions: buildInstructions(tenant, { afterHours: false }), log });
    log('sms.replied', { tenant: tenant.id, from: fp(from), chars: reply.length });
    res.writeHead(200, { 'content-type': 'text/xml' }); res.end(twiml(reply));
  }

  // Twilio voicemail fallback (Elastic SIP Trunk "disaster recovery URL"): plays a notice and records.
  async function voicemail(req, res) {
    const body = await readBody(req); const params = Object.fromEntries(new URLSearchParams(body));
    const tenant = d.tenants.forNumber(params.To || params.Called);
    if (!tenant || !verifyTwilio(sec(tenant, 'twilio_auth_token'), d.publicBaseUrl + req.url, params, req.headers['x-twilio-signature'])) { res.writeHead(403); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Thanks for calling ${tenant.name.replace(/[<>&]/g, '')}. Please leave a message after the tone. This call is recorded.</Say><Record maxLength="120" transcribe="true"/></Response>`);
  }

  async function admin(req, res, u) {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const m = u.pathname.match(/^\/admin\/tenants(?:\/([a-z0-9-]+)(?:\/(status|approvals))?)?$/);
    if (!m) return json(res, 404, { error: 'not_found' });
    if (req.method === 'POST' && !m[1]) {
      const t = JSON.parse(await readBody(req)); t.numbers = t.numbers || []; t.sms_enabled = false; // texting only after A2P approval
      const created = d.tenants.add(t); d.tenants.save(created); log('tenant.created', { tenant: created.id });
      return json(res, 201, { tenant: created.id, status: ob.onboardingStatus(created) });
    }
    const t = m[1] && d.tenants.get(m[1]); if (!t) return json(res, 404, { error: 'not_found' });
    if (m[2] === 'approvals') return json(res, 200, { approvals: approvals.list(t.id) });
    return json(res, 200, { tenant: t.id, status: ob.onboardingStatus(t) });
  }

  async function connect(req, res, u) {
    const q = Object.fromEntries(u.searchParams);
    if (u.pathname === '/connect/shopify/start') {
      if (!isAdmin(req) && !q.token) return json(res, 401, { error: 'unauthorized' });
      const t = d.tenants.get(q.tenant); if (!t) return json(res, 404, { error: 'not_found' });
      const url = ob.shopifyAuthorizeUrl({ shop: q.shop, clientId: d.shopifyApp.clientId, redirectUri: d.publicBaseUrl + '/connect/shopify/callback', state: ob.makeState(d.stateSecret, t.id, 'shopify') });
      res.writeHead(302, { location: url }); return res.end();
    }
    if (u.pathname === '/connect/shopify/callback') {
      const st = ob.readState(d.stateSecret, q.state, 'shopify');
      if (!st || !ob.shopifyCallbackValid(q, d.shopifyApp.secret) || !/^[a-z0-9-]+\.myshopify\.com$/.test(q.shop || '')) return json(res, 400, { error: 'invalid_callback' });
      const t = d.tenants.get(st.t);
      const tok = await d.exchange('shopify', { shop: q.shop, code: q.code });
      t.shopify = { shop: q.shop, mode: 'storefront', public_domain: t.shopify?.public_domain || null };
      t.secrets = { ...(t.secrets || {}), shopify_storefront_token: d.secrets.put(t.id, 'shopify_storefront_token', tok.storefront_token) };
      d.tenants.save(t); log('connect.shopify', { tenant: t.id, token: fp(tok.storefront_token) });
      return json(res, 200, { connected: 'shopify', tenant: t.id });
    }
    if (u.pathname === '/connect/twilio/start') {
      const t = d.tenants.get(q.tenant); if (!t || !isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
      res.writeHead(302, { location: `https://www.twilio.com/authorize/${encodeURIComponent(d.twilioConnectAppSid || 'CN_not_configured')}?state=${encodeURIComponent(ob.makeState(d.stateSecret, t.id, 'twilio'))}` }); return res.end();
    }
    if (u.pathname === '/connect/twilio/callback') {
      const st = ob.readState(d.stateSecret, q.state, 'twilio');
      if (!st || !/^AC[0-9a-f]{32}$/.test(q.AccountSid || '')) return json(res, 400, { error: 'invalid_callback' });
      const t = d.tenants.get(st.t); t.twilio = { account_sid: q.AccountSid, via: 'twilio_connect' }; d.tenants.save(t);
      log('connect.twilio', { tenant: t.id, account: fp(q.AccountSid) });
      return json(res, 200, { connected: 'twilio', tenant: t.id });
    }
    return json(res, 404, { error: 'not_found' });
  }

  const handler = async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && u.pathname === '/health') return json(res, 200, { ok: true, tenants: d.tenants.list().length, active_calls: calls.size, mode: d.mode || 'unknown' });
      if (req.method === 'POST' && u.pathname === '/xai/webhook') return await xaiWebhook(req, res);
      if (req.method === 'POST' && u.pathname === '/twilio/sms') return await twilioSms(req, res);
      if (req.method === 'POST' && u.pathname === '/twilio/voicemail') return await voicemail(req, res);
      if (u.pathname.startsWith('/admin/')) return await admin(req, res, u);
      if (u.pathname.startsWith('/connect/')) return await connect(req, res, u);
      return json(res, 404, { error: 'not_found' });
    } catch (e) { log('http.error', { path: u.pathname, err: e.message }); if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'internal_error' }); }
  };
  return { handler, approvals, calls };
}

module.exports = { createApp };
