'use strict';
// Inbound SMS: STOP/HELP first, record consent, then the same brain + tools as voice, then a guarded reply.
const { STOP_WORDS, START_WORDS, HELP_WORDS } = require('./twilio');
const { checkUrl, looksLikeCard } = require('./linkguard');
const { fp } = require('./util');

const URLISH = /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/gi;
// Final reply guard: any link not on the allowlist is removed; payment-looking content is refused.
function guardReply(text, allowlist) {
  text = String(text || '').slice(0, 640);
  if (looksLikeCard(text)) return 'For your security we never handle payment details by text. Please order on our website.';
  return text.replace(URLISH, (m) => { const u = /^https?:/i.test(m) ? m : 'https://' + m; return checkUrl(u.replace(/[).,!?]+$/, ''), allowlist).ok ? m : '[link removed]'; });
}

// Offline brain for demo/tests: keyword routing over the same tools. Clearly not an AI.
class MockBrain {
  async reply({ tools, text }) {
    if (/\b(buy|price|cost|case|order|product|iphone|samsung|galaxy|pixel)\b/i.test(text) && tools.definitions().some((d) => d.name === 'product_search')) {
      const r = await tools.run('product_search', { query: text.replace(/[^\w\s]/g, ' ').replace(/\b(how|much|is|the|a|for|price|cost|buy|i|want|to|do|you|have)\b/gi, ' ').trim() || text });
      if (r.ok && r.products.length) { const p = r.products[0]; return `${p.title}: $${p.price}${p.available ? '' : ' (currently unavailable)'}. Order on our site: ${p.url}`; }
    }
    const k = await tools.run('kb_answer', { question: text });
    if (k.found) { const h = k.passages[0]; return h.text.split(/(?<=\.)\s/).slice(0, 2).join(' ').slice(0, 300) + (h.source ? ' More: ' + h.source : ''); }
    return 'Thanks for your message. I do not have that answer, so I have passed it to the team.';
  }
}

// Real brain: xAI chat completions with the tenant's function tools (OpenAI-compatible tool loop).
class XaiTextBrain {
  constructor({ apiKey, model = 'grok-4.3', fetchImpl = globalThis.fetch }) { this.key = apiKey; this.model = model; this.fetch = fetchImpl; }
  async reply({ tools, text, instructions }) {
    const msgs = [{ role: 'system', content: instructions + '\nYou are replying by SMS: at most 2 short sentences plus at most one link.' }, { role: 'user', content: text }];
    const defs = tools.definitions().filter((d) => !['transfer_to_human', 'end_call'].includes(d.name)).map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.parameters } }));
    for (let i = 0; i < 4; i++) {
      const r = await this.fetch('https://api.x.ai/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + this.key, 'content-type': 'application/json' }, body: JSON.stringify({ model: this.model, messages: msgs, tools: defs }) });
      if (!r.ok) throw new Error('xai ' + r.status);
      const m = (await r.json()).choices[0].message; msgs.push(m);
      if (!m.tool_calls || !m.tool_calls.length) return m.content;
      for (const c of m.tool_calls) { let a = {}; try { a = JSON.parse(c.function.arguments || '{}'); } catch { /* ignore */ } const out = await tools.run(c.function.name, a); msgs.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(out) }); }
    }
    return 'Thanks, I have passed your message to the team.';
  }
}

async function handleInboundSms({ tenant, from, body, consent, toolsFor, brain, instructions, log }) {
  const text = String(body || '').trim();
  if (STOP_WORDS.test(text)) { consent.record(tenant.id, from, 'stop'); log('sms.stop', { tenant: tenant.id, from: fp(from) }); return `You are unsubscribed from ${tenant.name} texts. No more messages will be sent. Reply START to resubscribe.`; }
  if (START_WORDS.test(text)) { consent.record(tenant.id, from, 'start'); return `You are resubscribed to ${tenant.name}. Reply STOP to opt out, HELP for help.`; }
  consent.record(tenant.id, from, 'inbound');
  if (HELP_WORDS.test(text)) return `${tenant.name} support (AI assistant). Visit https://${tenant.link_allowlist[0]} or call this number. Reply STOP to opt out. Msg&data rates may apply.`;
  if (looksLikeCard(text)) { log('guard.payment_blocked', { tenant: tenant.id, channel: 'sms' }); return 'Please do not text card details. We never take payment by text. You can order securely on our website.'; }
  const tools = toolsFor(tenant).ctxCall({ channel: 'sms', caller: from });
  const toolsView = { definitions: () => toolsFor(tenant).definitions(), run: tools.run };
  let out;
  try { out = await brain.reply({ tools: toolsView, text: text.slice(0, 1000), instructions }); } catch (e) { log('sms.brain_error', { tenant: tenant.id, err: e.message }); out = 'Thanks for your message. The team will get back to you.'; }
  return guardReply(out, tenant.link_allowlist);
}

module.exports = { handleInboundSms, guardReply, MockBrain, XaiTextBrain };
