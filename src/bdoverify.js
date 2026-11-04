'use strict';
// Best Deal On: Verify by call + inbound claim helpers. Tenant "bestdealon" ONLY; never RF Safe.
// Flags (env, default OFF):
//   BDO_VERIFY_CALLS = off | dryrun | live   -> POST /bdo/verify-call (signed by bestdealon.app). dryrun records, dials nothing.
//   BDO_INBOUND_CLAIM = on                   -> adds tools bdo_listing_for_caller / bdo_start_claim for tenant.bdo_claims === true.
// Shared secret: BDO_CALLBOT_SHARED_SECRET (same value as CALLBOT_SHARED_SECRET on bestdealon.app). Site URL: BDO_SITE_URL.
// Hard rules: the number dialled must equal +1<listing_phone> from the signed request; RF Safe's number and any tenant's own
// number are refused; From is the bestdealon tenant's own number; per-number rate limit.
const crypto = require('crypto');
const { readBody } = require('./util');

const TENANT = 'bestdealon';
const BLOCKED = new Set(['+17276775572']);
const SKEW = 300, PER_NUMBER_HOUR = 3;

function sign(secret, t, body) { return `t=${t},v1=` + crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'); }
function verifySig(secret, header, body, nowSec) {
  const m = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(String(header || ''));
  if (!secret || !m || Math.abs(nowSec - Number(m[1])) > SKEW) return false;
  const want = Buffer.from(crypto.createHmac('sha256', secret).update(`${m[1]}.${body}`).digest('hex')); const got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const spaced = (code) => String(code).split('').join(', ');

/** TwiML for the verification call. read: say the code twice. keyin: gather 6 digits, posted to gatherUrl. */
function verifyTwiml({ mode, code, business, gatherUrl }) {
  const intro = `Hello. This is the Best Deal On phone assistant, calling to verify the phone number for ${esc(business || 'your business')} on bestdealon dot app.`;
  if (mode === 'read') return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${intro} Your verification code is: ${spaced(code)}. Again, the code is: ${spaced(code)}. Type it on the website to finish. If you did not ask for this, you can hang up. Goodbye.</Say></Response>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="dtmf" numDigits="6" timeout="15" action="${esc(gatherUrl)}" method="POST"><Say>${intro} Please key in the six digit code shown on the website now.</Say></Gather><Say>We did not get a code. Press Verify by call on the website to try again. Goodbye.</Say></Response>`;
}

class DryRunCallDriver { constructor() { this.placed = []; } name() { return 'dryrun'; } async place(c) { this.placed.push(c); return { ok: true, sid: 'CA_dryrun_' + this.placed.length }; } }
class TwilioCallDriver {
  // Live only. API key auth; places ONE call with inline TwiML. Never logs credentials.
  constructor({ accountSid, apiKeySid, apiKeySecret, fetchImpl = globalThis.fetch }) { this.sid = accountSid; this.user = apiKeySid; this.tok = apiKeySecret; this.fetch = fetchImpl; }
  name() { return 'twilio'; }
  async place({ to, from, twiml }) {
    const r = await this.fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Calls.json`, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(this.user + ':' + this.tok).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: from, Twiml: twiml, Timeout: '25', TimeLimit: '120', MachineDetection: 'Enable' }) });
    const j = await r.json().catch(() => ({})); return r.ok ? { ok: true, sid: j.sid } : { ok: false, error: 'twilio_' + r.status };
  }
}

/** Client for bestdealon.app /api/callbot/* (signed). */
class BdoSite {
  constructor({ url, secret, fetchImpl = globalThis.fetch, now = () => Date.now() }) { this.url = String(url || '').replace(/\/$/, ''); this.secret = secret; this.fetch = fetchImpl; this.now = now; }
  configured() { return !!(this.url && this.secret); }
  async post(path, obj) {
    if (!this.configured()) return { ok: false, error: 'not_configured' };
    const body = JSON.stringify(obj);
    const r = await this.fetch(this.url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bdo-signature': sign(this.secret, Math.floor(this.now() / 1000), body) }, body });
    const j = await r.json().catch(() => ({})); return { status: r.status, ...j };
  }
  callerLookup(caller) { return this.post('/api/callbot/caller-lookup', { caller }); }
  /** Recognition only: { known, name, booleans, email_label }. Never an address or number. */
  callerProfile(caller) { return this.post('/api/callbot/caller-profile', { caller }); }
  claim(caller) { return this.post('/api/callbot/claim', { caller, said_yes: true }); }
  verifyCheck(listing_phone, code) { return this.post('/api/callbot/verify-check', { listing_phone, code }); }
}

function flags(env) {
  const v = String(env.BDO_VERIFY_CALLS || 'off').toLowerCase();
  return { verify: ['off', 'dryrun', 'live'].includes(v) ? v : 'off', claims: String(env.BDO_INBOUND_CLAIM || 'off').toLowerCase() === 'on' };
}

/** HTTP routes /bdo/verify-call and /bdo/verify-gather. deps: { env, tenants, log, driver?, site?, publicBaseUrl, verifyTwilio(tenant, params, req) } */
function createBdoVerify(deps) {
  const log = deps.log || (() => {}); const env = deps.env || {};
  const recent = new Map(); // to -> [ms]
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const xml = (res, s) => { res.writeHead(200, { 'content-type': 'text/xml' }); res.end(s); };
  const tenant = () => deps.tenants.list().find((t) => t.id === TENANT);
  const allNumbers = () => new Set(deps.tenants.list().flatMap((t) => t.numbers || []));
  const driver = () => deps.driver || (flags(env).verify === 'live' ? new TwilioCallDriver({ accountSid: env.BDO_TWILIO_ACCOUNT_SID, apiKeySid: env.BDO_TWILIO_API_KEY_SID, apiKeySecret: env.BDO_TWILIO_API_KEY_SECRET }) : (deps._dry ||= new DryRunCallDriver()));
  const site = () => deps.site || new BdoSite({ url: env.BDO_SITE_URL, secret: env.BDO_CALLBOT_SHARED_SECRET });

  async function verifyCall(req, res) {
    const f = flags(env); const body = await readBody(req);
    if (f.verify === 'off') return json(res, 403, { ok: false, error: 'off' });
    if (!verifySig(env.BDO_CALLBOT_SHARED_SECRET, req.headers['x-bdo-signature'], body, Math.floor(Date.now() / 1000))) { log('bdo.verify_call_rejected', { reason: 'signature' }); return json(res, 401, { ok: false, error: 'bad_signature' }); }
    let b; try { b = JSON.parse(body); } catch { return json(res, 400, { ok: false, error: 'bad_json' }); }
    const t = tenant(); if (!t || b.tenant !== TENANT) return json(res, 403, { ok: false, error: 'tenant' });
    const listing = String(b.listing_phone || ''); const to = String(b.to || '');
    if (!/^\d{10}$/.test(listing) || to !== '+1' + listing) return json(res, 422, { ok: false, error: 'to_must_be_listing_number' });
    if (BLOCKED.has(to) || allNumbers().has(to)) { log('bdo.verify_call_blocked', { to: to.slice(-4) }); return json(res, 403, { ok: false, error: 'blocked' }); }
    const mode = b.mode === 'keyin' ? 'keyin' : 'read';
    if (mode === 'read' && !/^\d{6}$/.test(String(b.code || ''))) return json(res, 422, { ok: false, error: 'code' });
    const now = Date.now(); const hist = (recent.get(to) || []).filter((x) => now - x < 3600e3);
    if (hist.length >= PER_NUMBER_HOUR) return json(res, 429, { ok: false, error: 'rate_limited' });
    hist.push(now); recent.set(to, hist);
    const from = (t.numbers || [])[0];
    const gatherUrl = `${deps.publicBaseUrl || ''}/bdo/verify-gather?l=${listing}&r=${encodeURIComponent(String(b.ref || ''))}`;
    const twiml = verifyTwiml({ mode, code: b.code, business: String(b.business || '').slice(0, 80), gatherUrl });
    const d = driver(); const r = await d.place({ to, from, twiml, mode, ref: String(b.ref || '') });
    log('bdo.verify_call', { to: '…' + to.slice(-4), mode, driver: d.name(), ok: r.ok });
    return json(res, r.ok ? 200 : 502, { ok: r.ok, call: r.sid || null, driver: d.name(), ...(r.ok ? {} : { error: r.error }) });
  }

  async function verifyGather(req, res, u) {
    const body = await readBody(req); const params = Object.fromEntries(new URLSearchParams(body)); const t = tenant();
    if (!t || !deps.verifyTwilio || !deps.verifyTwilio(t, params, req)) { log('bdo.gather_rejected', {}); res.writeHead(403); return res.end(); }
    const listing = String(u.searchParams.get('l') || '');
    if (!/^\d{10}$/.test(listing) || params.To !== '+1' + listing) { res.writeHead(403); return res.end(); }
    const r = await site().verifyCheck(listing, String(params.Digits || '').replace(/\D/g, ''));
    const msg = r.ok ? 'Thank you. Your phone number is now verified on Best Deal On. Goodbye.' : (r.error === 'wrong_code' ? 'That code did not match. Check the code on the website and press Verify by call again. Goodbye.' : 'We could not verify the number this time. Press Verify by call on the website to try again. Goodbye.');
    log('bdo.verify_gather', { listing: '…' + listing.slice(-4), ok: !!r.ok });
    return xml(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${esc(msg)}</Say><Hangup/></Response>`);
  }

  return {
    async route(req, res, u) {
      if (req.method === 'POST' && u.pathname === '/bdo/verify-call') return verifyCall(req, res);
      if (req.method === 'POST' && u.pathname === '/bdo/verify-gather') return verifyGather(req, res, u);
      return json(res, 404, { error: 'not_found' });
    },
  };
}

// ---- inbound claim tools (voice only; tenant bestdealon with bdo_claims true and BDO_INBOUND_CLAIM=on) ----
const CLAIM_DEFS = {
  bdo_listing_for_caller: { description: 'Best Deal On only. At the start of a voice call, check whether the caller ID matches an unclaimed or unverified Best Deal On listing. If eligible, ask exactly: "Do you own <name>? Would you like to claim it?" Never read out the number. If not eligible, do not mention claiming.', parameters: { type: 'object', properties: {} } },
  bdo_start_claim: { description: 'Best Deal On only. Call ONLY after the caller clearly says yes to owning and claiming the listing. Starts a pending claim; it does NOT verify or change anything. Then say what the result "say" field says. Never promise the claim is approved, and never offer to text.', parameters: { type: 'object', properties: { caller_said_yes: { type: 'boolean' } }, required: ['caller_said_yes'] } },
};
function claimToolsEnabled(tenant, env, site) { return !!(tenant && tenant.id === TENANT && tenant.bdo_claims === true && flags(env || {}).claims && site && site.configured()); }
async function runClaimTool(name, args, ctx, site) {
  if (ctx.channel !== 'voice') return { ok: false, error: 'voice_only' };
  if (!ctx.caller || BLOCKED.has(ctx.caller)) return { ok: true, eligible: false };
  if (name === 'bdo_listing_for_caller') { const r = await site.callerLookup(ctx.caller); return r.eligible ? { ok: true, eligible: true, name: String(r.name || '').slice(0, 80), pending_claim: !!r.pending_claim } : { ok: true, eligible: false }; }
  if (name === 'bdo_start_claim') {
    if (args.caller_said_yes !== true) return { ok: false, error: 'needs_yes' };
    const r = await site.claim(ctx.caller);
    return r.ok ? { ok: true, claim: 'pending', say: r.say } : { ok: false, error: r.error || 'failed', say: 'I could not start a claim for this number. You can email support@bestdealon.app.' };
  }
  return { ok: false, error: 'unknown_tool' };
}

module.exports = { sign, verifySig, verifyTwiml, DryRunCallDriver, TwilioCallDriver, BdoSite, flags, createBdoVerify, CLAIM_DEFS, claimToolsEnabled, runClaimTool, BLOCKED, TENANT };
