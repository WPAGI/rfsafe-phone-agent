'use strict';
// HTTP app. All external effects (xAI WS/REST, Twilio REST, Shopify, token exchange, notify) are injected,
// so the same code runs in demo (mocks) and production (real clients built in bin/server.js).
const { URL } = require('url');
const { readBody, safeEq, fp, appendJsonl } = require('./util');
const { normNumber, resolveSecret } = require('./tenants');
const { WebhookVerifier, sipHeader, callerIdFromSip, CallSession, buildInstructions } = require('./xai');
const { verifyTwilio, twiml } = require('./twilio');
const { Tools, Approvals, inHours } = require('./tools');
const { handleInboundSms } = require('./sms');
const { renderLanding, ROBOTS, SITEMAP } = require('./page');
const { faviconIco, FAVICON_SVG } = require('./favicon');
const { DEMO_ADMIN } = require('./readiness');
const ob = require('./onboarding');
const adm = require('./admin');

const CALL_END_TYPES = new Set(['realtime.call.ended', 'realtime.call.completed', 'realtime.call.failed']);

function createApp(d) {
  // d: { tenants, secrets, env, consent, kbFor, shopifyFor, smsFor, callControlFor, openRealtime, brain,
  //      notify, log, publicBaseUrl, adminToken, stateSecret, shopifyApp:{clientId,secret}, exchange, now }
  const log = d.log || (() => {});
  const verifier = new WebhookVerifier({ now: d.clock });
  const approvals = d.approvals || new Approvals();
  const calls = new Map();
  const now = () => (d.now ? d.now() : new Date());
  const toolsFor = (t, callControl) => new Tools(t, { kbFor: d.kbFor, shopifyFor: d.shopifyFor, smsFor: d.smsFor, consent: d.consent, callControl: callControl || d.callControlFor(t), notify: d.notify, approvals, log, now, rateLimit: d.rateLimit, websiteFetch: d.websiteFetch, sarFor: d.sarFor, emailFor: d.emailFor, emailLogFile: d.emailLogFile, kbGapFile: d.kbGapFile, newsletter: d.newsletter });
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
    const caller = callerIdFromSip(ev.data); // null when blocked/anonymous
    if (caller) d.consent.record(tenant.id, caller, 'inbound'); // calling first = opt-in to replies with requested links
    json(res, 200, { accepted: true });
    const ws = await d.openRealtime(tenant, callId);
    const afterHours = !inHours(tenant.hours, now());
    const cc = d.callControlFor(tenant);
    const session = new CallSession({ ws, tenant, callId, caller, tools: toolsFor(tenant, cc), afterHours, log,
      onEnd: (summary, transcript) => {
        calls.delete(callId);
        try { appendJsonl(d.callLog, { at: new Date().toISOString(), from: fp(caller), ...summary }); } catch (e) { log('call.log_error', { err: e.message }); }
        try { if (d.callRecords) d.callRecords.add(adm.callRecord(summary, caller, new Date().toISOString())); } catch (e) { log('call.record_error', { err: e.message }); }
        d.notify(tenant, { kind: 'call_summary', caller, ...summary, transcript });
      } });
    calls.set(callId, session);
    log('call.started', { tenant: tenant.id, call: callId, from: caller ? fp(caller) : 'withheld', afterHours });
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
    const m = u.pathname.match(/^\/admin\/tenants(?:\/([a-z0-9-]+)(?:\/(status|approvals|config|kb-bundle))?)?$/);
    if (!m) return json(res, 404, { error: 'not_found' });
    if (req.method === 'POST' && !m[1]) {
      const t = JSON.parse(await readBody(req)); t.numbers = t.numbers || []; t.sms_enabled = false; // texting only after A2P approval
      const created = d.tenants.add(t); d.tenants.save(created); log('tenant.created', { tenant: created.id });
      return json(res, 201, { tenant: created.id, status: ob.onboardingStatus(created) });
    }
    const t = m[1] && d.tenants.get(m[1]); if (!t) return json(res, 404, { error: 'not_found' });
    if (req.method === 'PATCH' && !m[2]) {
      // Content fields only. Numbers, secrets, payments and texting are not editable here (texting waits for A2P).
      const body = JSON.parse(await readBody(req)); const ALLOWED = ['link_allowlist', 'keyterms', 'extra_instructions', 'website', 'kb', 'sar_lookup', 'hours', 'transfer_target', 'owner_email', 'voice', 'disclosure', 'blocked_topics', 'shopify', 'order_lookup_enabled', 'known_callers', 'support_email', 'email_enabled'];
      const bad = Object.keys(body).filter((k) => !ALLOWED.includes(k)); if (bad.length) return json(res, 400, { error: 'field_not_editable', fields: bad });
      if ('email_enabled' in body && typeof body.email_enabled !== 'boolean') return json(res, 400, { error: 'invalid', detail: ['email_enabled must be boolean'] });
      if ('order_lookup_enabled' in body && typeof body.order_lookup_enabled !== 'boolean') return json(res, 400, { error: 'invalid', detail: ['order_lookup_enabled must be boolean'] });
      if ('shopify' in body && !validShopifyPatch(body.shopify)) return json(res, 400, { error: 'invalid', detail: ['shopify: {shop, mode: public|storefront, public_domain?, admin_shop?: *.myshopify.com} only'] });
      const next = { ...t, ...body };
      const errs = require('./tenants').validateTenant(next); if (errs.length) return json(res, 400, { error: 'invalid', detail: errs });
      if (typeof next.extra_instructions === 'string' && next.extra_instructions.length > 12000) return json(res, 400, { error: 'extra_instructions_too_long' });
      Object.assign(t, body); d.tenants.save(t); d.kbReset && d.kbReset(t.id); log('tenant.updated', { tenant: t.id, fields: Object.keys(body) });
      return json(res, 200, { tenant: t.id, updated: Object.keys(body), status: ob.onboardingStatus(t) });
    }
    if (m[2] === 'kb-bundle') {
      // Admin token only. Uploads the full Second Brain KB export; John approves each upload like a deploy.
      if (req.method !== 'PUT' || !d.kbBundleDir) return json(res, 405, { error: 'method_not_allowed' });
      const kbb = require('./kbbundle');
      try { const r = kbb.installBundle(await kbb.readRaw(req), d.kbBundleDir, t.id); d.kbReset && d.kbReset(t.id); log('kb.bundle_installed', { tenant: t.id, pages: r.pages }); return json(res, 200, { tenant: t.id, pages: r.pages, version: r.version, generated: r.generated }); }
      catch (e) { return json(res, e.status || 400, { error: 'bundle_rejected', detail: String(e.message).slice(0, 200) }); }
    }
    if (m[2] === 'approvals') return json(res, 200, { approvals: approvals.list(t.id) });
    if (m[2] === 'config') { const { secrets, ...rest } = t; return json(res, 200, { tenant: t.id, config: { ...rest, secrets: Object.keys(secrets || {}) } }); } // read-only; secret refs by name only
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

  // Newsletter double opt-in. GET shows a button only (link scanners never confirm); POST records.
  async function newsletterRoute(req, res, u) {
    const nlp = require('./newsletter'); const nl = d.newsletter;
    const page = (code, body) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'same-origin' }); res.end(body); };
    const unsub = u.pathname.endsWith('/unsubscribe'); const action = unsub ? 'unsub' : 'sub';
    if (!nl) return page(503, nlp.page('Not available', '<p>The newsletter is not available right now.</p>'));
    if (req.method === 'GET') {
      const tok = u.searchParams.get('t') || ''; if (!nl.verify(tok, action)) return page(400, nlp.page('Link expired or invalid', '<p>This link is invalid or has expired. Ask for a new one on your next call, or email support@quantaxtechnology.com.</p>'));
      return page(200, unsub ? nlp.formPage({ title: 'Unsubscribe', text: "Press the button to stop receiving RF Safe's monthly newsletter.", button: 'Unsubscribe me', action: '/newsletter/unsubscribe', tok }) : nlp.formPage({ title: 'Confirm your subscription', text: "Press the button to confirm you want RF Safe's monthly newsletter. You can unsubscribe at any time.", button: 'Confirm my newsletter subscription', action: '/newsletter/confirm', tok }));
    }
    if (req.method === 'POST') {
      const tok = new URLSearchParams(await readBody(req, 8192)).get('t') || u.searchParams.get('t') || '';
      const o = nl.verify(tok, action); if (!o) return page(400, nlp.page('Link expired or invalid', '<p>This link is invalid or has expired.</p>'));
      nl.record(o, unsub ? 'unsubscribed' : 'confirmed', unsub ? {} : { ip: clientIp(req), ua: req.headers['user-agent'] || '' }); log(unsub ? 'newsletter.unsubscribed' : 'newsletter.confirmed', { tenant: o.t, to: fp(o.e) });
      return page(200, unsub ? nlp.page('You are unsubscribed', "<p>You will not receive RF Safe's newsletter. Thank you.</p>") : nlp.page('Thank you!', "<p>You are subscribed to RF Safe's monthly newsletter. Every issue has an unsubscribe link.</p>"));
    }
    return json(res, 405, { error: 'method_not_allowed' });
  }

  // ---- Admin dashboard (session cookie via one-time email link; Bearer token still works for CSVs) ----
  function clientIp(req) { const x = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); return x || (req.socket && req.socket.remoteAddress) || ''; }
  const SEC_HEADERS = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" };
  const SC = 'HttpOnly; Secure; SameSite=Strict; Path=/admin';
  function adminUiSend(res, code, body, extra = {}, cookies = []) { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...SEC_HEADERS, ...extra, ...(cookies.length ? { 'set-cookie': cookies } : {}) }); res.end(body); }
  // Origin check (the CSRF token is always required as well). Accept an Origin matching this host or PUBLIC_BASE_URL.
  // A missing Origin, or "null" (sent by Chrome/Brave when the page's Referrer-Policy is no-referrer, or by privacy
  // settings), is accepted because the SameSite=Strict double-submit CSRF cookie+token must still match;
  // an explicit cross-site Sec-Fetch-Site is always rejected.
  function sameOrigin(req) {
    if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') return false;
    const o = req.headers.origin; if (!o || o === 'null') return true;
    let oh; try { oh = new URL(o); } catch { return false; }
    const fwdProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    if (d.publicBaseUrl) { try { if (oh.origin === new URL(d.publicBaseUrl).origin) return true; } catch {} }
    return oh.host === req.headers.host && (!fwdProto || oh.protocol === fwdProto + ':');
  }
  // Pre-session CSRF: double-submit cookie. Session CSRF: HMAC bound to the session id.
  function preCsrf(req) { const c = adm.parseCookies(req.headers.cookie).pa_csrf; return c && /^[A-Za-z0-9_-]{20,}$/.test(c) ? { tok: c, set: [] } : (() => { const t = require('crypto').randomBytes(24).toString('base64url'); return { tok: t, set: [`pa_csrf=${t}; ${SC}; Max-Age=3600`] }; })(); }
  async function adminUi(req, res, u) {
    const auth = d.adminAuth; if (!auth) return json(res, 503, { error: 'admin_unavailable' });
    const cookies = adm.parseCookies(req.headers.cookie);
    const sess = auth.session(cookies.pa_admin);
    const p = u.pathname;
    const form = async () => (req.method === 'POST' ? Object.fromEntries(new URLSearchParams(await readBody(req, 8192))) : {});
    if (p === '/admin/login') {
      if (req.method === 'GET') { const c = preCsrf(req); return adminUiSend(res, 200, adm.loginPage(c.tok), {}, c.set); }
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
      const f = await form();
      if (!sameOrigin(req) || !cookies.pa_csrf || !f.csrf || !safeEq(f.csrf, cookies.pa_csrf)) return adminUiSend(res, 403, adm.msgPage('Request blocked', 'Please reload the sign-in page and try again.'));
      const tok = auth.issueLink();
      if (!tok) { log('admin.login_rate_limited', {}); return adminUiSend(res, 429, adm.msgPage('Too many sign-in links', 'Three links were already sent in the last 15 minutes. Use one of those or try again later.')); }
      const link = (d.publicBaseUrl || '').replace(/\/$/, '') + '/admin/auth?t=' + tok;
      const text = `Someone asked to sign in to the CallBots admin dashboard.\n\nSign in (works once, expires in 15 minutes):\n${link}\n\nIf this was not you, ignore this email.`;
      const html = `<p>Someone asked to sign in to the CallBots admin dashboard.</p><p><a href="${link}" style="display:inline-block;padding:10px 16px;background:#0b5;color:#fff;text-decoration:none;border-radius:6px">Open the sign-in page</a></p><p>The link works once and expires in 15 minutes. If this was not you, ignore this email.</p>`;
      let r; try { r = await d.emailFor(null).send({ to: auth.email, subject: 'Your callbots.org admin sign-in link', text, html }); } catch (e) { r = { ok: false, reason: e.message }; }
      log('admin.login_link', { ok: !!(r && r.ok), reason: r && !r.ok ? r.reason : undefined });
      if (r && r.ok) { const nonce = require('crypto').randomBytes(16).toString('base64'); return adminUiSend(res, 200, adm.sentPage(cookies.pa_csrf, nonce, auth.email), { 'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'` }); }
      return adminUiSend(res, r && r.ok ? 200 : 502, r && r.ok ? adm.msgPage('Check the admin inbox', 'A sign-in link was sent to the admin email address. It works once and expires in 15 minutes.') : adm.msgPage('Could not send', 'The sign-in email could not be sent. Try again shortly.'));
    }
    if (p === '/admin/auth') {
      if (req.method === 'GET') { const tok = u.searchParams.get('t') || ''; if (!auth.checkLink(tok)) return adminUiSend(res, 400, adm.msgPage('Link expired or used', 'This sign-in link is invalid, used, or expired. Request a new one.')); const c = preCsrf(req); return adminUiSend(res, 200, adm.authPage(c.tok, tok), {}, c.set); }
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
      const f = await form();
      if (!sameOrigin(req) || !cookies.pa_csrf || !f.csrf || !safeEq(f.csrf, cookies.pa_csrf)) return adminUiSend(res, 403, adm.msgPage('Request blocked', 'Open the link from the email again and press Sign in.'));
      if (!auth.consumeLink(f.t)) { log('admin.login_failed', {}); return adminUiSend(res, 400, adm.msgPage('Link expired or used', 'This sign-in link is invalid, used, or expired. Request a new one.')); }
      log('admin.login', { ip: fp(clientIp(req)) });
      return adminUiSend(res, 303, '', { location: '/admin' }, [`pa_admin=${auth.newSession()}; ${SC}; Max-Age=${adm.SESSION_MS / 1000}`, `pa_csrf=; ${SC}; Max-Age=0`]);
    }
    if (p === '/admin/logout') {
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
      const f = await form();
      if (!sess || !sameOrigin(req) || !f.csrf || !safeEq(f.csrf, auth.csrfFor(sess.sid))) return adminUiSend(res, 403, adm.msgPage('Request blocked', 'Reload the dashboard and try again.'));
      auth.revoke(sess.sid); log('admin.logout', {});
      return adminUiSend(res, 303, '', { location: '/admin/login' }, [`pa_admin=; ${SC}; Max-Age=0`]);
    }
    // Data views: session cookie, or Bearer admin token for scripts.
    if (!sess && !isAdmin(req)) return p === '/admin' && /text\/html/.test(req.headers.accept || '') ? adminUiSend(res, 303, '', { location: '/admin/login' }) : json(res, 401, { error: 'unauthorized' });
    if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
    const q = { from: /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('from') || '') ? u.searchParams.get('from') : '', to: /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('to') || '') ? u.searchParams.get('to') : '', number: (u.searchParams.get('number') || '').replace(/[^\d+]/g, '').slice(0, 16) };
    const nlRows = d.newsletterFile ? adm.newsletterRows(d.newsletterFile) : [];
    const calls = adm.filterCalls(d.callRecords ? d.callRecords.read() : [], q);
    const csv = (name, body) => { res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, ...SEC_HEADERS }); res.end(body); };
    if (p === '/admin/newsletter.csv') return csv('newsletter.csv', adm.toCsv(adm.NL_COLS, nlRows));
    if (p === '/admin/kb-gaps.csv') return csv('kb-gaps.csv', adm.toCsv(['at', 'tenant', 'channel', 'reason', 'question'], readGaps(d.kbGapFile)));
    if (p === '/admin/calls.csv') return csv('calls.csv', adm.toCsv(adm.CALL_COLS, adm.callCsvRows(calls)));
    const nowMs = now().getTime ? now().getTime() : Date.now();
    return adminUiSend(res, 200, adm.dashboard({ csrf: sess ? auth.csrfFor(sess.sid) : '', nl: nlRows, calls, q, now: nowMs }));
  }
  const ADMIN_UI = new Set(['/admin/login', '/admin/auth', '/admin/logout', '/admin/newsletter.csv', '/admin/calls.csv', '/admin/kb-gaps.csv']);

  const handler = async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && u.pathname === '/') return html(res, 200, renderLanding());
      if (req.method === 'GET' && (u.pathname === '/privacy' || u.pathname === '/privacy-policy')) return html(res, 200, require('./legal').renderPrivacy());
      if (req.method === 'GET' && (u.pathname === '/terms' || u.pathname === '/terms-of-service')) return html(res, 200, require('./legal').renderTerms());
      if (req.method === 'GET' && u.pathname === '/robots.txt') return bytes(res, 200, 'text/plain; charset=utf-8', ROBOTS);
      if (req.method === 'GET' && u.pathname === '/sitemap.xml') return bytes(res, 200, 'application/xml; charset=utf-8', SITEMAP);
      if (req.method === 'GET' && (u.pathname === '/favicon.svg' || u.pathname === '/favicon')) return bytes(res, 200, 'image/svg+xml; charset=utf-8', FAVICON_SVG);
      if (req.method === 'GET' && u.pathname === '/favicon.ico') return bytes(res, 200, 'image/x-icon', faviconIco());
      if (req.method === 'GET' && u.pathname === '/health') return json(res, 200, { ok: true, tenants: d.tenants.list().length, active_calls: calls.size, mode: d.mode || 'unknown' });
      if (u.pathname === '/admin' && req.method === 'GET' && (req.headers.authorization || '').startsWith('Bearer ')) return adminStatus(req, res);
      if (req.method === 'GET' && u.pathname === '/admin/status') return adminStatus(req, res);
      if (u.pathname === '/admin' || ADMIN_UI.has(u.pathname)) return await adminUi(req, res, u);
      if (req.method === 'POST' && u.pathname === '/xai/webhook') return await xaiWebhook(req, res);
      if (req.method === 'POST' && u.pathname === '/twilio/sms') return await twilioSms(req, res);
      if (req.method === 'POST' && u.pathname === '/twilio/sms/status') return await twilioStatus(req, res);
      if (req.method === 'POST' && (u.pathname === '/twilio/voice' || u.pathname === '/twilio/voicemail')) return await voice(req, res);
      if (req.method === 'POST' && u.pathname === '/twilio/voice/recording') return await recording(req, res);
      if (u.pathname === '/newsletter/confirm' || u.pathname === '/newsletter/unsubscribe') return await newsletterRoute(req, res, u);
      if (req.method === 'GET' && u.pathname === '/admin/newsletter/subscribers') { if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' }); const subs = d.newsletter ? d.newsletter.subscribers() : []; return json(res, 200, { count: subs.length, subscribers: subs }); }
      if (u.pathname.startsWith('/admin/')) return await admin(req, res, u);
      if (u.pathname.startsWith('/connect/')) return await connect(req, res, u);
      return json(res, 404, { error: 'not_found' });
    } catch (e) { log('http.error', { path: u.pathname, err: e.message }); if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'internal_error' }); }
  };
  return { handler, approvals, calls };
}

function readGaps(f) { try { return require('fs').readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } }
module.exports = { createApp };

// shopify via PATCH: domains and mode only. Credentials stay in env/secret store, never in the request.
function validShopifyPatch(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if (Object.keys(v).some((k) => !['shop', 'mode', 'public_domain', 'admin_shop'].includes(k))) return false;
  const dom = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
  if (!dom.test(v.shop || '') || !['public', 'storefront'].includes(v.mode)) return false;
  if (v.public_domain != null && !dom.test(v.public_domain)) return false;
  if (v.admin_shop != null && !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(v.admin_shop)) return false;
  return true;
}

