'use strict';

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function renderLanding({ mode = 'demo', tenants = 0 }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>callbots.org</title>
<style>
  body { margin: 0; background: #10211c; color: #f3f0e7; font-family: Georgia, "Iowan Old Style", serif; }
  main { max-width: 38rem; margin: 0 auto; padding: 3.2rem 1.3rem 4rem; }
  .mark { font-family: ui-sans-serif, sans-serif; letter-spacing: .14em; text-transform: uppercase; font-size: .72rem; color: #8fd0c0; margin: 0; }
  h1 { font-weight: 500; font-size: 2.3rem; line-height: 1.15; margin: .55rem 0 1rem; }
  p { line-height: 1.5; font-size: 1.05rem; }
  .status { margin-top: 2rem; border: 1px solid #2c5c50; padding: 1rem 1.1rem; }
  dt { font-family: ui-sans-serif, sans-serif; font-size: .72rem; letter-spacing: .08em; text-transform: uppercase; color: #8fd0c0; margin-top: .7rem; }
  dd { margin: .15rem 0 0; }
</style>
</head>
<body>
<main>
  <p class="mark">callbots.org</p>
  <h1>Phone agents for the businesses that answer.</h1>
  <p>Quanta X Technology runs this service. It answers RF Safe support calls, looks up the knowledge base and the product catalog, and texts a purchase link. It never takes a payment.</p>
  <p>The public name will be callbots.org. This host is the tool and webhook server between the Twilio number and the xAI Grok Voice agent. Other businesses connect the same way: a number, a Shopify shop, a website, and a knowledge base.</p>
  <div class="status">
    <dl>
      <dt>Status</dt><dd>Operational</dd>
      <dt>Mode</dt><dd>${esc(mode)}</dd>
      <dt>Tenants loaded</dt><dd>${esc(tenants)}</dd>
      <dt>Payments</dt><dd>Not supported</dd>
    </dl>
  </div>
</main>
</body>
</html>`;
}

module.exports = { renderLanding };
