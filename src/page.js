'use strict';

const TITLE = 'AI Phone Agent & Receptionist for Small Business | CallBots';
const DESCRIPTION = 'CallBots is an AI receptionist and voice AI agent. It answers calls 24/7 from your site and Shopify catalog, then texts a purchase link. It never takes payment.';
const CANONICAL = 'https://callbots.org/';
const MAIL = 'mailto:support@quantaxtechnology.com';

const FAQ = [
  {
    q: 'What is an AI phone agent?',
    a: 'An AI phone agent answers your business number in a spoken conversation. CallBots uses Grok Voice, a natural language voice agent, so callers talk in sentences instead of pressing menu buttons.',
  },
  {
    q: 'Is CallBots an AI receptionist or an AI answering service?',
    a: 'Both names fit. CallBots is an AI receptionist and an AI answering service for small businesses. It greets the caller, answers from your own material, and either texts a link, transfers the call, or takes a message.',
  },
  {
    q: 'How is this different from a virtual receptionist at a call center?',
    a: 'A traditional answering service puts a person on the line, usually for the hours or minutes in a monthly plan. CallBots is a voice AI agent that answers 24/7 from your knowledge base, website, and Shopify catalog. A person on your team still gets the call during the hours you choose.',
  },
  {
    q: 'Does the AI customer service phone take payments?',
    a: 'No. CallBots never takes a payment. It does not ask for card numbers, bank details, or checkout on the call. If someone wants to buy, it texts a link to the product page on your site.',
  },
  {
    q: 'Can it do Shopify AI phone support?',
    a: 'Yes. The agent can search your Shopify catalog and read back the product name, price, and whether it is available. The purchase happens on your store after the caller opens the texted link.',
  },
  {
    q: 'What happens after hours?',
    a: 'The AI call bot still answers. It does not transfer after the hours you set. It offers a texted link or takes a message for your team.',
  },
  {
    q: 'How does setup work for more than one business?',
    a: 'Each business gets its own agent: a phone number, a Shopify shop if you have one, a website, and a knowledge base. Callers hear that business, not CallBots. An agency can run one agent per client.',
  },
  {
    q: 'How long does click-to-connect setup take?',
    a: 'The connect flow is the number, the shop, the website, and the knowledge base. It is built to be finished in minutes, not a multi-week installation. Early access is opened by email so we can confirm the details with you.',
  },
  {
    q: 'How does pricing work?',
    a: 'Pricing is simple and usage-based. There is no per-seat fee. There is no rate card on this page. Email support@quantaxtechnology.com and we will quote you before anything goes live.',
  },
  {
    q: 'Which businesses is a small business answering service like this for?',
    a: 'Shops that sell on Shopify, local service companies, professional offices, hospitality, and agencies that want a separate agent for each client. The agent only says what is in that business\'s knowledge base, website, and catalog.',
  },
];

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function jsonLdScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function structuredData() {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': CANONICAL + '#organization',
        name: 'Quanta X Technology LLC',
        url: CANONICAL,
        email: 'support@quantaxtechnology.com',
        address: {
          '@type': 'PostalAddress',
          addressLocality: 'Seminole',
          addressRegion: 'FL',
          addressCountry: 'US',
        },
        brand: { '@type': 'Brand', name: 'CallBots' },
      },
      {
        '@type': 'SoftwareApplication',
        '@id': CANONICAL + '#software',
        name: 'CallBots',
        applicationCategory: 'BusinessApplication',
        applicationSubCategory: 'AI phone agent',
        operatingSystem: 'Web',
        url: CANONICAL,
        description: DESCRIPTION,
        provider: { '@id': CANONICAL + '#organization' },
        featureList: [
          '24/7 natural language voice agent',
          'Answers from your knowledge base and website',
          'Shopify product lookup',
          'Texts purchase links',
          'Does not take payments',
          'Transfers to a person during business hours',
          'Takes a message after hours',
          'Separate agent per business',
        ],
        offers: {
          '@type': 'Offer',
          description: 'Usage-based pricing with no per-seat fee. Contact us for a quote.',
          url: MAIL + '?subject=CallBots%20pricing',
          availability: 'https://schema.org/PreOrder',
        },
      },
      {
        '@type': 'FAQPage',
        '@id': CANONICAL + '#faq',
        mainEntity: FAQ.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
    ],
  };
}

const ROBOTS = `User-agent: *
Allow: /

Sitemap: https://callbots.org/sitemap.xml
`;

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://callbots.org/</loc>
    <lastmod>2026-10-30</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`;

function renderLanding() {
  const faqHtml = FAQ.map((item) => `<details>
      <summary>${esc(item.q)}</summary>
      <p>${esc(item.a)}</p>
    </details>`).join('\n    ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(TITLE)}</title>
<meta name="description" content="${esc(DESCRIPTION)}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${CANONICAL}">
<meta property="og:title" content="${esc(TITLE)}">
<meta property="og:description" content="${esc(DESCRIPTION)}">
<meta property="og:url" content="${CANONICAL}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="CallBots">
<meta property="og:locale" content="en_US">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(TITLE)}">
<meta name="twitter:description" content="${esc(DESCRIPTION)}">
<meta name="theme-color" content="#12382f">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="16x16">
<style>
  :root { color-scheme: light; --ink: #172420; --muted: #3c5149; --paper: #f6f3ec; --pine: #12382f; --pine-2: #1c4d40; --line: #d7d0c3; --brass: #8a5a2a; }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body { margin: 0; background: var(--paper); color: var(--ink); font-family: Georgia, "Iowan Old Style", Palatino, serif; font-size: 1.05rem; line-height: 1.55; }
  a { color: #0c4f42; }
  a:focus-visible, summary:focus-visible { outline: 3px solid #0c4f42; outline-offset: 3px; }
  .skip { position: absolute; left: 0.75rem; top: -3rem; background: #fff; padding: 0.5rem 0.75rem; z-index: 2; }
  .skip:focus { top: 0.75rem; }
  .wrap { width: min(72rem, calc(100% - 2rem)); margin: 0 auto; }
  header.site { background: var(--pine); color: #f4f1ea; }
  header.site a { color: #f4f1ea; }
  .bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.9rem 0; }
  .brand { display: flex; align-items: center; gap: 0.7rem; text-decoration: none; font-family: ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.04em; }
  .brand img { width: 36px; height: 36px; }
  nav ul { display: flex; flex-wrap: wrap; gap: 0.75rem 1rem; list-style: none; margin: 0; padding: 0; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.92rem; }
  .hero { padding: 3.2rem 0 3.6rem; }
  .eyebrow { font-family: ui-sans-serif, system-ui, sans-serif; text-transform: uppercase; letter-spacing: 0.14em; font-size: 0.75rem; color: #d5ebe3; margin: 0 0 0.8rem; }
  h1 { font-size: clamp(2.1rem, 4.6vw, 3.5rem); line-height: 1.08; font-weight: 500; margin: 0 0 1rem; max-width: 18ch; }
  .lede { max-width: 40rem; font-size: 1.15rem; margin: 0 0 1.4rem; color: #e7f3ee; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.7rem; }
  .cta { display: inline-flex; align-items: center; min-height: 44px; padding: 0.65rem 1rem; text-decoration: none; font-family: ui-sans-serif, system-ui, sans-serif; }
  .cta.primary { background: #f4f1ea; color: var(--pine); }
  .cta.secondary { border: 1px solid #d5ebe3; color: #f4f1ea; }
  main section { padding: 3rem 0; border-top: 1px solid var(--line); }
  h2 { font-size: clamp(1.6rem, 3vw, 2.2rem); font-weight: 500; line-height: 1.15; margin: 0 0 0.8rem; }
  h3 { font-size: 1.2rem; font-weight: 500; margin: 0 0 0.35rem; }
  .intro { max-width: 42rem; color: var(--muted); }
  ol.steps, .grid { margin: 1.4rem 0 0; padding: 0; }
  ol.steps { list-style: none; display: grid; gap: 1rem; }
  ol.steps li, .card { background: #fffdf8; border: 1px solid var(--line); padding: 1rem 1.1rem; }
  ol.steps span { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--brass); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: 0.9rem; }
  .card p, .industry p { margin: 0; color: var(--muted); }
  .industry { display: grid; gap: 1rem; }
  .table-wrap { overflow-x: auto; margin-top: 1rem; }
  table { width: 100%; min-width: 36rem; border-collapse: collapse; background: #fffdf8; }
  caption { text-align: left; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.9rem; color: var(--muted); margin-bottom: 0.5rem; }
  th, td { border: 1px solid var(--line); padding: 0.7rem 0.75rem; vertical-align: top; text-align: left; }
  th { background: #efeae0; font-family: ui-sans-serif, system-ui, sans-serif; font-weight: 600; }
  .price { background: var(--pine); color: #f4f1ea; }
  .price p { color: #e7f3ee; max-width: 40rem; }
  .price a { color: #f4f1ea; }
  details { border-top: 1px solid var(--line); padding: 0.75rem 0; }
  summary { cursor: pointer; font-size: 1.08rem; min-height: 44px; display: flex; align-items: center; }
  details p { margin: 0.2rem 0 0.6rem; color: var(--muted); }
  footer { background: #10241f; color: #e7f3ee; padding: 2rem 0 2.4rem; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.95rem; }
  footer a { color: #f4f1ea; }
  address { font-style: normal; }
  @media (max-width: 640px) {
    .bar { flex-direction: column; align-items: flex-start; }
    .hero { padding-top: 2.2rem; }
  }
  @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
</style>
<script type="application/ld+json">${jsonLdScript(structuredData())}</script>
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="site">
  <div class="wrap bar">
    <a class="brand" href="${CANONICAL}">
      <img src="/favicon.svg" width="36" height="36" alt="CallBots logo for the AI call bot">
      <span>CallBots</span>
    </a>
    <nav aria-label="On this page">
      <ul>
        <li><a href="#how">How it works</a></li>
        <li><a href="#features">Features</a></li>
        <li><a href="#industries">Use cases</a></li>
        <li><a href="#compare">Compare</a></li>
        <li><a href="#pricing">Pricing</a></li>
        <li><a href="#faq">FAQ</a></li>
      </ul>
    </nav>
  </div>
  <div class="wrap hero">
    <p class="eyebrow">AI call bot for small business</p>
    <h1>An AI phone agent that answers, then texts the link to buy</h1>
    <p class="lede">CallBots is an AI receptionist from Quanta X Technology LLC. It answers every call in a natural conversational voice, uses your knowledge base and website, looks up Shopify products, and texts a purchase link. It never takes a payment.</p>
    <div class="actions">
      <a class="cta primary" href="${MAIL}?subject=CallBots%20early%20access">Get early access</a>
      <a class="cta secondary" href="${MAIL}?subject=Book%20a%20CallBots%20demo">Book a demo</a>
    </div>
  </div>
</header>
<main id="content">
  <section id="how" aria-labelledby="how-title">
    <div class="wrap">
      <h2 id="how-title">How this AI answering service works</h2>
      <p class="intro">Callers speak normally. The voice AI agent answers from sources you control, then does one of three things: text a link, transfer to your team, or take a message.</p>
      <ol class="steps">
        <li><span>Step 1</span><h3>Your number rings</h3><p>The call reaches the AI customer service phone you connected. There is no "press 1" tree.</p></li>
        <li><span>Step 2</span><h3>Grok Voice holds the conversation</h3><p>A natural language voice agent greets the caller, says it is an assistant, and listens to the question.</p></li>
        <li><span>Step 3</span><h3>It uses your material only</h3><p>Answers come from that business's knowledge base, website, and Shopify catalog. If those sources do not have it, the agent says so.</p></li>
        <li><span>Step 4</span><h3>A link, a person, or a message</h3><p>A shopper gets one text with the purchase link. During your hours the call can transfer to a human. After hours the agent takes a message.</p></li>
      </ol>
    </div>
  </section>
  <section id="features" aria-labelledby="features-title">
    <div class="wrap">
      <h2 id="features-title">What the virtual receptionist will and will not do</h2>
      <div class="grid">
        <article class="card"><h3>Natural conversational voice</h3><p>Grok Voice speaks in full sentences. Callers are not walked through a keypad menu.</p></article>
        <article class="card"><h3>Your knowledge base</h3><p>Policies, hours, and product facts are read from the pages and notes you provide for that business.</p></article>
        <article class="card"><h3>Shopify AI phone support</h3><p>The agent can search the live catalog and name the product, the price, and whether it is available.</p></article>
        <article class="card"><h3>Purchase links by text</h3><p>The sale stays on your website. The text contains the product link, not a request for a card.</p></article>
        <article class="card"><h3>It never takes a payment</h3><p>Card numbers and payment wording are refused on the call and in the text. Checkout stays on your store.</p></article>
        <article class="card"><h3>Transfer or a message</h3><p>Inside your hours, the caller can reach a person. Outside those hours, the AI call bot takes a message instead of transferring.</p></article>
        <article class="card"><h3>One agent per business</h3><p>A second company does not share the first company's catalog, links, or knowledge base.</p></article>
        <article class="card"><h3>For agencies</h3><p>Run a separate agent for each client. Callers hear that client. CallBots stays in the background.</p></article>
      </div>
    </div>
  </section>
  <section id="industries" aria-labelledby="industries-title">
    <div class="wrap">
      <h2 id="industries-title">A small business answering service, by industry</h2>
      <div class="industry grid">
        <article class="card"><h3>Shopify brands</h3><p>Product questions get a catalog answer and a texted purchase link. The agent does not charge the card.</p></article>
        <article class="card"><h3>Local services</h3><p>After-hours callers still reach an AI receptionist. Your team gets the message, or the live transfer during the day.</p></article>
        <article class="card"><h3>Offices and studios</h3><p>Hours, location, and intake questions come from the knowledge base. Anything else becomes a message.</p></article>
        <article class="card"><h3>Hospitality</h3><p>Callers can ask what you publish on your site, then receive an allowlisted link for a reservation or an order page.</p></article>
        <article class="card"><h3>Agencies</h3><p>Stand up an AI phone agent per client without mixing their websites, shops, or phone numbers.</p></article>
      </div>
    </div>
  </section>
  <section id="compare" aria-labelledby="compare-title">
    <div class="wrap">
      <h2 id="compare-title">CallBots and a traditional answering service</h2>
      <p class="intro">Teams also look at Allo, Smith.ai, Ruby, Goodcall, Synthflow, Bland, and Air.ai. Those products differ from each other. This table is only the contrast with a staffed answering service, which is the comparison most owners start with.</p>
      <div class="table-wrap">
        <table>
          <caption>How a traditional answering service compares with the CallBots AI call bot</caption>
          <thead>
            <tr><th scope="col">Question</th><th scope="col">Traditional answering service</th><th scope="col">CallBots</th></tr>
          </thead>
          <tbody>
            <tr><th scope="row">Who answers</th><td>A person, on the shift you cover</td><td>An AI receptionist using a natural language voice agent</td></tr>
            <tr><th scope="row">When</th><td>The hours in the plan</td><td>24/7</td></tr>
            <tr><th scope="row">What it knows</th><td>The script or notes you send the center</td><td>That business's knowledge base, website, and Shopify catalog</td></tr>
            <tr><th scope="row">A caller who wants to buy</th><td>Usually a message for later</td><td>A text with the purchase link. The call never takes a payment</td></tr>
            <tr><th scope="row">Reaching your team</th><td>The receptionist is the person</td><td>Transfer during your hours, a message after hours</td></tr>
            <tr><th scope="row">More than one brand</th><td>Often another contract</td><td>A separate agent per business, including agency clients</td></tr>
            <tr><th scope="row">How you pay</th><td>Commonly a monthly plan, a block of minutes, or seats</td><td>Usage-based. No seats. Ask us for the quote</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
  <section id="pricing" class="price" aria-labelledby="pricing-title">
    <div class="wrap">
      <h2 id="pricing-title">Simple usage-based pricing</h2>
      <p>CallBots is priced by use, not by seat. We do not publish a rate on this page, and we will not invent one. Email <a href="${MAIL}?subject=CallBots%20pricing">support@quantaxtechnology.com</a> and we will send the number before you go live.</p>
      <div class="actions">
        <a class="cta primary" href="${MAIL}?subject=CallBots%20early%20access">Get early access</a>
        <a class="cta secondary" href="${MAIL}?subject=Book%20a%20CallBots%20demo">Book a demo</a>
      </div>
    </div>
  </section>
  <section id="faq" aria-labelledby="faq-title">
    <div class="wrap">
      <h2 id="faq-title">Questions about the AI call bot</h2>
      ${faqHtml}
    </div>
  </section>
</main>
<footer>
  <div class="wrap">
    <p>CallBots is a product of Quanta X Technology LLC.</p>
    <address>
      Quanta X Technology LLC<br>
      Seminole, FL<br>
      <a href="${MAIL}">support@quantaxtechnology.com</a>
    </address>
  </div>
</footer>
</body>
</html>`;
}

module.exports = { renderLanding, TITLE, DESCRIPTION, FAQ, ROBOTS, SITEMAP, CANONICAL };
