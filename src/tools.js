'use strict';
// Tool definitions + dispatcher. Every tool runs with a tenant context; a tool can only touch that
// tenant's KB, Shopify client, numbers, allowlist and consent records (tenant isolation).
const { checkOutboundSms, checkUrl, looksLikeCard } = require('./linkguard');
const { sendCustomerSms } = require('./twilio');
const { SmsRateLimit } = require('./ratelimit');
const { fetchAllowlistedPage } = require('./web');
const { fp } = require('./util');

function inHours(hours, now = new Date()) {
  if (!hours) return true;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: hours.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]));
  const days = hours.days || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  if (!days.includes(parts.weekday)) return false;
  const hm = parts.hour + ':' + parts.minute;
  return hm >= hours.open && hm < hours.close;
}

const DEFS = {
  kb_answer: { description: 'Look up the answer to a question about the company, its research, or its products in the official knowledge base. Always use this before answering factual questions.', parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } },
  product_search: { description: 'Search the live product catalog (read-only). Returns title, price, availability, and product page URL.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  website_lookup: { description: 'Look up a page on the official website. Returns a title, a short excerpt, and an allowlisted URL. Use this before describing what a page says.', parameters: { type: 'object', properties: { query: { type: 'string' }, url: { type: 'string' } } } },
  send_link: { description: 'Text the caller one link to an official page (product page or article) with a short note. Only official domains are allowed. Never use for payment details. Same rules as send_link_sms.', parameters: { type: 'object', properties: { url: { type: 'string' }, note: { type: 'string' } }, required: ['url'] } },
  send_link_sms: { description: 'Text the caller one https link on an official domain, plus a short note. Link-only. Rate-limited per call and per caller. Never use for payment details.', parameters: { type: 'object', properties: { url: { type: 'string' }, note: { type: 'string' } }, required: ['url'] } },
  transfer_to_human: { description: 'Transfer the call to a person, during business hours only.', parameters: { type: 'object', properties: { reason: { type: 'string' } } } },
  take_message: { description: 'Take a message for the owner (name, callback number, message).', parameters: { type: 'object', properties: { name: { type: 'string' }, callback: { type: 'string' }, message: { type: 'string' } }, required: ['message'] } },
  sar_lookup: { description: 'Look up a phone model\'s FCC-reported SAR values (head, body, hotspot; cellular-only and with Wi-Fi on) from RF Safe\'s public SAR database. Speak the numbers briefly; never read the URLs aloud.', parameters: { type: 'object', properties: { phone: { type: 'string', description: 'brand and model, e.g. iPhone 17 Pro Max' } }, required: ['phone'] } },
  end_call: { description: 'End the call politely after saying goodbye.', parameters: { type: 'object', properties: { reason: { type: 'string' } } } },
  order_status: { description: 'Check the status of an order by order number. Only works if the caller is calling from the phone number on the order.', parameters: { type: 'object', properties: { order_number: { type: 'string' } }, required: ['order_number'] } },
};

class Tools {
  // deps: { kbFor(tenant), shopifyFor(tenant), smsFor(tenant), consent, callControl, notify, approvals, log, now }
  constructor(tenant, deps) { this.tenant = tenant; this.d = deps; }
  definitions() {
    const names = ['kb_answer', 'website_lookup', 'send_link', 'send_link_sms', 'take_message', 'end_call', 'transfer_to_human'];
    if (this.tenant.shopify) names.splice(2, 0, 'product_search');
    if (this.tenant.sar_lookup && this.d.sarFor) names.splice(1, 0, 'sar_lookup');
    if (this.tenant.order_lookup_enabled && this.tenant.shopify) names.push('order_status');
    return names.map((n) => ({ type: 'function', name: n, ...DEFS[n] }));
  }
  // ctx: { channel: 'voice'|'sms', callId?, caller }
  ctxCall(ctx) { return { run: (name, args) => this.run(name, args || {}, ctx) }; }
  async run(name, args, ctx) {
    const t = this.tenant; const log = this.d.log || (() => {});
    if (name === 'send_link') name = 'send_link_sms';
    if (!this.definitions().some((x) => x.name === name || (name === 'send_link_sms' && x.name === 'send_link'))) return { ok: false, error: 'unknown_tool' };
    // payment data never enters a tool, whatever the model does
    if (Object.values(args).some((v) => looksLikeCard(v))) { log('guard.payment_blocked', { tenant: t.id, tool: name }); return { ok: false, error: 'payment_details_refused', say: 'We never take payment details by phone or text. I can text you a link to order on the official website.' }; }
    try {
      switch (name) {
        case 'kb_answer': return { ok: true, ...this.d.kbFor(t).answer(String(args.question || '').slice(0, 500)) };
        case 'website_lookup': return await this.websiteLookup(args);
        case 'sar_lookup': { const r = await this.d.sarFor(t).lookup(String(args.phone || '').slice(0, 120)); if (!r.found) return { ok: true, found: false, close_matches: r.close || [], say: 'I could not find that exact model in our SAR database. Ask for the exact model name, or offer to text the SAR lookup page.' }; for (const k of ['sar_page', 'kids_visual', 'ranking']) if (!checkUrl(r[k], t.link_allowlist).ok) delete r[k]; return { ok: true, ...r }; }
        case 'product_search': {
          const items = await this.d.shopifyFor(t).searchProducts(args.query, 5);
          return { ok: true, products: items.filter((p) => require('./linkguard').checkUrl(p.url, t.link_allowlist).ok) };
        }
        case 'send_link_sms': return await this.sendLink(args, ctx);
        case 'transfer_to_human': {
          if (ctx.channel !== 'voice') return { ok: false, error: 'voice_only' };
          if (!t.transfer_target) return { ok: false, error: 'no_transfer_target', say: 'I can take a message instead.' };
          if (!inHours(t.hours, this.d.now ? this.d.now() : new Date())) return { ok: false, error: 'after_hours', say: 'The team is away right now. I can take a message or text you a link.' };
          const r = await this.d.callControl.refer(ctx.callId, t.transfer_target);
          log('call.transfer', { tenant: t.id, call: ctx.callId, ok: r.ok, status: r.status });
          return r.ok ? { ok: true, transferred: true } : { ok: false, error: 'transfer_failed', status: r.status, say: 'I could not reach anyone. I can take a message.' };
        }
        case 'take_message': {
          const msg = { tenant: t.id, from: ctx.caller, name: String(args.name || '').slice(0, 80), callback: String(args.callback || ctx.caller || '').slice(0, 20), message: String(args.message).slice(0, 1000), channel: ctx.channel, at: new Date().toISOString() };
          await this.d.notify(t, { kind: 'message', ...msg }); log('message.taken', { tenant: t.id, from: fp(ctx.caller) });
          return { ok: true, saved: true };
        }
        case 'end_call': {
          if (ctx.channel !== 'voice') return { ok: true };
          setTimeout(() => this.d.callControl.hangup(ctx.callId).catch(() => {}), 4000).unref?.();
          return { ok: true, ending: true };
        }
        case 'order_status': return await this.d.shopifyFor(t).orderStatus({ orderName: args.order_number, callerPhone: ctx.caller });
      }
    } catch (e) { log('tool.error', { tenant: t.id, tool: name, err: e.message }); return { ok: false, error: 'tool_unavailable' }; }
  }
  async websiteLookup(args) {
    const t = this.tenant;
    const pages = Array.isArray(t.website?.pages) ? t.website.pages : [];
    const query = String(args.query || '').slice(0, 300);
    if (args.url) {
      const c = checkUrl(args.url, t.link_allowlist);
      if (!c.ok) return { ok: false, error: c.reason, say: 'I can only look up our official website.' };
      const local = pages.find((p) => p.url === c.url);
      if (local) return { ok: true, title: local.title, url: c.url, excerpt: String(local.text || '').slice(0, 600) };
      if (!this.d.websiteFetch) return { ok: false, error: 'page_not_in_catalog', say: 'I do not have that page loaded. I can text you the link or take a message.' };
      const fetched = await fetchAllowlistedPage(c.url, this.d.websiteFetch, t.link_allowlist);
      if (!fetched.ok) return { ok: false, error: fetched.error, say: 'I could not open that page. I can text you the link or take a message.' };
      return { ok: true, title: fetched.url, url: fetched.url, excerpt: fetched.excerpt };
    }
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const hits = pages.map((p) => {
      const hay = (p.title + ' ' + (p.text || '')).toLowerCase();
      const score = words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
      return { title: p.title, url: p.url, excerpt: String(p.text || '').slice(0, 400), score };
    }).filter((p) => p.score > 0 && checkUrl(p.url, t.link_allowlist).ok).sort((a, b) => b.score - a.score).slice(0, 3);
    if (hits.length) return { ok: true, pages: hits.map(({ score, ...rest }) => rest) };
    const kb = this.d.kbFor(t).answer(query || 'website');
    return { ok: true, source: 'knowledge_base', ...kb };
  }
  async sendLink(args, ctx) {
    const t = this.tenant; const log = this.d.log || (() => {});
    if (!t.sms_enabled) return { ok: false, error: 'texting_not_yet_enabled', say: `Texting from this number is not switched on yet. Please visit ${t.link_allowlist[0]}, or I can take a message.` };
    const g = checkOutboundSms({ url: args.url, note: args.note }, t.link_allowlist);
    if (!g.ok) { log('guard.link_blocked', { tenant: t.id, reason: g.reason }); return { ok: false, error: g.reason, say: 'I can only send links to our official website.' }; }
    const queued = t.approval_mode && !t.instant_link_reply;
    if (!queued && !this.d.consent.canText(t.id, ctx.caller)) return { ok: false, error: 'no_consent_or_opted_out' };
    const lim = this.d.rateLimit || (this._lim ||= new SmsRateLimit());
    const gate = lim.allow({ tenant: t.id, caller: ctx.caller, callId: ctx.callId });
    if (!gate.ok) return { ok: false, error: gate.reason, say: 'I have already texted the links I can send on this call. I can read a link aloud or take a message.' };
    if (queued) { const id = this.d.approvals.queue({ tenant: t.id, to: ctx.caller, body: g.body }); return { ok: true, queued_for_approval: id, say: 'I have sent that to the team to text you shortly.' }; }
    const r = await sendCustomerSms({ tenant: t, transport: this.d.smsFor(t), consent: this.d.consent, to: ctx.caller, body: g.body, log });
    return r.ok ? { ok: true, sent: true } : { ok: false, error: r.reason };
  }
}

class Approvals {
  constructor() { this.items = new Map(); this.n = 0; }
  queue(item) { const id = 'apr_' + (++this.n) + '_' + Date.now().toString(36); this.items.set(id, { ...item, id, status: 'pending' }); return id; }
  list(tenantId) { return [...this.items.values()].filter((i) => i.tenant === tenantId); }
}

module.exports = { Tools, Approvals, inHours, DEFS };
