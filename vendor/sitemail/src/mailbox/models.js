'use strict';
// xAI model catalog for the Mailbox bots: read live from xAI's language-models list (server-side, XAI_API_KEY),
// cached for 6 hours, with a fixed fallback list. Prices are USD per million tokens.
const LIVE_URL = 'https://api.x.ai/v1/language-models';
const PRICE_SOURCE = 'https://docs.x.ai/developers/pricing';
const FALLBACK = [
  { id: 'grok-4.7', in: 2, cached: 0.5, out: 6 },
  { id: 'grok-4.6', in: 2, cached: 0.5, out: 6 },
  { id: 'grok-4.5', in: 2, cached: 0.3, out: 6 },
  { id: 'grok-4.3', in: 1.25, cached: 0.2, out: 2.5 },
  { id: 'grok-4.20-0309-non-reasoning', in: 1.25, cached: 0.2, out: 2.5 },
  { id: 'grok-4.20-0309-reasoning', in: 1.25, cached: 0.2, out: 2.5 },
];
const DEFAULTS = { fast: 'grok-4.20-0309-non-reasoning', best: 'grok-4.7' };
const ID = /^[a-z0-9][a-z0-9.-]{1,59}$/i;
class ModelCatalog {
  #key;
  constructor({ key, fetchImpl, now = () => Date.now(), ttlMs = 6 * 3600000 }) { this.#key = key || ''; this.fetch = fetchImpl; this.now = now; this.ttl = ttlMs; this.cache = null; }
  // xAI reports prices in units of 1e-10 USD per token (= 1/10000 USD per million tokens).
  static fromLive(j) {
    return (Array.isArray(j && j.models) ? j.models : []).filter(m => m && ID.test(String(m.id)) && (m.output_modalities || ['text']).includes('text') && !/multi-agent|^grok-build|code/i.test(m.id))
      .map(m => ({ id: m.id, aliases: (m.aliases || []).filter(a => ID.test(a)).slice(0, 20), in: Number(m.prompt_text_token_price) / 10000, cached: Number(m.cached_prompt_text_token_price) / 10000, out: Number(m.completion_text_token_price) / 10000 }))
      .filter(m => [m.in, m.cached, m.out].every(Number.isFinite));
  }
  async list() {
    if (this.cache && this.now() - this.cache.at < this.ttl) return this.cache.value;
    let value = { source: 'fallback', price_source: PRICE_SOURCE + ' (set list)', models: FALLBACK.map(m => ({ ...m, aliases: [] })), defaults: DEFAULTS };
    if (this.#key && this.fetch) {
      try {
        const r = await this.fetch(LIVE_URL, { headers: { authorization: 'Bearer ' + this.#key }, signal: AbortSignal.timeout(8000) });
        if (r.ok) { const models = ModelCatalog.fromLive(await r.json()); if (models.length) value = { source: 'xai_live', price_source: LIVE_URL + ' (xAI-published prices)', models, defaults: DEFAULTS }; }
      } catch { /* fall back */ }
    }
    this.cache = { at: this.now(), value }; return value;
  }
  // Cached, synchronous price lookup (falls back to the set list).
  price(model) { const list = (this.cache && this.cache.value.models) || FALLBACK; return list.find(m => m.id === model || (m.aliases || []).includes(model)) || FALLBACK.find(m => m.id === model) || null; }
  async has(model) { const l = await this.list(); return l.models.some(m => m.id === model || (m.aliases || []).includes(model)); }
}
module.exports = { ModelCatalog, FALLBACK, DEFAULTS, LIVE_URL, PRICE_SOURCE };
