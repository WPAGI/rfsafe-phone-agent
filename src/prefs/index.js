'use strict';
// PREFERENCES ROUTES - v1.0
// Public /preferences: sign in by email magic link (or SMS code when texting is enabled), then manage
// newsletter, support texts and news-and-sales texts, or unsubscribe from everything. Every sign-in request gets
// the same generic answer, so nobody can tell which addresses or numbers are on file.
const { readBody, fp } = require('../util');
const { PrefsCore, normEmail, normPhone, FREQS, cleanPersonName, firstWord } = require('./core');
const { h, pageHtml, entryBody, sentBody, codeBody, continueBody, manageBody, msgBody } = require('./page');

const GENERIC_EMAIL = 'If that address is on file or can receive email, we sent a sign-in link. It works once, for 15 minutes.';
const GENERIC_CODE = 'If that number can receive texts, we sent a 6-digit code. It works once, for 15 minutes.';
const COOKIE = 'prefs_sid';
const parseCookies = (h) => { const o = {}; for (const p of String(h || '').split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } return o; };
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
const HDR = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' };

// d: app deps (tenants, newsletter, consent, emailFor, smsFor, env, publicBaseUrl, dataDir, now). site: sites/<id>.js
function createPrefs(d, site, { log = () => {} } = {}) {
  const env = d.env || process.env; const nowMs = () => { const n = d.now ? d.now() : Date.now(); return typeof n === 'number' ? n : n.getTime(); };
  const core = d.prefsCore || new PrefsCore({ dir: d.dataDir, site, env, now: nowMs });
  const tenant = () => d.tenants.list().find((t) => t.id === site.tenant) || null;
  // Feature flag: text controls only when PREFS_SMS_ENABLED=1 AND the tenant has texting switched on (A2P approved).
  // Sites with an approved texting program can default the flag on (site.smsDefaultOn); PREFS_SMS_ENABLED=0 still turns it off.
  const smsFlag = () => { const v = String(env.PREFS_SMS_ENABLED == null ? '' : env.PREFS_SMS_ENABLED); return site.smsDefaultOn ? v !== '0' : v === '1'; };
  const smsOn = () => smsFlag() && !!(tenant() && tenant().sms_enabled);
  const base = () => String(d.publicBaseUrl || '').replace(/\/$/, '');
  const send = (res, code, body, cookies) => { res.writeHead(code, { ...HDR, ...(cookies ? { 'set-cookie': cookies } : {}) }); res.end(pageHtml(site, body)); };
  const redirect = (res, loc, cookies) => { res.writeHead(303, { location: loc, 'cache-control': 'no-store', ...(cookies ? { 'set-cookie': cookies } : {}) }); res.end(); };
  const sidOf = (req) => parseCookies(req.headers.cookie)[COOKIE];
  const cookie = (sid) => `${COOKIE}=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/preferences; Max-Age=1800`;
  const clear = `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/preferences; Max-Age=0`;
  const form = async (req) => new URLSearchParams(await readBody(req, 8192));

  // Current consent state from the site's existing stores (newsletter list, consent ledger, news-text list).
  function stateFor(s) { return { ...stateFor0(s), can_rejoin_email: !!(s.email && knownEmail(s.email)) }; }
  function stateFor0(s) {
    const t = tenant(); const nl = d.newsletter; const p = core.person(s);
    const newsletter = !!(s.email && nl && nl.isSubscriber(site.tenant, s.email));
    const news = s.phone && nl ? nl.smsState(site.tenant, s.phone).status : 'none';
    const optedOut = s.phone && d.consent ? d.consent.isOptedOut(site.tenant, s.phone) : false;
    const pn = s.email && nl && nl.profileName ? nl.profileName(site.tenant, s.email) : null;
    if (MO) { // link texts = the call consent in the ledger (not a web setting); text controls only for numbers with call consent
      const callOk = !!(s.phone && knownPhone(s.phone));
      return { name: (pn && pn.name) || '', newsletter, news_sms: news, support_sms: !!(s.phone && d.consent && d.consent.canText(site.tenant, s.phone) && d.consent.hasCallConsent(site.tenant, s.phone)), support_pending: false, news_freq: FREQS.includes(p.news_freq) ? p.news_freq : 'monthly', sms_available: smsOn() && !!t && callOk, manage_only: true };
    }
    return { name: (pn && pn.name) || '', newsletter, news_sms: news, support_sms: !!(s.phone && p.support_sms && !optedOut), support_pending: !!p.support_pending, news_freq: FREQS.includes(p.news_freq) ? p.news_freq : 'monthly', sms_available: smsOn() && !!t };
  }
  // Per-site sign-up switches (both default to open, as on QuantaDose):
  //  site.emailWebSignup === false -> email manage-only: links only to addresses already on the newsletter list, no new web subscribers.
  //  site.smsWebOptIn === false    -> text manage-only: controls and codes only for numbers with call consent; texts can be
  //                                   turned off and frequency changed, never turned on; no web YES enrollment.
  const MO_EMAIL = site.emailWebSignup === false; const MO = site.smsWebOptIn === false;
  const knownEmail = (email) => { const nl = d.newsletter; return !!(nl && (nl.isSubscriber(site.tenant, email) || (nl.everConfirmed && nl.everConfirmed(site.tenant, email)))); };
  const knownPhone = (phone) => { if (!phone) return false; const c = d.consent; const nl = d.newsletter; if (c && c.hasCallConsent && c.hasCallConsent(site.tenant, phone)) return true; const st = nl ? nl.smsState(site.tenant, phone).status : 'none'; return st === 'subscribed' || st === 'pending'; };
  function change(s, what, from, to, method, req) { core.audit({ who: s.email || s.phone, channel: what, from, to, method, source: 'web:/preferences', ip_fp: fp(clientIp(req)) }); log('prefs.change', { site: site.id, channel: what, to, method }); }

  async function sendConfirmText(phone) {
    const t = tenant(); const tw = d.smsFor(t);
    return tw.sendSms({ from: t.numbers[0], to: phone, body: site.smsConfirmText, messagingServiceSid: t.twilio && t.twilio.messaging_service_sid });
  }

  async function apply(s, f, req) {
    const before = stateFor(s); const nl = d.newsletter;
    if (s.email && nl) {
      const want = f.get('newsletter') === 'on';
      const name = cleanPersonName(f.get('name'));
      if (want && !name) return 'name'; // name required when email is on; nothing is changed
      if (MO_EMAIL && want && !before.newsletter && !knownEmail(s.email)) return 'email_signup_by_phone'; // manage-only: no new web subscribers
      if (want !== before.newsletter) { nl.append({ kind: want ? 'confirmed' : 'unsubscribed', tenant: site.tenant, email: s.email, name: want ? name : null, ...(want ? { last_name: null } : {}), source: 'web-preferences' }); change(s, 'email_newsletter', before.newsletter ? 'on' : 'off', want ? 'on' : 'off', 'web', req); }
      if (want && name !== before.name) {
        if (before.newsletter) nl.append({ kind: 'profile', tenant: site.tenant, email: s.email, name, last_name: null, source: 'web-preferences' });
        core.audit({ who: s.email, channel: 'name', from: before.name ? 'set' : 'none', to: 'updated', method: 'web', source: 'web:/preferences', ip_fp: fp(clientIp(req)) }); // never the name values
      }
    }
    if (!s.phone || !smsOn()) return; // text controls hidden/disabled: ignore any posted SMS fields
    if (MO) return applyManageOnlyTexts(s, f, req, before);
    const freq = FREQS.includes(f.get('news_freq')) ? f.get('news_freq') : before.news_freq;
    if (freq !== before.news_freq) { core.setPerson(s, { news_freq: freq }); change(s, 'news_sms_frequency', before.news_freq, freq, 'web', req); }
    const wantSupport = f.get('support_sms') === 'on'; const wantNews = f.get('news_sms') === 'on';
    const turningOn = (wantSupport && !before.support_sms && !before.support_pending) || (wantNews && !['subscribed', 'pending'].includes(before.news_sms));
    if (turningOn) {
      if (f.get('consent') !== 'yes') return 'consent_required';
      if (wantNews && !['subscribed', 'pending'].includes(before.news_sms)) { nl.requestSms({ tenant: site.tenant, phone: s.phone, call: null, email: s.email || null, wording: { web: site.smsConsentText, text: site.smsConfirmText } }); change(s, 'news_sms', before.news_sms, 'pending_yes', 'web', req); }
      if (wantSupport && !before.support_sms) { core.setPerson(s, { support_pending: true }); change(s, 'support_sms', 'off', 'pending_yes', 'web', req); }
      try { await sendConfirmText(s.phone); } catch (e) { log('prefs.sms_error', { site: site.id, err: String(e.message).slice(0, 80) }); }
    }
    if (!wantNews && ['subscribed', 'pending'].includes(before.news_sms)) { nl.stopSms(site.tenant, s.phone); change(s, 'news_sms', before.news_sms, 'off', 'web', req); }
    if (!wantSupport && (before.support_sms || before.support_pending)) { core.setPerson(s, { support_sms: false, support_pending: false }); change(s, 'support_sms', 'on', 'off', 'web', req); }
    if (!wantSupport && !wantNews && d.consent && (before.support_sms || ['subscribed', 'pending'].includes(before.news_sms))) d.consent.record(site.tenant, s.phone, 'stop');
  }
  // Manage-only texts: only turning a type off and changing frequency. Nothing here can turn texts on or send a text.
  function applyManageOnlyTexts(s, f, req, before) {
    if (!before.sms_available) return;
    const nl = d.newsletter; let blocked = false;
    const wantSupport = f.get('support_sms') === 'on'; const wantNews = f.get('news_sms') === 'on';
    if (wantSupport && !before.support_sms) blocked = true;
    if (wantNews && !['subscribed', 'pending'].includes(before.news_sms)) blocked = true;
    const newsOn = ['subscribed', 'pending'].includes(before.news_sms) && wantNews;
    const freq = FREQS.includes(f.get('news_freq')) ? f.get('news_freq') : before.news_freq; // FREQS tops out at 4/mo
    if (newsOn && freq !== before.news_freq) { core.setPerson(s, { news_freq: freq }); change(s, 'news_sms_frequency', before.news_freq, freq, 'web', req); }
    if (!wantNews && ['subscribed', 'pending'].includes(before.news_sms)) { nl.stopSms(site.tenant, s.phone); change(s, 'news_sms', before.news_sms, 'off', 'web', req); }
    if (!wantSupport && before.support_sms) { // the ledger is per number: link texts off = STOP for this number (news stops too)
      if (nl && newsOn) { nl.stopSms(site.tenant, s.phone); change(s, 'news_sms', before.news_sms, 'off', 'web', req); }
      if (d.consent) d.consent.record(site.tenant, s.phone, 'stop'); change(s, 'support_sms', 'on', 'off', 'web', req);
    }
    return blocked ? 'sms_signup_by_phone' : undefined;
  }
  function unsubscribeAll(s, req) {
    const before = stateFor(s); const nl = d.newsletter;
    if (s.email && nl && before.newsletter) { nl.append({ kind: 'unsubscribed', tenant: site.tenant, email: s.email, source: 'web-preferences' }); change(s, 'email_newsletter', 'on', 'off', 'web', req); }
    if (s.phone) {
      if (nl && ['subscribed', 'pending'].includes(before.news_sms)) { nl.stopSms(site.tenant, s.phone); change(s, 'news_sms', before.news_sms, 'off', 'web', req); }
      if (before.support_sms || before.support_pending) { core.setPerson(s, { support_sms: false, support_pending: false }); change(s, 'support_sms', 'on', 'off', 'web', req); }
      if (d.consent) d.consent.record(site.tenant, s.phone, 'stop');
    }
    core.audit({ who: s.email || s.phone, channel: 'all', from: 'any', to: 'off', method: 'web', source: 'web:/preferences/unsubscribe-all', ip_fp: fp(clientIp(req)) });
  }
  // Unsubscribe dropdown: texts | emails | all. Opt-out only. Texts go on the same STOP list the SMS handler uses
  // (consent ledger 'stop'), so STOP/START behave the same afterwards; works with text controls off; never sends a text.
  // A typed number is accepted ONLY here (opt-out), never for opt-in, because the session has not proved it owns it.
  function unsubscribeScope(s, scope, phone, method, req) {
    const nl = d.newsletter; const out = { email: false, texts: false };
    if ((scope === 'emails' || scope === 'all') && s.email) {
      if (nl && nl.isSubscriber(site.tenant, s.email)) nl.append({ kind: 'unsubscribed', tenant: site.tenant, email: s.email, source: 'web-preferences' });
      change(s, 'email_newsletter', 'any', 'off', 'web', req); out.email = true;
    }
    if ((scope === 'texts' || scope === 'all') && phone) {
      const st = nl ? nl.smsState(site.tenant, phone).status : 'none';
      if (nl && ['subscribed', 'pending'].includes(st)) nl.stopSms(site.tenant, phone);
      const ps = { phone }; if (core.person(ps).support_sms || core.person(ps).support_pending) core.setPerson(ps, { support_sms: false, support_pending: false });
      if (d.consent) d.consent.record(site.tenant, phone, 'stop');
      core.audit({ who: s.email || s.phone, phone, channel: 'all_texts', from: 'any', to: 'off', method: 'web', source: method, ip_fp: fp(clientIp(req)) }); out.texts = true;
    }
    if (scope === 'all') core.audit({ who: s.email || s.phone, channel: 'all', from: 'any', to: 'off', method: 'web', source: method, ip_fp: fp(clientIp(req)) });
    log('prefs.unsubscribe', { site: site.id, scope, email: out.email, texts: out.texts }); return out;
  }
  // Called by the SMS handler when a YES reply confirms a pending web opt-in (support texts).
  function confirmSupportYes(phone) { if (MO) return false; /* manage-only: no web YES enrollment */ const s = { phone }; const p = core.person(s); if (!p.support_pending) return false; core.setPerson(s, { support_sms: true, support_pending: false }); core.audit({ who: phone, channel: 'support_sms', from: 'pending_yes', to: 'on', method: 'sms', source: 'sms:YES' }); return true; }

  async function route(req, res, u) {
    const p = u.pathname; if (p !== '/preferences' && !p.startsWith('/preferences/')) return false;
    const ip = clientIp(req);
    if (req.method === 'GET' && (p === '/preferences' || p === '/preferences/')) return send(res, 200, entryBody(site, { smsOn: smsOn() })), true;
    if (req.method === 'POST' && p === '/preferences/start') {
      const f = await form(req); const email = normEmail(f.get('email')); const phone = smsOn() ? normPhone(f.get('phone')) : null;
      if (!email && !phone) return send(res, 400, entryBody(site, { smsOn: smsOn(), error: 'Enter a valid email address' + (smsOn() ? ' or mobile number.' : '.') })), true;
      const ipOk = core.allowIp(ip);
      if (email && ipOk && core.allowId('e:' + email) && (!MO_EMAIL || knownEmail(email))) {
        const tok = core.issueToken(email); const link = base() + '/preferences/verify?t=' + tok;
        let first = ''; try { first = d.newsletter && d.newsletter.profileName ? firstWord((d.newsletter.profileName(site.tenant, email) || {}).name) : ''; } catch { first = ''; }
        const greet = 'Hi ' + (first || 'there') + ',';
        const text = [greet, '', `Use this link to manage your ${site.siteName} email and text preferences:`, '', link, '', 'It works once, for 15 minutes. If you did not ask for it, ignore this email.', '', site.company].join('\n');
        const html = `<p>${h(greet)}</p><p>Use this link to manage your ${site.siteName} email and text preferences:</p><p><a href="${link}" style="display:inline-block;padding:10px 16px;background:#0b5;color:#fff;text-decoration:none;border-radius:6px">Manage my preferences</a></p><p>It works once, for 15 minutes. If you did not ask for it, ignore this email.</p><p style="font-size:12px;color:#666">${site.company}</p>`;
        try { const r = await d.emailFor(tenant()).send({ to: email, subject: site.emailSubject, text, html }); log('prefs.link_sent', { site: site.id, to: fp(email), ok: !!(r && r.ok) }); } catch (e) { log('prefs.link_error', { site: site.id, err: String(e.message).slice(0, 80) }); }
      } else if (email) log('prefs.rate_limited', { site: site.id, kind: ipOk ? 'id' : 'ip' });
      if (phone && !email) {
        if (ipOk && core.allowId('p:' + phone) && (!MO || knownPhone(phone))) { const code = core.issueCode(phone); const t = tenant(); try { await d.smsFor(t).sendSms({ from: t.numbers[0], to: phone, body: site.smsCodeText(code), messagingServiceSid: t.twilio && t.twilio.messaging_service_sid }); } catch (e) { log('prefs.sms_error', { site: site.id, err: String(e.message).slice(0, 80) }); } }
        return send(res, 200, codeBody(site, { phone: f.get('phone'), msg: GENERIC_CODE })), true;
      }
      return send(res, 200, sentBody(site, GENERIC_EMAIL)), true;
    }
    if (p === '/preferences/verify') {
      if (req.method === 'GET') return send(res, 200, continueBody(site, u.searchParams.get('t') || '')), true; // GET never consumes (link scanners)
      if (req.method === 'POST') {
        const email = core.consumeToken((await form(req)).get('t'));
        if (!email) return send(res, 400, msgBody(site, 'Link expired or already used', 'Sign-in links work once, for 15 minutes. <a href="/preferences">Get a new link</a>.')), true;
        const { sid } = core.newSession({ email }); core.audit({ who: email, channel: 'session', from: 'out', to: 'in', method: 'email-link', source: 'web:/preferences/verify', ip_fp: fp(ip) });
        return redirect(res, '/preferences/manage', [cookie(sid)]), true;
      }
    }
    if (req.method === 'POST' && p === '/preferences/code') {
      const f = await form(req); const phone = normPhone(f.get('phone'));
      if (!smsOn() || !phone || !core.allowIp(ip) || !core.consumeCode(phone, f.get('code'))) return send(res, 400, codeBody(site, { phone: f.get('phone'), msg: 'That code did not work or has expired. Request a new one from the preferences page.' })), true;
      const cur = core.session(sidOf(req)); const { sid } = core.newSession({ ...(cur && cur.email ? { email: cur.email } : {}), phone }); core.endSession(sidOf(req));
      core.audit({ who: phone, channel: 'session', from: 'out', to: 'in', method: 'sms', source: 'web:/preferences/code', ip_fp: fp(ip) });
      return redirect(res, '/preferences/manage', [cookie(sid)]), true;
    }
    const sid = sidOf(req); const s = core.session(sid);
    if (p === '/preferences/manage' && req.method === 'GET') {
      if (!s) return redirect(res, '/preferences'), true;
      return send(res, 200, manageBody(site, { s, st: stateFor(s), csrf: s.csrf, saved: u.searchParams.get('saved'), err: u.searchParams.get('err') })), true;
    }
    if (req.method === 'POST' && ['/preferences/save', '/preferences/unsubscribe-all', '/preferences/logout', '/preferences/unsubscribe'].includes(p)) {
      if (!s) return redirect(res, '/preferences'), true;
      const f = await form(req); if (f.get('csrf') !== s.csrf || String(req.headers['sec-fetch-site'] || '') === 'cross-site') return send(res, 403, msgBody(site, 'Please try again', '<a href="/preferences/manage">Back to your preferences</a>')), true;
      if (p === '/preferences/logout') { core.endSession(sid); return redirect(res, '/preferences', [clear]), true; }
      if (p === '/preferences/unsubscribe') {
        const scope = ['texts', 'emails', 'all'].includes(f.get('scope')) ? f.get('scope') : null; if (!scope) return redirect(res, '/preferences/manage?err=pick'), true;
        let phone = s.phone || null; const typed = String(f.get('phone') || '').trim();
        if (!phone && typed && scope !== 'emails') {
          phone = normPhone(typed); if (!phone) return redirect(res, '/preferences/manage?err=phone'), true;
          if (!core.allowIp(ip) || !core.allowId('optout:' + phone)) return redirect(res, '/preferences/manage?err=limit'), true;
        }
        if (scope === 'texts' && !phone) return redirect(res, '/preferences/manage?err=phone'), true;
        const r = unsubscribeScope(s, scope, phone, s.phone ? 'web:/preferences/unsubscribe' : typed ? 'web:/preferences/unsubscribe(typed-number,opt-out-only)' : 'web:/preferences/unsubscribe', req);
        return redirect(res, '/preferences/manage?saved=' + (scope === 'all' && !r.texts ? 'all-email' : scope)), true;
      }
      if (p === '/preferences/unsubscribe-all') { unsubscribeAll(s, req); return redirect(res, '/preferences/manage?saved=all'), true; }
      const err = await apply(s, f, req); return redirect(res, '/preferences/manage?' + (err ? 'err=' + err : 'saved=1')), true;
    }
    return send(res, 404, msgBody(site, 'Not found', '<a href="/preferences">Preferences</a>')), true;
  }
  return { route, core, smsOn, confirmSupportYes, stateFor, unsubscribeScope };
}
module.exports = { createPrefs, GENERIC_EMAIL, GENERIC_CODE };
