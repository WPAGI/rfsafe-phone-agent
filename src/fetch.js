'use strict';
// Outbound HTTP with a timeout on every call. GET/HEAD retry on network errors and 429/5xx.
// POST is not retried unless opts.idempotent is set, so SMS sends and SIP REFER cannot double-fire.
function createFetch({ fetchImpl = globalThis.fetch, timeoutMs = 8000, retries = 2, backoffMs = 50 } = {}) {
  return async function request(url, opts = {}) {
    const method = String(opts.method || 'GET').toUpperCase();
    const extra = opts.idempotent ? 1 : 0;
    const attempts = (method === 'GET' || method === 'HEAD' ? retries : extra) + 1;
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, { ...opts, signal: opts.signal || ctrl.signal });
        const retryable = res.status === 429 || res.status >= 500;
        const mayRetry = attempt < attempts && retryable && (method === 'GET' || method === 'HEAD' || opts.idempotent);
        if (mayRetry) {
          await wait(backoffMs * attempt);
          continue;
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (attempt >= attempts) throw err;
        await wait(backoffMs * attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  };
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

module.exports = { createFetch };
