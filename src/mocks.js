'use strict';
// Mock xAI / Twilio / Shopify for demo mode and tests. EXAMPLE DATA ONLY.
const { EventEmitter } = require('events');

class MockRealtimeWs extends EventEmitter {
  constructor() { super(); this.sent = []; }
  send(s) { this.sent.push(JSON.parse(s)); }
  serverEvent(ev) { this.emit('message', Buffer.from(JSON.stringify(ev))); }
  close() { this.emit('close'); }
}
class MockCallControl { constructor({ referStatus = 200 } = {}) { this.refers = []; this.hangups = []; this.referStatus = referStatus; } async refer(id, uri) { this.refers.push({ id, uri }); return { ok: this.referStatus === 200, status: this.referStatus }; } async hangup(id) { this.hangups.push(id); return { ok: true, status: 200 }; } }

// EXAMPLE DATA: fake catalog shaped like Shopify's public /search/suggest.json response.
const EXAMPLE_PRODUCTS = [
  { title: 'EXAMPLE QuantaCase for iPhone 17', handle: 'example-quantacase-iphone-17', price: '39.99', available: true },
  { title: 'EXAMPLE QuantaCase for Samsung Galaxy S26', handle: 'example-quantacase-galaxy-s26', price: '39.99', available: true },
  { title: 'EXAMPLE QuantaCase for Pixel 10', handle: 'example-quantacase-pixel-10', price: '34.99', available: false },
];
function mockShopifyFetch(products = EXAMPLE_PRODUCTS) {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET' });
    if ((opts.method || 'GET') !== 'GET') return { ok: false, status: 405, json: async () => ({}) };
    const q = new URL(url).searchParams.get('q') || '';
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = products.filter((p) => words.some((w) => p.title.toLowerCase().includes(w)));
    return { ok: true, status: 200, json: async () => ({ resources: { results: { products: hits } } }) };
  };
  f.calls = calls; return f;
}

module.exports = { MockRealtimeWs, MockCallControl, mockShopifyFetch, EXAMPLE_PRODUCTS };
