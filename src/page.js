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
  <url>
    <loc>https://callbots.org/privacy</loc>
    <lastmod>2026-10-30</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>https://callbots.org/terms</loc>
    <lastmod>2026-10-30</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
</urlset>
`;

const CSS = `  :root {
    color-scheme: light;
    --bg: #f4f1ea;
    --bg-2: #fffcf7;
    --ink: #14211c;
    --muted: #3c4e47;
    --line: #e3dcd0;
    --accent: #0d5c4d;
    --accent-ink: #f5fffb;
    --tint: #e7f3ee;
    --hero: #10241e;
    --hero-ink: #f6f3ec;
    --hero-muted: #d5e6df;
    --signal: #f0c36a;
    --mint: #9ee7d4;
    --shadow: 0 24px 60px rgba(16, 36, 30, 0.14);
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --bg: #0c100e;
      --bg-2: #151c19;
      --ink: #f3f6f4;
      --muted: #c5d1cb;
      --line: #2c3b35;
      --accent: #8ee0cb;
      --accent-ink: #06241c;
      --tint: #1a2b26;
      --hero: #101916;
      --hero-ink: #f6f3ec;
      --hero-muted: #d5e6df;
      --shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
    }
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); font-size: 1.0625rem; line-height: 1.55; }
  img, svg { max-width: 100%; }
  a { color: var(--accent); }
  a:focus-visible, summary:focus-visible, .cta:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
  .skip { position: absolute; left: 1rem; top: -3.2rem; background: var(--bg-2); color: var(--ink); padding: 0.55rem 0.8rem; z-index: 40; border-radius: 8px; }
  .skip:focus { top: 0.75rem; }
  .wrap { width: min(70rem, calc(100% - 2rem)); margin: 0 auto; }
  .site-header { position: sticky; top: 0; z-index: 30; background: var(--bg); background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(16px); border-bottom: 1px solid var(--line); }
  .bar { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; min-height: 4.25rem; }
  .brand { display: inline-flex; align-items: center; gap: 0.65rem; color: var(--ink); text-decoration: none; font-weight: 650; letter-spacing: -0.02em; }
  .brand svg { width: 2rem; height: 2rem; flex: none; }
  .nav-end { display: flex; align-items: center; gap: 0.5rem; }
  .nav-pop { position: relative; }
  .nav-pop > summary { list-style: none; cursor: pointer; min-height: 44px; padding: 0 0.9rem; display: inline-flex; align-items: center; gap: 0.45rem; border: 1px solid var(--line); border-radius: 999px; background: var(--bg-2); color: var(--ink); font: inherit; }
  .nav-pop > summary::-webkit-details-marker { display: none; }
  .nav-panel { display: flex; }
  .nav-links { display: flex; gap: 0.15rem; list-style: none; margin: 0; padding: 0; }
  .nav-links a { color: var(--ink); text-decoration: none; min-height: 44px; display: inline-flex; align-items: center; padding: 0 0.7rem; border-radius: 999px; }
  .nav-links a:hover { background: var(--tint); }
  .cta { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0.65rem 1.05rem; border-radius: 999px; text-decoration: none; font-weight: 650; letter-spacing: -0.01em; }
  .cta.solid { background: var(--accent); color: var(--accent-ink); }
  .cta.solid:hover { filter: brightness(1.08); }
  .cta.ghost { color: var(--hero-ink); border: 1px solid color-mix(in srgb, var(--hero-ink) 45%, transparent); }
  .cta.nav-cta { padding-inline: 0.9rem; }
  .narrow { display: none; }
  .hero { padding: 1.25rem 0 3.5rem; }
  .hero-panel { display: grid; gap: 2rem; background: radial-gradient(120% 90% at 100% 0%, #1d4a3d 0%, var(--hero) 52%); color: var(--hero-ink); border-radius: 28px; padding: clamp(1.4rem, 4vw, 3.25rem); box-shadow: var(--shadow); overflow: hidden; }
  .eyebrow { margin: 0 0 0.85rem; color: var(--signal); font-size: 0.78rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
  h1 { margin: 0 0 0.9rem; font-size: clamp(2.15rem, 5vw, 3.75rem); line-height: 1.04; letter-spacing: -0.045em; font-weight: 620; max-width: 16ch; }
  .lede { margin: 0 0 1.4rem; max-width: 38rem; color: var(--hero-muted); font-size: 1.12rem; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.7rem; }
  .hero-art { margin: 0; }
  .hero-art svg { width: 100%; height: auto; display: block; }
  .sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  main section { padding: 4.5rem 0; }
  h2 { margin: 0 0 0.7rem; font-size: clamp(1.8rem, 3vw, 2.6rem); letter-spacing: -0.04em; line-height: 1.08; font-weight: 620; }
  h3 { margin: 0 0 0.35rem; font-size: 1.12rem; letter-spacing: -0.02em; }
  .intro { margin: 0; max-width: 40rem; color: var(--muted); }
  .steps { list-style: none; margin: 2rem 0 0; padding: 0; display: grid; gap: 0.9rem; }
  .steps li { background: var(--bg-2); border: 1px solid var(--line); border-radius: 20px; padding: 1.15rem 1.15rem 1.2rem; }
  .step-no { width: 2rem; height: 2rem; display: grid; place-items: center; border-radius: 999px; background: var(--ink); color: var(--bg); font-size: 0.85rem; font-weight: 700; margin-bottom: 0.8rem; }
  .steps p, .card p { margin: 0; color: var(--muted); }
  .grid { margin-top: 1.6rem; display: grid; gap: 0.9rem; grid-template-columns: 1fr; }
  .card { background: var(--bg-2); border: 1px solid var(--line); border-radius: 20px; padding: 1.15rem; }
  .ico-wrap { width: 2.5rem; height: 2.5rem; display: grid; place-items: center; border-radius: 12px; background: var(--tint); color: var(--accent); margin-bottom: 0.8rem; }
  .ico { width: 1.35rem; height: 1.35rem; }
  .table-wrap { margin-top: 1.4rem; }
  table { width: 100%; border-collapse: collapse; background: var(--bg-2); }
  caption { text-align: left; color: var(--muted); margin-bottom: 0.7rem; }
  th, td { border: 1px solid var(--line); padding: 0.8rem 0.85rem; vertical-align: top; text-align: left; }
  th { background: var(--tint); }
  .price { padding-top: 0; }
  .price-panel { background: var(--hero); color: var(--hero-ink); border-radius: 28px; padding: clamp(1.4rem, 4vw, 2.6rem); }
  .price-panel p { color: var(--hero-muted); max-width: 40rem; }
  .price-panel a:not(.cta) { color: var(--signal); }
  .faq-item { border-top: 1px solid var(--line); }
  .faq-item:last-child { border-bottom: 1px solid var(--line); }
  .faq-item summary { cursor: pointer; min-height: 52px; display: flex; align-items: center; justify-content: space-between; gap: 1rem; font-weight: 650; letter-spacing: -0.02em; list-style: none; }
  .faq-item summary::-webkit-details-marker { display: none; }
  .faq-item summary::after { content: "+"; font-weight: 500; font-size: 1.3rem; color: var(--accent); }
  .faq-item[open] summary::after { content: "–"; }
  .faq-item p { margin: 0 0 1rem; color: var(--muted); max-width: 46rem; }
  footer { border-top: 1px solid var(--line); padding: 2.2rem 0 2.8rem; color: var(--muted); }
  footer strong { color: var(--ink); }
  address { font-style: normal; margin-top: 0.4rem; }
  .wave rect { transform-box: fill-box; transform-origin: center bottom; animation: eq 1.5s ease-in-out infinite; }
  .wave rect:nth-child(2) { animation-delay: 0.12s; }
  .wave rect:nth-child(3) { animation-delay: 0.28s; }
  .wave rect:nth-child(4) { animation-delay: 0.08s; }
  .flow-dash { stroke-dasharray: 8 10; animation: march 1.4s linear infinite; }
  @keyframes eq { 0%, 100% { transform: scaleY(0.45); } 50% { transform: scaleY(1); } }
  @keyframes march { to { stroke-dashoffset: -36; } }
  @media (min-width: 700px) {
    .grid.features { grid-template-columns: 1fr 1fr; }
    .grid.uses { grid-template-columns: 1fr 1fr; }
  }
  @media (min-width: 768px) {
    .steps { grid-template-columns: repeat(3, 1fr); gap: 1rem; }
    .hero { padding-top: 1.75rem; }
  }
  @media (max-width: 420px) {
    .wide { display: none; }
    .narrow { display: inline; }
  }
  @media (min-width: 900px) {
    .nav-pop > summary { display: none; }
    details.nav-pop > .nav-panel { display: flex !important; align-items: center; gap: 0.35rem; position: static; width: auto; padding: 0; border: 0; background: transparent; box-shadow: none; }
  }
  @media (max-width: 899px) {
    .nav-panel { position: absolute; right: 0; top: calc(100% + 0.45rem); width: min(18.5rem, calc(100vw - 2rem)); flex-direction: column; align-items: stretch; gap: 0.15rem; padding: 0.55rem; background: var(--bg-2); border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow); }
    .nav-links { flex-direction: column; }
    .nav-links a { width: 100%; }
  }
  @media (min-width: 1024px) {
    .hero-panel { grid-template-columns: 1.05fr 0.95fr; align-items: center; gap: 2.5rem; }
    .grid.features { grid-template-columns: repeat(4, 1fr); }
    .grid.uses { grid-template-columns: repeat(3, 1fr); }
    main section { padding: 5.5rem 0; }
  }
  @media (max-width: 740px) {
    table, thead, tbody, tr, th, td { display: block; width: auto; }
    thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }
    tbody tr { margin: 0 0 0.85rem; border: 1px solid var(--line); border-radius: 16px; overflow: hidden; background: var(--bg-2); }
    tbody th, tbody td { border: 0; border-top: 1px solid var(--line); }
    tbody th { border-top: 0; background: var(--tint); }
    td::before { content: attr(data-label); display: block; margin-bottom: 0.25rem; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
    .actions .cta { flex: 1 1 12rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    .wave rect, .flow-dash { animation: none; }
  }
  .legal { max-width: 760px; padding: 2.4rem 0 3rem; }
  .legal h1 { margin-bottom: .4rem; }
  .legal h2 { margin-top: 2rem; font-size: 1.25rem; }
  .legal .eff { color: var(--muted); }
  .legal ul { padding-left: 1.2rem; }
  .foot-links { display: flex; gap: 1.2rem; flex-wrap: wrap; margin: .8rem 0 0; padding: 0; list-style: none; }
`;

const BRAND = `    <a class="brand" href="${CANONICAL}">
      <svg viewBox="0 0 32 32" role="img" aria-label="CallBots logo for the AI call bot">
        <rect width="32" height="32" rx="8" fill="#10241e"/>
        <rect x="6" y="14" width="3" height="8" rx="1.5" fill="#f0c36a"/>
        <rect x="11.5" y="8" width="3" height="16" rx="1.5" fill="#9ee7d4"/>
        <rect x="17" y="11" width="3" height="13" rx="1.5" fill="#f6f3ec"/>
        <rect x="22.5" y="15" width="3" height="7" rx="1.5" fill="#f0c36a"/>
      </svg>
      <span>CallBots</span>
    </a>`;

const OPERATOR = { name: 'Quanta X Technology LLC', state: 'Florida', street: '8134 122nd St N', city: 'Seminole, FL 33772', email: 'support@quantaxtechnology.com' };

function siteFooter() {
  return `<footer>
  <div class="wrap">
    <p><strong>CallBots</strong> is a product of Quanta X Technology LLC.</p>
    <address>
      Quanta X Technology LLC<br>
      ${OPERATOR.street}, ${OPERATOR.city}<br>
      <a href="${MAIL}">${OPERATOR.email}</a>
    </address>
    <ul class="foot-links">
      <li><a href="/privacy">Privacy Policy</a></li>
      <li><a href="/terms">Terms of Service</a></li>
    </ul>
  </div>
</footer>`;
}

function icon(body) {
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

function renderLanding() {
  const faqHtml = FAQ.map((item) => `<details class="faq-item">
        <summary>${esc(item.q)}</summary>
        <p>${esc(item.a)}</p>
      </details>`).join('\n      ');
  const early = MAIL + '?subject=CallBots%20early%20access';
  const demo = MAIL + '?subject=Book%20a%20CallBots%20demo';
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
<meta name="theme-color" content="#10241e" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f4f1ea" media="(prefers-color-scheme: light)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="16x16">
<style>
${CSS}
</style>
<script type="application/ld+json">${jsonLdScript(structuredData())}</script>
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="site-header">
  <div class="wrap bar">
${BRAND}
    <div class="nav-end">
      <a class="cta solid nav-cta" href="${early}"><span class="wide">Get early access</span><span class="narrow">Access</span></a>
      <details class="nav-pop">
        <summary>Menu</summary>
        <div class="nav-panel">
          <nav aria-label="On this page">
            <ul class="nav-links">
              <li><a href="#how">How it works</a></li>
              <li><a href="#features">Features</a></li>
              <li><a href="#industries">Use cases</a></li>
              <li><a href="#compare">Compare</a></li>
              <li><a href="#pricing">Pricing</a></li>
              <li><a href="#faq">FAQ</a></li>
            </ul>
          </nav>
        </div>
      </details>
    </div>
  </div>
</header>
<main id="content">
  <div class="wrap hero">
    <section class="hero-panel" aria-labelledby="hero-title">
      <div>
        <p class="eyebrow">AI call bot for small business</p>
        <h1 id="hero-title">An AI phone agent that answers, then texts the link to buy</h1>
        <p class="lede">CallBots is an AI receptionist from Quanta X Technology LLC. It answers every call in a natural conversational voice, uses your knowledge base and website, looks up Shopify products, and texts a purchase link. It never takes a payment.</p>
        <div class="actions">
          <a class="cta solid" href="${early}">Get early access</a>
          <a class="cta ghost" href="${demo}">Book a demo</a>
        </div>
      </div>
      <figure class="hero-art">
        <svg viewBox="0 0 560 420" role="img" aria-labelledby="flowTitle flowDesc">
          <title id="flowTitle">From a phone call to a texted purchase link</title>
          <desc id="flowDesc">Illustration of a voice waveform on a call, then a text message that carries a product link. Not a customer photo.</desc>
          <rect x="1" y="1" width="558" height="418" rx="28" fill="#0c1c18" stroke="#2c4a41"/>
          <rect x="28" y="36" width="210" height="348" rx="28" fill="#163028"/>
          <rect x="86" y="58" width="94" height="18" rx="9" fill="#21483c"/>
          <text x="133" y="150" text-anchor="middle" fill="#d5e6df" font-family="ui-sans-serif, system-ui, sans-serif" font-size="15">Incoming call</text>
          <g class="wave" fill="#9ee7d4">
            <rect x="78" y="188" width="14" height="70" rx="7"/>
            <rect x="102" y="168" width="14" height="110" rx="7" fill="#f0c36a"/>
            <rect x="126" y="178" width="14" height="90" rx="7"/>
            <rect x="150" y="190" width="14" height="66" rx="7" fill="#f6f3ec"/>
          </g>
          <text x="133" y="320" text-anchor="middle" fill="#f6f3ec" font-family="ui-sans-serif, system-ui, sans-serif" font-size="18" font-weight="650">Grok Voice</text>
          <text x="133" y="344" text-anchor="middle" fill="#d5e6df" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13">Natural language</text>
          <path class="flow-dash" d="M248 210 H300" stroke="#f0c36a" stroke-width="3" fill="none" stroke-linecap="round"/>
          <path d="M292 202 l12 8 -12 8" fill="none" stroke="#f0c36a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
          <rect x="312" y="78" width="220" height="250" rx="22" fill="#f6f3ec"/>
          <circle cx="344" cy="118" r="16" fill="#10241e"/>
          <text x="372" y="114" fill="#14211c" font-family="ui-sans-serif, system-ui, sans-serif" font-size="14" font-weight="700">Text message</text>
          <text x="372" y="134" fill="#3c4e47" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12">Just now</text>
          <text x="336" y="180" fill="#14211c" font-family="ui-sans-serif, system-ui, sans-serif" font-size="15">Oak table is in stock.</text>
          <text x="336" y="204" fill="#14211c" font-family="ui-sans-serif, system-ui, sans-serif" font-size="15">Order on your site:</text>
          <rect x="336" y="224" width="172" height="42" rx="12" fill="#0d5c4d"/>
          <text x="422" y="250" text-anchor="middle" fill="#f5fffb" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12">yourstore.com/oak-table</text>
          <text x="422" y="360" text-anchor="middle" fill="#d5e6df" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13">Illustrative. No payment on the call.</text>
        </svg>
      </figure>
    </section>
  </div>
  <section id="how" aria-labelledby="how-title">
    <div class="wrap">
      <h2 id="how-title">How this AI answering service works</h2>
      <p class="intro">Three moves. Callers speak normally. The voice AI agent answers from sources you control, then texts a link, transfers, or takes a message.</p>
      <ol class="steps">
        <li><div class="step-no">1</div><h3>Connect</h3><p>Add the number, the Shopify shop, the website, and the knowledge base. Each business stays separate.</p></li>
        <li><div class="step-no">2</div><h3>Answer</h3><p>Grok Voice, a natural language voice agent, picks up 24/7. There is no phone tree.</p></li>
        <li><div class="step-no">3</div><h3>Send the link</h3><p>A shopper gets one text with the purchase link. During your hours the call can reach a person. After hours it becomes a message.</p></li>
      </ol>
    </div>
  </section>
  <section id="features" aria-labelledby="features-title">
    <div class="wrap">
      <h2 id="features-title">What the virtual receptionist will and will not do</h2>
      <div class="grid features">
        <article class="card"><div class="ico-wrap">${icon('<path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/>')}</div><h3>Natural conversational voice</h3><p>Grok Voice speaks in full sentences. Callers are not walked through a keypad menu.</p></article>
        <article class="card"><div class="ico-wrap">${icon('<path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H20v16H7.5A2.5 2.5 0 0 0 5 21.5z"/><path d="M5 5.5A2.5 2.5 0 0 1 7.5 8H20"/>')}</div><h3>Your knowledge base</h3><p>Policies, hours, and product facts are read from the pages and notes you provide for that business.</p></article>
        <article class="card"><div class="ico-wrap">${icon('<path d="M6 8h12l-1 12H7L6 8z"/><path d="M9 8V7a3 3 0 0 1 6 0v1"/>')}</div><h3>Shopify AI phone support</h3><p>The agent can search the live catalog and name the product, the price, and whether it is available.</p></article>
        <article class="card"><div class="ico-wrap">${icon('<path d="M5 6h14v10H8l-3 3V6z"/><path d="M8 10h8M8 13h5"/>')}</div><h3>Purchase links by text</h3><p>The sale stays on your website. The text contains the product link, not a request for a card.</p></article>
        <article class="card"><div class="ico-wrap">${icon('<path d="M12 3l7 3v6c0 4.5-3 7-7 9-4-2-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/>')}</div><h3>It never takes a payment</h3><p>Card numbers and payment wording are refused on the call and in the text. Checkout stays on your store.</p></article>
        <article class="card"><div class="ico-wrap">${icon('<path d="M8 5h5l5 5v9a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/><path d="M13 5v5h5"/>')}</div><h3>Transfer or a message</h3><p>Inside your hours, the caller can reach a person. Outside those hours, the AI call bot takes a message instead of transferring.</p></article>
        <article class="card"><div class="ico-wrap">${icon('<path d="M4 20V9l6-3v14"/><path d="M10 20V6l8 3v11"/><path d="M3 20h18"/>')}</div><h3>One agent per business</h3><p>A second company does not share the first company's catalog, links, or knowledge base.</p></article>
        <article class="card"><div class="ico-wrap">${icon('<path d="M8 12a3 3 0 1 0-3-3 3 3 0 0 0 3 3z"/><path d="M16 13a2.5 2.5 0 1 0-2.5-2.5A2.5 2.5 0 0 0 16 13z"/><path d="M2.5 19a5.5 5.5 0 0 1 11 0"/><path d="M13.5 19a4.8 4.8 0 0 1 7-4"/>')}</div><h3>For agencies</h3><p>Run a separate agent for each client. Callers hear that client. CallBots stays in the background.</p></article>
      </div>
    </div>
  </section>
  <section id="industries" aria-labelledby="industries-title">
    <div class="wrap">
      <h2 id="industries-title">A small business answering service, by industry</h2>
      <div class="grid uses">
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
            <tr><th scope="row">Who answers</th><td data-label="Traditional answering service">A person, on the shift you cover</td><td data-label="CallBots">An AI receptionist using a natural language voice agent</td></tr>
            <tr><th scope="row">When</th><td data-label="Traditional answering service">The hours in the plan</td><td data-label="CallBots">24/7</td></tr>
            <tr><th scope="row">What it knows</th><td data-label="Traditional answering service">The script or notes you send the center</td><td data-label="CallBots">That business's knowledge base, website, and Shopify catalog</td></tr>
            <tr><th scope="row">A caller who wants to buy</th><td data-label="Traditional answering service">Usually a message for later</td><td data-label="CallBots">A text with the purchase link. The call never takes a payment</td></tr>
            <tr><th scope="row">Reaching your team</th><td data-label="Traditional answering service">The receptionist is the person</td><td data-label="CallBots">Transfer during your hours, a message after hours</td></tr>
            <tr><th scope="row">More than one brand</th><td data-label="Traditional answering service">Often another contract</td><td data-label="CallBots">A separate agent per business, including agency clients</td></tr>
            <tr><th scope="row">How you pay</th><td data-label="Traditional answering service">Commonly a monthly plan, a block of minutes, or seats</td><td data-label="CallBots">Usage-based. No seats. Ask us for the quote</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
  <section id="pricing" class="price" aria-labelledby="pricing-title">
    <div class="wrap">
      <div class="price-panel">
        <h2 id="pricing-title">Simple usage-based pricing</h2>
        <p>CallBots is priced by use, not by seat. We do not publish a rate on this page, and we will not invent one. Email <a href="${MAIL}?subject=CallBots%20pricing">support@quantaxtechnology.com</a> and we will send the number before you go live.</p>
        <div class="actions">
          <a class="cta solid" href="${early}">Get early access</a>
          <a class="cta ghost" href="${demo}">Book a demo</a>
        </div>
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
${siteFooter()}
</body>
</html>`;
}

module.exports = { CSS, BRAND, OPERATOR, siteFooter, esc, renderLanding, TITLE, DESCRIPTION, FAQ, ROBOTS, SITEMAP, CANONICAL };

