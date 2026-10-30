'use strict';
// HTTP app. All external effects (xAI WS/REST, Twilio REST, Shopify, token exchange, notify) are injected,
// so the same code runs in demo (mocks) and production (real clients built in bin/server.js).
const { URL } = require('url');
const { readBody, safeEq, fp, appendJsonl } = require('./util');
const { normNumber, resolveSecret } = require('./tenants');
const { WebhookVerifier, sipHeader, CallSession, buildInstructions } = require('./xai');
const { verifyTwilio, twiml } = require('./twilio');
const { Tools, Approvals, inHours } = require('./tools');
const { handleInboundSms } = require('./sms');
const { renderLanding, ROBOTS, SITEMAP } = require('./page');
const { faviconIco, FAVICON_SVG } = require('./favicon');
const { DEMO_ADMIN } = require('./readiness');
const ob = require('./onboarding');

const CALL_END_TYPES = new Set(['realtime.call.ended', 'realtime.call.completed', 'realtime.call.failed']);

function createApp(d) {
  // d: { tenants, secrets, env, consent, kbFor, shopifyFor, smsFor, callControlFor, openRealtime, brain,
  //      notify, log, publicBaseUrl, adminToken, stateSecret, shopifyApp:{clientId,secret}, exchange, now }
  const log = d.log || (() => {});
  const verifier = new WebhookVerifier({ now: d.clock });
  const approvals = d.approvals || new Approvals();
  const calls = new Map();
  const now = () => (d.now ? d.now() : new Date());
  const toolsFor = (t, callControl) => new Tools(t, { kbFor: d.kbFor, shopifyFor: d.shopifyFor, smsFor: d.smsFor, consent: d.consent, callControl: callControl || d.callControlFor(t), notify: d.notify, approvals, log, now, rateLimit: d.rateLimit, websiteFetch: d.websiteFetch });
  const sec = (t, name) => resolveSecret(t, name, { env: d.env, store: d.secrets });
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const html = (res, code, body) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' }); res.end(body); };
  const bytes = (res, code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' }); res.end(body); };
  const loopback = (host) => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host || '');
  const isAdmin = (req) => {
    const h = req.headers.authorization || '';
    if (!d.adminToken || !h.startsWith('Bearer ') || !safeEq(h.slice(7), d.adminToken)) return false;
    if (d.adminToken === DEMO_ADMIN && !loopback(req.headers.host)) return false;
    return true;
  };
  const tenantForTwilio = (params) => { for (const n of [params.To, params.Called, params.From]) { const t = n && d.tenants.forNumber(n); if (t) return t; } return null; };
  async function readTwilio(req) {
    const body = await readBody(req);
    const params = Object.fromEntries(new URLSearchParams(body));
    const url = d.publicBaseUrl + req.url;
    const tenant = tenantForTwilio(params);
    const ok = !!(tenant && verifyTwilio(sec(tenant, 'twilio_auth_token'), url, params, req.headers['x-twilio-signature']));
    return { params, tenant, ok };
  }
  function xmlEscape(s) { return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])); }
  function voiceTwiml(tenant) {
    const away = !inHours(tenant.hours, now());
    const name = xmlEscape(tenant.name);
    const action = xmlEscape(d.publicBaseUrl + '/twilio/voice/recording');
    const hours = away ? ' The team is away right now.' : '';
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Thanks for calling ${name}. This call may be recorded and is answered by an AI assistant.${hours} The assistant is unavailable, so please leave a message after the tone. We never take payment by phone.</Say><Record maxLength="120" playBeep="true" transcribe="true" action="${action}" method="POST"/></Response>`;
  }

  async function xaiWebhook(req, res) {
    const body = await readBody(req);
    let ev; try { ev = JSON.parse(body); } catch { return json(res, 400, { error: 'bad_json' }); }
    // Route by the dialed number (untrusted until the tenant's own secret verifies the signature).
    const to = normNumber(sipHeader(ev.data || {}, 'To') || '');
    const tenant = d.tenants.forNumber(to);
    const secret = tenant && sec(tenant, 'xai_webhook_secret');
    const v = verifier.verify(secret, req.headers, body);
    if (!tenant || !v.ok) { log('xai.webhook_rejected', { reason: tenant ? v.reason : 'unknown_number' }); return json(res, 401, { error: 'unauthorized' }); }
    log('xai.webhook_verified', { tenant: tenant.id, type: ev.type || 'unknown' });
    const callId = ev.data && ev.data.call_id;
    if (CALL_END_TYPES.has(ev.type)) {
      const session = callId && calls.get(callId);
      if (session && !session.closed) session.finish();
      log('call.ended_webhook', { tenant: tenant.id, call: callId || null, type: ev.type });
      return json(res, 200, { ok: true });
    }
    if (ev.type !== 'realtime.call.incoming') return json(res, 200, { ignored: ev.type });
    const caller = normNumber(sipHeader(ev.data, 'From') || '');
    d.consent.record(tenant.id, caller, 'inbound'); // calling first = opt-in to replies with requested links
    json(res, 200, { accepted: true });
    const ws = await d.openRealtime(tenant, callId);
    const afterHours = !inHours(tenant.hours, now());
    const cc = d.callControlFor(tenant);
    const session = new CallSession({ ws, tenant, callId, caller, tools: toolsFor(tenant, cc), afterHours, log,
      onEnd: (summary, transcript) => {
        calls.delete(callId);
        try { appendJsonl(d.callLog, { at: new Date().toISOString(), from: fp(caller), ...summary }); } catch (e) { log('call.log_error', { err: e.message }); }
        d.notify(tenant, { kind: 'call_summary', caller, ...summary, transcript });
      } });
    calls.set(callId, session);
    log('call.started', { tenant: tenant.id, call: callId, from: fp(caller), afterHours });
  }

  async function twilioStatus(req, res) {
    const { params, tenant, ok } = await readTwilio(req);
    if (!ok) { log('twilio.webhook_rejected', { route: 'sms_status' }); res.writeHead(403); return res.end(); }
    log('sms.status', { tenant: tenant.id, sid: params.MessageSid || null, status: params.MessageStatus || null, error_code: params.ErrorCode || null });
    res.writeHead(204); res.end();
  }

  async function voice(req, res) {
    const { params, tenant, ok } = await readTwilio(req);
    if (!ok) { log('twilio.webhook_rejected', { route: 'voice' }); res.writeHead(403); return res.end(); }
    log('voice.fallback', { tenant: tenant.id, call: params.CallSid || null, from: fp(normNumber(params.From)), afterHours: !inHours(tenant.hours, now()) });
    res.writeHead(200, { 'content-type': 'text/xml' }); res.end(voiceTwiml(tenant));
  }

  async function recording(req, res) {
    const { params, tenant, ok } = await readTwilio(req);
    if (!ok) { log('twilio.webhook_rejected', { route: 'recording' }); res.writeHead(403); return res.end(); }
    const caller = normNumber(params.From);
    log('voicemail.saved', { tenant: tenant.id, call: params.CallSid || null, recording: params.RecordingSid || null, from: fp(caller) });
    await d.notify(tenant, { kind: 'voicemail', from: caller, call: params.CallSid || null, recording: params.RecordingSid || null, at: new Date().toISOString() });
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Thank you. Your message was saved for ${xmlEscape(tenant.name)}.</Say><Hangup/></Response>`);
  }

  async function twilioSms(req, res) {
    const { params, tenant, ok } = await readTwilio(req);
    if (!ok) { log('twilio.webhook_rejected', { route: 'sms' }); res.writeHead(403); return res.end(); }
    const from = normNumber(params.From);
    const reply = await handleInboundSms({ tenant, from, body: params.Body, consent: d.consent, toolsFor: (t) => toolsFor(t), brain: d.brain, instructions: buildInstructions(tenant, { afterHours: false }), log });
    log('sms.replied', { tenant: tenant.id, from: fp(from), chars: reply.length });
    res.writeHead(200, { 'content-type': 'text/xml' }); res.end(twiml(reply));
  }

  function adminStatus(req, res) {
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    const report = d.readiness ? d.readiness() : { checks: [] };
    const tenants = d.tenants.list().map((t) => ({ id: t.id, sms_enabled: !!t.sms_enabled, shopify: t.shopify ? t.shopify.mode : null, kb: !!(t.kb && (t.kb.dirs || t.kb.collection_id)), numbers: (t.numbers || []).length }));
    return json(res, 200, { ...report, tenants });
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
      if (req.method === 'GET' && u.pathname === '/') return html(res, 200, renderLanding());
      if (req.method === 'GET' && u.pathname === '/robots.txt') return bytes(res, 200, 'text/plain; charset=utf-8', ROBOTS);
      if (req.method === 'GET' && u.pathname === '/sitemap.xml') return bytes(res, 200, 'application/xml; charset=utf-8', SITEMAP);
      if (req.method === 'GET' && (u.pathname === '/favicon.svg' || u.pathname === '/favicon')) return bytes(res, 200, 'image/svg+xml; charset=utf-8', FAVICON_SVG);
      if (req.method === 'GET' && u.pathname === '/favicon.ico') return bytes(res, 200, 'image/x-icon', faviconIco());
      if (req.method === 'GET' && u.pathname === '/health') return json(res, 200, { ok: true, tenants: d.tenants.list().length, active_calls: calls.size, mode: d.mode || 'unknown' });
      if (req.method === 'GET' && (u.pathname === '/admin' || u.pathname === '/admin/status')) return adminStatus(req, res);
      if (req.method === 'POST' && u.pathname === '/xai/webhook') return await xaiWebhook(req, res);
      if (req.method === 'POST' && u.pathname === '/twilio/sms') return await twilioSms(req, res);
      if (req.method === 'POST' && u.pathname === '/twilio/sms/status') return await twilioStatus(req, res);
      if (req.method === 'POST' && (u.pathname === '/twilio/voice' || u.pathname === '/twilio/voicemail')) return await voice(req, res);
      if (req.method === 'POST' && u.pathname === '/twilio/voice/recording') return await recording(req, res);
      if (u.pathname.startsWith('/admin/')) return await admin(req, res, u);
      if (u.pathname.startsWith('/connect/')) return await connect(req, res, u);
      return json(res, 404, { error: 'not_found' });
    } catch (e) { log('http.error', { path: u.pathname, err: e.message }); if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'internal_error' }); }
  };
  return { handler, approvals, calls };
}

module.exports = { createApp };
