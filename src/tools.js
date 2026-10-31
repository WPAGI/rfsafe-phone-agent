'use strict';
// Tool definitions + dispatcher. Every tool runs with a tenant context; a tool can only touch that
// tenant's KB, Shopify client, numbers, allowlist and consent records (tenant isolation).
const { checkOutboundSms, checkUrl, looksLikeCard } = require('./linkguard');
const { sendCustomerSms } = require('./twilio');
const { SmsRateLimit } = require('./ratelimit');
const { fetchAllowlistedPage } = require('./web');
const { fp, appendJsonl } = require('./util');
const { buildEmail, checkLinks, maskEmail, validEmail, cleanSummary, subjectFor } = require('./email');
const { cleanName } = require('./newsletter');
const EMAILS_PER_CALL = 3;

function inHours(hours, now = new Date()) {
  if (!hours) return true;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: hours.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]));
  const days = hours.days || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  if (!days.includes(parts.weekday)) return false;
  const hm = parts.hour + ':' + parts.minute;
  return hm >= hours.open && hm < hours.close;
}

const DEFS = {
  note_unanswered: { description: 'Call this whenever you could not answer a caller\'s question from kb_answer / website_lookup results (no passage, or the passages did not cover it). Records the topic so staff can add it to the knowledge base. Then say you do not have that information yet and offer to take a message or text a link to rfsafe.org.', parameters: { type: 'object', properties: { question: { type: 'string', description: 'the caller\'s question, in a few words, no personal details' } }, required: ['question'] } },
  kb_answer: { description: 'Look up the answer to a question about the company, its research, or its products in the official knowledge base. Always use this before answering factual questions.', parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } },
  product_search: { description: 'Search the live product catalog (read-only). Returns title, price, availability, and product page URL.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  website_lookup: { description: 'Look up a page on the official website. Returns a title, a short excerpt, and an allowlisted URL. Use this before describing what a page says.', parameters: { type: 'object', properties: { query: { type: 'string' }, url: { type: 'string' } } } },
  send_link: { description: 'Text the caller one link to an official page (product page or article) with a short note. Only official domains are allowed. Never use for payment details. Same rules as send_link_sms.', parameters: { type: 'object', properties: { url: { type: 'string' }, note: { type: 'string' } }, required: ['url'] } },
  set_text_number: { description: 'Voice calls: after the caller says yes to "Is the number you\'re calling from, ending in XXXX, okay to text?", record that consent. Texts can only go to the number they are calling from; a different number is not possible. Never read out the full number.', parameters: { type: 'object', properties: { use_caller_id: { type: 'boolean', description: 'true once the caller said yes' } }, required: ['use_caller_id'] } },
  send_link_sms: { description: 'Text the caller one or more (up to 5) https links on an official domain, plus a short note, in ONE text. Before sending on a voice call, ask "Anything else you\'d like me to include in that text?" and put every requested link in urls so only one text goes out (unless the caller declines more). On calls it goes to the number confirmed with set_text_number. Link-only. Rate-limited per call and per caller. Never use for payment details. Before sending on a voice call, ask once: "Would you also like RF Safe news by text, about once a month plus breaking news, up to 4 messages a month? You are signed up only if you reply YES to the text. Message and data rates may apply, and you can reply STOP anytime." Set news_optin true ONLY on a spoken yes. SKIP the question if set_text_number returned already_news_subscriber: true (thank them once instead).', parameters: { type: 'object', properties: { url: { type: 'string' }, urls: { type: 'array', items: { type: 'string' }, description: 'all links to include in this one text (1-5); use instead of url when there is more than one' }, note: { type: 'string' }, news_optin: { type: 'boolean', description: 'true ONLY if the caller said yes to the news-by-text question; adds a reply-YES confirmation line. They are subscribed only after replying YES.' } }, required: [] } },
  set_email_address: { description: 'Voice calls, email links: for a recognized caller with an email on file, pass email_on_file true (and no email) after they say yes to "your <domain> email on file"; never say the address. Otherwise, after the caller says their email address, spell it back letter by letter and ask "Is that right?". Call this ONLY after the caller gives a spoken yes. One address per call; it cannot be changed later on the call. Returns already_subscriber: if true, the caller is a confirmed RF Safe newsletter subscriber: skip the newsletter question, you may thank them once for being an RF Safe subscriber, ask if there is anything else to include, then send.', parameters: { type: 'object', properties: { email: { type: 'string', description: 'the address exactly as confirmed (omit when email_on_file is true)' }, email_on_file: { type: 'boolean', description: 'true when the caller said yes to using their email on file; the server resolves the address' }, caller_said_yes: { type: 'boolean', description: 'true only after the caller said yes' } }, required: ['caller_said_yes'] } },
  send_email: { description: 'Email the caller, at the address confirmed with set_email_address, either the official links they asked for or a written summary of information they asked for. For information: FIRST call kb_answer (and website_lookup if useful), then write a plain-text summary based ONLY on what those returned (RF Safe knowledge base and rfsafe.org / quantacase.com pages). Never invent studies, figures, quotes or PMIDs. Include 1-5 relevant source links (rfsafe.org, quantacase.com) in urls. No marketing. Before calling this, in order: (1) ask who to address the email to (their first name) and confirm it; (2) ask if there is anything else to include, and batch all requested summaries and links (up to 5) into ONE email (one call); (3) ask once "Would you like to receive RF Safe\'s monthly newsletter? If so, I\'ll include a confirmation link in the email." and set newsletter_optin true only on a spoken yes (SKIP this step if set_email_address returned already_subscriber: true; the server detects subscribers itself); (4) say "If that\'s it, I\'ll send it right now." If an email was already sent this call, tell the caller and only send another if they still want it. Identical repeats are refused. Up to 3 emails per call. After sending, tell the caller it is on its way and to check their spam or junk folder.', parameters: { type: 'object', properties: { urls: { type: 'array', items: { type: 'string' }, description: '1-5 https source links on rfsafe.org or quantacase.com' }, summary: { type: 'string', description: 'optional plain-text summary (up to about 4000 characters, paragraphs separated by blank lines), based only on kb_answer / website_lookup results' }, topic: { type: 'string', description: 'short topic for the subject line, e.g. FCC exposure limits' }, note: { type: 'string', description: 'optional one-line note, e.g. which product' }, recipient_name: { type: 'string', description: 'first name to address the email to, as confirmed with the caller (letters only); omit if they did not give one' }, newsletter_optin: { type: 'boolean', description: 'true ONLY if the caller said yes when asked about the monthly newsletter; adds a confirmation link (they are subscribed only if they click it)' } }, required: ['urls'] } },
  transfer_to_human: { description: 'Transfer the call to a person. Use it whenever the caller explicitly asks for a person, at any hour. If it fails, take a message.', parameters: { type: 'object', properties: { reason: { type: 'string' } } } },
  take_message: { description: 'Take a message for the owner (name, callback number, message).', parameters: { type: 'object', properties: { name: { type: 'string' }, callback: { type: 'string' }, message: { type: 'string' } }, required: ['message'] } },
  sar_lookup: { description: 'Look up a phone model\'s FCC-reported SAR values (head, body, hotspot; cellular-only and with Wi-Fi on) from RF Safe\'s public SAR database. Speak the numbers briefly; never read the URLs aloud.', parameters: { type: 'object', properties: { phone: { type: 'string', description: 'brand and model, e.g. iPhone 17 Pro Max' } }, required: ['phone'] } },
  sar_ranking: { description: 'List the LOWEST-SAR (lowest radiation) phones in RF Safe\'s public SAR database, ranked by FCC-reported SAR. Use for questions like "what is the lowest radiation phone", "which phone has the lowest SAR", or "lowest SAR Samsung". Report the top phones with their head and body SAR in W/kg against the 1.6 limit, and offer the ranking page.', parameters: { type: 'object', properties: { metric: { type: 'string', enum: ['combined', 'head', 'body'], description: 'combined (head + body, default), head, or body' }, brand: { type: 'string', description: 'optional brand filter, e.g. Apple, Samsung' }, limit: { type: 'integer', description: '1-10, default 5' } } } },
  end_call: { description: 'End the call politely after saying goodbye.', parameters: { type: 'object', properties: { reason: { type: 'string' } } } },
  order_status: { description: 'Check a QuantaCase/store order. Ask for the order number AND the email address or phone number used on the order before calling; caller ID also counts as a phone. Share only what comes back (status, items, carrier, delivery estimate, city/state). Never read out a street address or payment details, never take payments, and if it fails just say you could not verify that order and offer to take a message.', parameters: { type: 'object', properties: { order_number: { type: 'string', description: 'digits, e.g. 1146' }, email: { type: 'string', description: 'email on the order, if the caller gave one' }, phone: { type: 'string', description: 'phone on the order, if different from caller ID' } }, required: ['order_number'] } },
};

class Tools {
  // deps: { kbFor(tenant), shopifyFor(tenant), smsFor(tenant), consent, callControl, notify, approvals, log, now }
  constructor(tenant, deps) { this.tenant = tenant; this.d = deps; }
  definitions() {
    const names = ['kb_answer', 'note_unanswered', 'website_lookup', 'send_link', 'send_link_sms', 'take_message', 'end_call', 'transfer_to_human'];
    if (this.tenant.shopify) names.splice(2, 0, 'product_search');
    if (this.tenant.sar_lookup && this.d.sarFor) names.splice(1, 0, 'sar_lookup', 'sar_ranking');
    if (this.tenant.order_lookup_enabled && this.tenant.shopify) names.push('order_status');
    if (this.tenant.sms_enabled) names.splice(names.indexOf('send_link'), 0, 'set_text_number');
    if (this.tenant.email_enabled && this.d.emailFor) names.splice(names.indexOf('take_message'), 0, 'set_email_address', 'send_email');
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
        case 'kb_answer': { const q = String(args.question || '').slice(0, 500); const a = this.d.kbFor(t).answer(q); if (!a.found) this.gapLog({ tenant: t.id, question: q.slice(0, 200), reason: 'no_match', ...this.gapCtx(ctx) }); return { ok: true, ...a, ...(a.found ? { guidance: a.guidance + ' If these passages do not actually answer the question, call note_unanswered and do not guess.' } : {}) }; }
        case 'note_unanswered': { this.gapLog({ tenant: t.id, question: String(args.question || '').slice(0, 200), reason: 'model_unanswered', ...this.gapCtx(ctx) }); return { ok: true, say: 'I do not have that information yet. I can take a message for the RF Safe team or text you a link to rfsafe.org.' }; }
        case 'website_lookup': return await this.websiteLookup(args);
        case 'sar_ranking': { const r = await this.d.sarFor(t).lowest({ metric: ['head', 'body', 'combined'].includes(args.metric) ? args.metric : 'combined', brand: String(args.brand || '').slice(0, 40), limit: Number(args.limit) || 5 }); if (!checkUrl(r.ranking, t.link_allowlist).ok) delete r.ranking; for (const p of r.phones) if (!checkUrl(p.sar_page, t.link_allowlist).ok) delete p.sar_page; return { ok: true, ...r }; }
        case 'sar_lookup': { const r = await this.d.sarFor(t).lookup(String(args.phone || '').slice(0, 120)); if (!r.found) return { ok: true, found: false, close_matches: r.close || [], say: 'I could not find that exact model in our SAR database. Ask for the exact model name, or offer to text the SAR lookup page.' }; for (const k of ['sar_page', 'kids_visual', 'ranking']) if (!checkUrl(r[k], t.link_allowlist).ok) delete r[k]; return { ok: true, ...r }; }
        case 'product_search': {
          const items = await this.d.shopifyFor(t).searchProducts(args.query, 5);
          return { ok: true, products: items.filter((p) => require('./linkguard').checkUrl(p.url, t.link_allowlist).ok) };
        }
        case 'send_link_sms': return await this.sendLink(args, ctx);
        case 'set_text_number': return this.setTextNumber(args, ctx);
        case 'set_email_address': return this.setEmailAddress(args, ctx);
        case 'send_email': return await this.sendEmail(args, ctx);
        case 'transfer_to_human': {
          if (ctx.channel !== 'voice') return { ok: false, error: 'voice_only' };
          if (!t.transfer_target) return { ok: false, error: 'no_transfer_target', say: 'I can take a message instead.' };
          if (ctx.caller && t.transfer_target.replace(/^tel:/, '') === ctx.caller) return { ok: false, error: 'caller_is_transfer_target', say: 'The caller is the person calls transfer to. Help directly or take a note instead.' };
          if (t.transfer_hours_only === true && !inHours(t.hours, this.d.now ? this.d.now() : new Date())) return { ok: false, error: 'after_hours', say: 'The team is away right now. I can take a message or text you a link.' };
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
        case 'order_status': {
          // at most 3 failed checks per call (or per caller on SMS): stops order-number/email guessing
          const key = t.id + '|' + (ctx.callId || ctx.caller || '');
          const fails = (this._orderFails ||= new Map());
          if ((fails.get(key) || 0) >= 3) return { ok: false, error: 'too_many_attempts', say: 'I can\'t check more orders on this call. I can take a message and the team will follow up.' };
          const r = await this.d.shopifyFor(t).orderStatus({ orderName: String(args.order_number || '').slice(0, 20), email: String(args.email || '').slice(0, 120), phone: String(args.phone || '').slice(0, 30), callerPhone: ctx.caller });
          if (!r.ok && r.reason === 'not_found_or_not_verified') fails.set(key, (fails.get(key) || 0) + 1);
          log('order.lookup', { tenant: t.id, ok: !!r.ok, reason: r.reason || null });
          if (!r.ok) return { ok: false, error: r.reason, say: r.reason === 'need_email_or_phone' ? 'Ask for the email or phone number used on the order.' : r.reason === 'bad_order_number' ? 'Ask for the order number again; it is the number in the order confirmation email.' : r.reason === 'order_lookup_not_connected' ? 'Order lookup is not available right now. Offer to take a message.' : 'Say you could not verify that order with those details, and offer to try the other contact detail or take a message.' };
          return r;
        }
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
    // voice: only to the number the caller confirmed on this call; SMS: reply to the sender
    const to = ctx.channel === 'voice' ? this.textNumberFor(ctx) : ctx.caller;
    if (!to) return { ok: false, error: 'confirm_number_first', say: ctx.caller ? `Ask: "Is the number you're calling from, ending in ${last4(ctx.caller)}, okay to text?" and call set_text_number if they say yes.` : 'Caller ID is blocked, so texting is not possible on this call. Texts only go to the number the caller is calling from. Offer to say the site name aloud or take a message.' };
    const list = [].concat(args.urls || [], args.url ? [args.url] : []).map(String).filter((u, i, a) => u && a.indexOf(u) === i);
    if (!list.length) return { ok: false, error: 'no_link' };
    if (list.length > 5) return { ok: false, error: 'too_many_links', say: 'I can include up to 5 links in one text.' };
    const g = checkOutboundSms({ url: list[0], note: args.note }, t.link_allowlist);
    if (!g.ok) { log('guard.link_blocked', { tenant: t.id, reason: g.reason }); return { ok: false, error: g.reason, say: 'I can only send links to our official website.' }; }
    for (const u of list.slice(1)) { const c = checkUrl(u, t.link_allowlist); if (!c.ok) { log('guard.link_blocked', { tenant: t.id, reason: c.reason }); return { ok: false, error: c.reason, say: 'I can only send links to our official website.' }; } g.body += '\n' + c.url; }
    const queued = t.approval_mode && !t.instant_link_reply;
    if (!queued && !this.d.consent.canText(t.id, to)) return { ok: false, error: 'no_consent_or_opted_out' };
    const lim = this.d.rateLimit || (this._lim ||= new SmsRateLimit());
    const gate = lim.allow({ tenant: t.id, caller: to, callId: ctx.callId });
    if (!gate.ok) return { ok: false, error: gate.reason, say: 'I have already texted the links I can send on this call. I can read a link aloud or take a message.' };
    if (queued) { const id = this.d.approvals.queue({ tenant: t.id, to, body: g.body }); return { ok: true, queued_for_approval: id, say: 'I have sent that to the team to text you shortly.' }; }
    const nl = this.d.newsletter; let body = g.body; let newsInvite = false;
    if (ctx.channel === 'voice' && args.news_optin === true && nl) {
      let st = { status: 'none' }; try { st = nl.smsState(t.id, to); } catch { /* ignore */ }
      if (st.status !== 'subscribed') { const { newsSmsInvite } = require('./newsletter'); const inv = newsSmsInvite(t.name); body = body + '\n' + inv; newsInvite = true; try { nl.requestSms({ tenant: t.id, phone: to, call: ctx.callId, email: (this._emailTo && this._emailTo.get(t.id + '|' + ctx.callId)) || null, wording: { spoken: require('./newsletter').NEWS_SMS_SPOKEN, text: inv } }); } catch { /* never break a call */ } }
    }
    let r; try { r = await sendCustomerSms({ tenant: t, transport: this.d.smsFor(t), consent: this.d.consent, to, body, log }); } catch (e) { log('sms.send_error', { tenant: t.id, err: String(e.message).slice(0, 120) }); r = { ok: false, reason: 'provider_error' }; }
    this.archive({ channel: 'sms', tenant: t.id, call: ctx.callId, to, text: body, provider_id: r.sid || null, error: r.ok ? null : r.reason, caller: ctx.caller });
    if (newsInvite) log('newsletter.sms_requested', { tenant: t.id, call: ctx.callId, to: fp(to), sent: !!r.ok });
    return r.ok ? { ok: true, sent: true, to_last4: last4(to), ...(newsInvite ? { news_invite: true, say_after: 'Tell the caller: to join the news texts, just reply YES to that text.' } : {}) } : { ok: false, error: r.reason };
  }
  // Where a gap came from, for the owner briefing: channel, conversation id, caller last 4 only.
  gapCtx(ctx) { return { channel: ctx && ctx.channel, call: (ctx && ctx.callId) || null, from_last4: ctx && ctx.caller ? String(ctx.caller).replace(/\D/g, '').slice(-4) || null : null }; }
  gapLog(ev) { if (this.d.kbGapFile) { try { appendJsonl(this.d.kbGapFile, { at: new Date().toISOString(), ...ev }); } catch { /* ignore */ } } }
  archive(rec) { if (this.d.sentMessages) { try { this.d.sentMessages.add(rec); } catch { /* never break a call */ } } }
  emailLog(ev) { if (this.d.emailLogFile) { try { appendJsonl(this.d.emailLogFile, { at: new Date().toISOString(), ...ev }); } catch { /* ignore */ } } }
  setEmailAddress(args, ctx) {
    const t = this.tenant; const log = this.d.log || (() => {});
    if (!['voice', 'sms'].includes(ctx.channel) || !ctx.callId) return { ok: false, error: 'voice_only' };
    if (args.caller_said_yes !== true) return { ok: false, error: 'need_confirmation', say: 'Spell the address back letter by letter and ask "Is that right?" Call again only after they say yes.' };
    let onFile = false; let email = String(args.email || '').trim().toLowerCase();
    if (args.email_on_file === true) {
      let f = null; try { f = t.returning_caller_greeting !== false && ctx.caller && this.d.newsletter ? this.d.newsletter.emailOnFile(t.id, ctx.caller) : null; } catch { f = null; }
      if (!f) return { ok: false, error: 'no_email_on_file', say: 'Ask the caller for their email address, spell it back, and call set_email_address with it after they say yes.' };
      email = f; onFile = true;
    }
    if (!validEmail(email)) return { ok: false, error: 'invalid_email', say: 'That does not look like a full email address. Ask the caller to say it again.' };
    const map = (this._emailTo ||= new Map()); const cur = map.get(t.id + '|' + ctx.callId);
    if (cur && cur !== email) return { ok: false, error: 'one_address_per_call', say: 'I can only email one address per call, so I will keep using the one we confirmed.' };
    map.set(t.id + '|' + ctx.callId, email); if (onFile) (this._onFile ||= new Set()).add(t.id + '|' + ctx.callId);
    const masked = maskEmail(email);
    log('email.address_confirmed', { tenant: t.id, call: ctx.callId, to: masked, from: fp(ctx.caller) });
    this.emailLog({ kind: onFile ? 'consent_verbal_call_on_file' : 'consent_verbal_call', tenant: t.id, call: ctx.callId, to_masked: masked, to_fp: fp(email), caller_fp: ctx.caller ? fp(ctx.caller) : null });
    let sub = false; try { sub = !!(this.d.newsletter && this.d.newsletter.isSubscriber(t.id, email)); } catch { sub = false; }
    let fn = null; if (onFile) { try { const rc = this.d.newsletter.returningCaller(t.id, ctx.caller); fn = rc && rc.firstName; } catch { fn = null; } if (fn) (this._onFileName ||= new Map()).set(t.id + '|' + ctx.callId, fn); }
    if (onFile) return { ok: true, confirmed: true, email_on_file: true, already_subscriber: sub, ...(fn ? { sender_name: fn } : {}), say: (fn ? `Address the email to ${fn} (pass recipient_name ${fn}); do not ask for their name. ` : '') + 'Using their email on file. Never say or spell the address or the part before the @; call it only "your email on file".' + (sub ? ' They are already a confirmed RF Safe newsletter subscriber: do NOT ask about the newsletter.' : '') };
    return sub ? { ok: true, confirmed: true, email_masked: masked, already_subscriber: true, say: 'This caller is already a confirmed RF Safe newsletter subscriber. Do NOT ask about the newsletter. Say something warm like "Great, I\'ll make sure that gets to you." You may thank them once for being an RF Safe subscriber. Do not mention any list lookup.' } : { ok: true, confirmed: true, email_masked: masked, already_subscriber: false };
  }
  async sendEmail(args, ctx) {
    const t = this.tenant; const log = this.d.log || (() => {});
    if (!['voice', 'sms'].includes(ctx.channel) || !ctx.callId) return { ok: false, error: 'voice_only' };
    const key = t.id + '|' + ctx.callId; const to = (this._emailTo || new Map()).get(key);
    if (!to) return { ok: false, error: 'confirm_email_first', say: 'Ask for their email address, spell it back, and call set_email_address after they say yes.' };
    const sig = require('crypto').createHash('sha256').update(JSON.stringify([String(args.summary || '').trim(), [].concat(args.urls ?? args.url ?? []).map(String).sort()])).digest('hex');
    const sent = (this._emailSigs ||= new Map()); const sigs = sent.get(key) || new Set();
    if (sigs.has(sig)) return { ok: false, error: 'duplicate_email', say: 'That exact email was already sent on this call. Tell the caller it is on its way and to check spam or junk; do not send it again.' };
    const counts = (this._emailCount ||= new Map()); const n = counts.get(key) || 0;
    if (n >= EMAILS_PER_CALL) return { ok: false, error: 'email_limit_reached', say: 'I have already sent the emails I can send on this call. I can say the site name aloud or take a message.' };
    const g = checkLinks(args.urls ?? args.url, t.link_allowlist);
    if (!g.ok) { log('guard.link_blocked', { tenant: t.id, reason: g.reason, channel: 'email' }); return { ok: false, error: g.reason, say: 'I can only email links to our official websites.' }; }
    const note = String(args.note || '').replace(/https?:\/\/\S+|www\.\S+/gi, '').replace(/\s+/g, ' ').trim().slice(0, 140);
    const summary = cleanSummary(args.summary, t.link_allowlist);
    if (summary && looksLikeCard(summary)) return { ok: false, error: 'blocked_content', say: 'I cannot email that. I can send just the links instead.' };
    const name = cleanName(args.recipient_name) || (this._onFileName || new Map()).get(key) || '';
    let isSub = false; try { isSub = !!(this.d.newsletter && this.d.newsletter.isSubscriber(t.id, to)); } catch { isSub = false; }
    const nl = isSub ? { subscriber: true, unsubscribeUrl: this.d.newsletter.unsubscribeUrl({ email: to, name, tenant: t.id }) } : args.newsletter_optin === true && this.d.newsletter ? { confirmUrl: this.d.newsletter.confirmUrl({ email: to, name, tenant: t.id }), unsubscribeUrl: this.d.newsletter.unsubscribeUrl({ email: to, name, tenant: t.id }) } : null;
    if (nl && ctx.caller && this.d.newsletter && !(isSub && this.d.newsletter.emailOnFile && this.d.newsletter.emailOnFile(t.id, ctx.caller) === to)) { try { this.d.newsletter.linkPhone({ tenant: t.id, email: to, phone: ctx.caller, call: ctx.callId }); } catch { /* ignore */ } }
    const { text, html } = buildEmail({ links: g.links, note, summary, name, newsletter: nl });
    const subject = subjectFor(args.topic, !!summary);
    counts.set(key, n + 1); sigs.add(sig); sent.set(key, sigs); // count attempts, so a failing provider cannot be retried without limit
    let r; try { r = await this.d.emailFor(t).send({ to, replyTo: t.support_email || undefined, subject, text, html }); } catch (e) { r = { ok: false, reason: 'provider_error' }; }
    this.archive({ channel: 'email', tenant: t.id, call: ctx.callId, to, subject, text, html, links: g.links.map((l) => l.url).concat(require('./messages').extractLinks(text, html)).filter((x, i, a) => a.indexOf(x) === i), provider_id: r.id || null, error: r.ok ? null : r.reason, caller: ctx.caller });
    const masked = maskEmail(to);
    log('email.sent', { tenant: t.id, call: ctx.callId, ok: !!r.ok, to: masked, links: g.links.length, summary_chars: summary.length, named: !!name, newsletter_link: !!(nl && nl.confirmUrl), subscriber: isSub, reason: r.ok ? undefined : r.reason });
    this.emailLog({ kind: r.ok ? 'sent' : 'send_failed', tenant: t.id, call: ctx.callId, to_masked: masked, to_fp: fp(to), links: g.links.map((l) => l.url), newsletter_link: !!(nl && nl.confirmUrl), subscriber: isSub, provider_id: r.id || null, reason: r.ok ? undefined : r.reason });
    const hide = (this._onFile || new Set()).has(key);
    return r.ok ? { ok: true, sent: true, ...(hide ? { to: 'email on file' } : { to_masked: masked }), say: 'Done, it is on its way from rfsafe@callbots.org. If you do not see it in a minute or two, please check your spam or junk folder.' } : { ok: false, error: r.reason, say: 'The email did not go through. I can say the site name aloud or take a message.' };
  }
  textNumberFor(ctx) { return ctx.callId ? (this._textTo || new Map()).get(ctx.callId) || null : null; }
  setTextNumber(args, ctx) {
    const t = this.tenant; const log = this.d.log || (() => {});
    if (ctx.channel !== 'voice' || !ctx.callId) return { ok: false, error: 'voice_only' };
    if (!t.sms_enabled) return { ok: false, error: 'texting_not_yet_enabled', say: `Texting from this number is not switched on yet. Please visit ${t.link_allowlist[0]}, or I can take a message.` };
    // Texts go only to the caller's own number (anti-spam): no other number can be set.
    if (args.number) return { ok: false, error: 'caller_number_only', say: 'For privacy, texts can only go to the number you are calling from. I can say the site name aloud or take a message.' };
    if (!ctx.caller) return { ok: false, error: 'no_caller_id', say: 'Caller ID is blocked, so I cannot text this call. Offer to say the site name aloud or take a message.' };
    if (args.use_caller_id !== true) return { ok: false, error: 'need_confirmation' };
    const to = ctx.caller;
    if (this.d.consent.isOptedOut && this.d.consent.isOptedOut(t.id, to)) return { ok: false, error: 'opted_out', say: 'That number has opted out of texts. They can text START to opt back in.' };
    this.d.consent.record(t.id, to, 'verbal_call');
    (this._textTo ||= new Map()).set(ctx.callId, to);
    log('sms.number_confirmed', { tenant: t.id, call: ctx.callId, source: 'caller_id', to: fp(to) });
    let sub = false; try { sub = !!(this.d.newsletter && this.d.newsletter.isSmsSubscriber(t.id, to)); } catch { sub = false; }
    return sub ? { ok: true, confirmed: true, number_last4: last4(to), already_news_subscriber: true, say: 'This number already gets RF Safe news texts. Do NOT ask about news texts. You may thank them once for being an RF Safe subscriber. Do not mention any list lookup.' } : { ok: true, confirmed: true, number_last4: last4(to) };
  }
}

const last4 = (n) => String(n || '').replace(/\D/g, '').slice(-4);

class Approvals {
  constructor() { this.items = new Map(); this.n = 0; }
  queue(item) { const id = 'apr_' + (++this.n) + '_' + Date.now().toString(36); this.items.set(id, { ...item, id, status: 'pending' }); return id; }
  list(tenantId) { return [...this.items.values()].filter((i) => i.tenant === tenantId); }
}

module.exports = { Tools, Approvals, inHours, DEFS };
