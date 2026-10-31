'use strict';
// Builds the dependency set for createApp in "demo" (all mocks) or "live" (real clients) mode.
const path = require('path');
const fs = require('fs');
const { TenantRegistry, SecretStore, resolveSecret } = require('./tenants');
const { KB } = require('./kb');
const { ShopifyClient, ShopifyAdmin } = require('./shopify');
const { Consent, MockTwilio, TwilioRest } = require('./twilio');
const { XaiCallControl } = require('./xai');
const { MockBrain, XaiTextBrain } = require('./sms');
const { SmsRateLimit } = require('./ratelimit');
const { createFetch } = require('./fetch');
const { SarCatalog } = require('./sar');
const { collectChecks, assertLiveReady, DEMO_ADMIN } = require('./readiness');
const { isWritable } = require('./storage');
const { scrubFields, redactLine } = require('./util');
const mocks = require('./mocks');

const REQUIRED_LIVE = ['PUBLIC_BASE_URL', 'PA_ADMIN_TOKEN', 'PA_STATE_SECRET', 'PA_MASTER_KEY', 'XAI_API_KEY', 'DATA_DIR'];
const SECRET_ENV = /TOKEN|SECRET|KEY|PASSWORD/i;

function makeLogger(file, secrets = []) {
  return (event, fields = {}) => {
    const line = redactLine(JSON.stringify({ at: new Date().toISOString(), event, ...scrubFields(fields) }), secrets);
    if (file) fs.appendFileSync(file, line + '\n'); else process.stdout.write(line + '\n');
  };
}

function secretValues(env) {
  return Object.entries(env).filter(([k, v]) => SECRET_ENV.test(k) && typeof v === 'string' && v.length >= 8).map(([, v]) => v);
}

function buildDeps({ mode, env = process.env, tenantsDir, dataDir, log }) {
  const tenants = new TenantRegistry(tenantsDir, { skipExample: mode === 'live' });
  const readiness = () => collectChecks({ env, tenants: tenants.list(), dataDir, dataWritable: isWritable(dataDir), mode });
  if (mode === 'live') assertLiveReady(readiness());
  fs.mkdirSync(dataDir, { recursive: true });
  const secrets = new SecretStore(path.join(dataDir, 'secrets.enc.json'), env.PA_MASTER_KEY || (mode === 'demo' ? Buffer.alloc(32, 7).toString('base64') : null));
  const consent = new Consent(path.join(dataDir, 'consent.jsonl'));
  const kbCache = new Map(); const shopCache = new Map(); const smsCache = new Map();
  const kbReset = (id) => { kbCache.delete(id); shopCache.delete(id); };
  // Curated topic cards ship with the code: kb/curated/<tenant>/*.md (see kb/curated/README.md). Added automatically, no tenant PATCH needed.
  const curatedDirFor = (id) => { const dir = path.join(__dirname, '..', 'kb', 'curated', String(id).replace(/[^a-z0-9_-]/gi, '')); const wiki = path.join(dataDir, 'kb', String(id).replace(/[^a-z0-9_-]/gi, '') + '-wiki'); return [dir, wiki].filter((x) => fs.existsSync(x)); };
  const kbFor = (t) => { if (!kbCache.has(t.id)) kbCache.set(t.id, new KB({ dirs: [...(t.kb?.dirs || []).map((p) => path.resolve(tenantsDir, p)), ...curatedDirFor(t.id)], allowlist: t.link_allowlist })); return kbCache.get(t.id); };
  const liveFetch = createFetch({ timeoutMs: 8000, retries: 2, backoffMs: 50 });
  // Admin credentials: tenant secret refs shopify_client_id / shopify_client_secret, or the deploy-wide
  // SHOPIFY_ADMIN_* env vars, which only bind to the tenant whose shopify.admin_shop equals SHOPIFY_ADMIN_SHOP.
  const adminFor = (t, fetchImpl) => {
    if (!t.order_lookup_enabled || !t.shopify?.admin_shop) return null;
    const own = env.SHOPIFY_ADMIN_SHOP && env.SHOPIFY_ADMIN_SHOP === t.shopify.admin_shop;
    const clientId = resolveSecret(t, 'shopify_client_id', { env, store: secrets }) || (own ? env.SHOPIFY_ADMIN_CLIENT_ID : null);
    const clientSecret = resolveSecret(t, 'shopify_client_secret', { env, store: secrets }) || (own ? env.SHOPIFY_ADMIN_CLIENT_SECRET : null);
    if (!clientId || !clientSecret) return null;
    return new ShopifyAdmin({ shop: t.shopify.admin_shop, clientId, clientSecret, fetchImpl });
  };
  const shopifyFor = (t) => { if (!shopCache.has(t.id)) { const fetchImpl = mode === 'live' ? liveFetch : mocks.mockShopifyFetch(); shopCache.set(t.id, new ShopifyClient({ shop: t.shopify.shop, mode: t.shopify.mode, publicDomain: t.shopify.public_domain, storefrontToken: resolveSecret(t, 'shopify_storefront_token', { env, store: secrets }), admin: adminFor(t, fetchImpl), fetchImpl })); } return shopCache.get(t.id); };
  const smsFor = (t) => { if (!smsCache.has(t.id)) smsCache.set(t.id, mode === 'live' ? new TwilioRest({ accountSid: t.twilio?.account_sid || env.TWILIO_ACCOUNT_SID || env.RFSAFE_TWILIO_ACCOUNT_SID, authToken: resolveSecret(t, 'twilio_auth_token', { env, store: secrets }), fetchImpl: liveFetch }) : new MockTwilio()); return smsCache.get(t.id); };
  const { ResendEmail, MockEmail } = require('./email');
  const mockEmail = new MockEmail();
  const liveEmail = mode === 'live' ? new ResendEmail({ apiKey: env.RESEND_API_KEY, fetchImpl: liveFetch }) : null;
  const emailFor = () => (mode === 'live' ? liveEmail : mockEmail);
  const mockCC = new mocks.MockCallControl();
  const callControlFor = () => (mode === 'live' ? new XaiCallControl({ apiKey: env.XAI_API_KEY, fetchImpl: liveFetch }) : mockCC);
  const openRealtime = async (t, callId) => {
    if (mode !== 'live') return new mocks.MockRealtimeWs();
    // Node >= 22 global WebSocket (undici) accepts a non-standard { headers } init. VERIFY on first live test.
    const ws = new WebSocket(`wss://api.x.ai/v1/realtime?call_id=${encodeURIComponent(callId)}`, { headers: { Authorization: 'Bearer ' + env.XAI_API_KEY } });
    const { EventEmitter } = require('events'); const em = new EventEmitter(); const q = [];
    ws.addEventListener('open', () => { for (const s of q.splice(0)) ws.send(s); });
    ws.addEventListener('message', (e) => em.emit('message', Buffer.from(typeof e.data === 'string' ? e.data : new Uint8Array(e.data))));
    ws.addEventListener('close', () => em.emit('close'));
    em.send = (s) => (ws.readyState === 1 ? ws.send(s) : q.push(s));
    return em;
  };
  const outbox = path.join(dataDir, 'owner-outbox.jsonl');
  const notify = async (t, item) => { fs.appendFileSync(outbox, JSON.stringify({ tenant: t.id, to: t.owner_email || null, ...item }) + '\n', { mode: 0o600 }); };
  // Build each tenant's KB index right after boot (~3 s for the full wiki) so the first caller does not wait.
  if (mode === 'live') setTimeout(() => { for (const t of tenants.list()) { try { kbFor(t); } catch { /* logged on use */ } } }, 0).unref();
  return {
    mode, tenants, secrets, consent, env, kbFor, shopifyFor, smsFor, callControlFor, openRealtime, notify, log: log || makeLogger(env.PA_LOG_FILE, secretValues(env)),
    readiness, callLog: path.join(dataDir, 'calls.jsonl'),
    callRecords: new (require('./admin').CallRecords)({ file: path.join(dataDir, 'call-records.jsonl') }),
    newsletterFile: path.join(dataDir, 'newsletter.jsonl'),
    adminAuth: new (require('./admin').AdminAuth)({ secret: require('./admin').adminSecret(env), email: env.ADMIN_LOGIN_EMAIL }),
    rateLimit: new SmsRateLimit({ file: path.join(dataDir, 'sms-rate.json') }),
    websiteFetch: mode === 'live' ? liveFetch : null, kbReset, emailFor, emailLogFile: path.join(dataDir, 'email.jsonl'), sentMessages: new (require('./messages').SentMessages)({ file: path.join(dataDir, 'sent-messages.jsonl'), legacyEmailFile: path.join(dataDir, 'email.jsonl') }), kbGapFile: path.join(dataDir, 'kb-gaps.jsonl'), channelLogFile: path.join(dataDir, 'channel-changes.jsonl'), kbBundleDir: path.join(dataDir, 'kb'),
    newsletter: (() => { const { Newsletter, deriveSecret } = require('./newsletter'); return new Newsletter({ secret: deriveSecret(env), file: path.join(dataDir, 'newsletter.jsonl'), baseUrl: env.PUBLIC_BASE_URL || 'https://callbots.org' }); })(),
    sarFor: (() => { const c = new SarCatalog({ fetchImpl: mode === 'live' ? liveFetch : mocks.mockSarFetch() }); return () => c; })(),
    brain: mode === 'live' ? new XaiTextBrain({ apiKey: env.XAI_API_KEY, model: env.XAI_TEXT_MODEL || 'grok-4.7', fetchImpl: liveFetch }) : new MockBrain(),
    publicBaseUrl: env.PUBLIC_BASE_URL || 'http://localhost:8787', adminToken: env.PA_ADMIN_TOKEN || (mode === 'demo' ? 'demo-admin-token-EXAMPLE' : null),
    stateSecret: env.PA_STATE_SECRET || (mode === 'demo' ? 'demo-state-secret-EXAMPLE' : null),
    shopifyApp: { clientId: env.SHOPIFY_APP_CLIENT_ID || 'demo-client-id', secret: env.SHOPIFY_APP_SECRET || 'demo-app-secret-EXAMPLE' },
    twilioConnectAppSid: env.TWILIO_CONNECT_APP_SID,
    exchange: async (provider) => { if (mode === 'live') throw new Error('live token exchange not enabled in v0.1.0 pilot (RF Safe uses env tokens)'); return { storefront_token: 'demo-storefront-token-EXAMPLE-' + provider }; },
    _mocks: { callControl: mockCC },
  };
}

module.exports = { buildDeps, makeLogger, REQUIRED_LIVE, DEMO_ADMIN };
