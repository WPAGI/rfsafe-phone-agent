'use strict';
// Public knowledge base (rfsafe.app/kb): HTML pages and the AI formats (llms.txt, all.md, JSON). Everything shown
// here comes from data.js snapshots, which already hold only enabled, public entries with whitelisted fields.
const crypto = require('crypto');
const D = require('./data');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsonLd = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
const fmtDate = (iso) => { const d = new Date(iso || ''); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }); };
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
function excerpt(s, n = 200) { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '').replace(/[,;:.]$/, '') + '…'; }
function firstPara(s) { return String(s || '').split(/\n\s*\n/)[0].trim(); }

// Inline text: escape, then turn https links into anchors (only https; trailing punctuation stays outside).
function inline(s) {
  return esc(s).replace(/https:\/\/[^\s<>"'()]+[^\s<>"'().,;:!?]/g, (u) => {
    const raw = u.replace(/&amp;/g, '&'); const internal = /^https:\/\/rfsafe\.app(\/|$)/.test(raw);
    const label = raw.replace(/^https:\/\/(www\.)?/, '').replace(/\/$/, '');
    return '<a href="' + esc(raw) + '"' + (internal ? '' : ' rel="noopener"') + '>' + esc(label.length > 70 ? label.slice(0, 67) + '…' : label) + '</a>';
  });
}
// Entry text: blank lines split paragraphs; "- " / "• " lines become a list, "1. " lines a numbered list.
function renderText(text) {
  const out = [];
  for (const block of String(text || '').split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
    let para = []; let list = null;
    const flushP = () => { if (para.length) out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; };
    const flushL = () => { if (list) out.push('<' + list.tag + '>' + list.items.map((x) => '<li>' + inline(x) + '</li>').join('') + '</' + list.tag + '>'); list = null; };
    for (const l of lines) {
      const ul = l.match(/^\s*[-•*]\s+(.*)$/); const ol = l.match(/^\s*\d{1,2}[.)]\s+(.*)$/);
      const tag = ul ? 'ul' : ol ? 'ol' : null;
      if (tag) { flushP(); if (!list || list.tag !== tag) { flushL(); list = { tag, items: [] }; } list.items.push((ul || ol)[1]); }
      else { flushL(); para.push(l.trim()); }
    }
    flushP(); flushL();
  }
  return out.join('\n');
}

const THEME_JS = "try{document.documentElement.dataset.theme=localStorage.getItem('rfs-theme')||'dark'}catch(e){document.documentElement.dataset.theme='dark'}";
const THEME_HASH = "'sha256-" + crypto.createHash('sha256').update(THEME_JS).digest('base64') + "'";
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' " + THEME_HASH + "; connect-src 'self'; form-action 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'";

function searchBox(q = '', big = false) {
  return `<form class="kb-search${big ? ' kb-search-big' : ''}" role="search" action="/kb/search" method="get" data-kb-search-form>`
    + `<label class="kb-label" for="kb-q${big ? '-big' : ''}">Search the knowledge base</label>`
    + `<div class="kb-search-box"><svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m20 20-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`
    + `<input id="kb-q${big ? '-big' : ''}" name="q" type="search" value="${esc(q)}" autocomplete="off" spellcheck="false" placeholder="Search all answers" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="kb-results${big ? '-big' : ''}" data-kb-search>`
    + `<kbd aria-hidden="true" title="Press / to search">/</kbd><button type="submit">Search</button></div>`
    + `<ul class="kb-results" id="kb-results${big ? '-big' : ''}" role="listbox" aria-label="Search results" hidden></ul>`
    + `<p class="kb-sr" aria-live="polite" data-kb-status></p></form>`;
}

const NAV = [['/kb', 'Start here'], ['/kb/topics', 'Topics'], ['/kb/body-systems', 'Body systems'], ['/kb/safety-claims', 'Safety claims'], ['/kb/for-ai', 'For AI']];
function layout({ s, title, description, canonical, current = '', body, ld = [], q = '', noindex = false, assets, headerSearch = true }) {
  const nav = NAV.map(([h, l]) => `<a href="${h}"${current === h ? ' aria-current="page"' : ''}>${l}</a>`).join('');
  const themeBtns = `<div class="kb-theme" role="group" aria-label="Color theme"><button type="button" data-theme-choice="light" aria-pressed="false">Light</button><button type="button" data-theme-choice="dark" aria-pressed="false">Dark</button><button type="button" data-theme-choice="system" aria-pressed="false">Auto</button></div>`;
  const ldTags = ld.filter(Boolean).map((o) => `<script type="application/ld+json">${jsonLd(o)}</script>`).join('');
  const full = (p) => s.base + p;
  return `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><meta name="robots" content="${noindex ? 'noindex,follow' : 'index,follow,max-snippet:-1'}">`
    + `<link rel="canonical" href="${esc(full(canonical))}"><meta property="og:type" content="website"><meta property="og:site_name" content="RF Safe Knowledge Base"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(full(canonical))}"><meta property="og:image" content="${esc(full('/assets/img/og.png'))}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@rfsafe">`
    + `<link rel="icon" href="/favicon.ico" sizes="any"><link rel="alternate" type="text/plain" title="llms.txt" href="/kb/llms.txt"><link rel="alternate" type="text/markdown" title="All positions (Markdown)" href="/kb/all.md"><link rel="alternate" type="application/json" title="Knowledge base JSON" href="/kb/api/v1/kb.json">`
    + `<meta name="color-scheme" content="light dark"><script>${THEME_JS}</script><link rel="stylesheet" href="/kb/assets/kb.css?v=${assets.css}"><script src="/kb/assets/kb.js?v=${assets.js}" defer></script>${ldTags}</head>`
    + `<body><a class="kb-skip" href="#main">Skip to content</a>`
    + `<header class="kb-header"><div class="kb-wrap kb-header-row"><a class="kb-brand" href="/kb" aria-label="RF Safe Knowledge Base home"><span class="kb-mark" aria-hidden="true">RF</span><span>RF SAFE <b>KNOWLEDGE BASE</b></span></a>`
    + `<nav class="kb-nav" aria-label="Knowledge base">${nav}</nav><div class="kb-tools">${themeBtns}<a class="kb-site" href="/">rfsafe.app</a></div>`
    + `<details class="kb-menu"><summary><span class="kb-burger" aria-hidden="true"><i></i><i></i><i></i></span><span>Menu</span></summary><div class="kb-menu-panel"><nav aria-label="Menu">${nav}<a href="/research">Research</a><a href="/sar">SAR &amp; Phones</a><a href="/">rfsafe.app home</a></nav>${themeBtns}</div></details></div>`
    + (headerSearch ? `<div class="kb-wrap kb-searchbar">${searchBox(q)}</div>` : '') + `</header>`
    + `<main id="main" class="kb-wrap kb-main" tabindex="-1">${body}</main>`
    + `<footer class="kb-foot"><div class="kb-wrap"><p><b>${plural(s.entries.length, 'public answer')}</b> in ${plural(s.topics.length, 'topic')}${s.lastUpdated ? ' · last updated ' + esc(fmtDate(s.lastUpdated)) : ''}. This page updates by itself when RF Safe changes an answer.</p>`
    + `<p class="kb-note">General information from RF Safe, not medical advice. For a health concern, talk with your doctor.</p>`
    + `<ul aria-label="Machine-readable"><li><a href="/kb/llms.txt">llms.txt</a></li><li><a href="/kb/all.md">All positions (Markdown)</a></li><li><a href="/kb/api/v1/kb.json">JSON</a></li><li><a href="/kb/for-ai">How AI tools can use this</a></li></ul>`
    + `<ul aria-label="RF Safe"><li><a href="/">RF Safe home</a></li><li><a href="/research">Research</a></li><li><a href="/sar">SAR Compare</a></li><li><a href="/about">About</a></li><li><a href="/contact">Contact</a></li><li><a href="/privacy">Privacy</a></li><li><a href="/terms">Terms</a></li></ul>`
    + `<p class="kb-tm">RF SAFE® is a registered trademark of Quanta X Technology LLC (U.S. Reg. No. 6,592,188).</p></div></footer></body></html>`;
}

const crumbs = (items) => `<nav class="kb-crumbs" aria-label="Breadcrumb"><ol>${items.map(([h, l], i) => `<li>${i === items.length - 1 ? `<a href="${esc(h)}" aria-current="page">${esc(l)}</a>` : `<a href="${esc(h)}">${esc(l)}</a>`}</li>`).join('')}</ol></nav>`;
const crumbLd = (s, items) => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map(([h, l], i) => ({ '@type': 'ListItem', position: i + 1, name: l, item: s.base + h })) });
const faqLd = (s, list, { full = true } = {}) => list.length ? { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: list.map((e) => ({ '@type': 'Question', name: e.question, url: s.base + e.url, acceptedAnswer: { '@type': 'Answer', text: full ? e.text : excerpt(firstPara(e.text), 400), url: s.base + e.url } })) } : null;
const qCard = (e, { showTopic = false } = {}) => `<li class="kb-q"><a href="${esc(e.url)}"><span class="kb-q-title">${esc(e.question)}</span>${showTopic ? `<span class="kb-chip">${esc(e.topic)}</span>` : ''}<span class="kb-q-ex">${esc(excerpt(firstPara(e.text), 170))}</span></a></li>`;

function topicGrid(s) {
  return `<ul class="kb-topics">${s.topics.map((t) => { const list = t.slugs.slice(0, 3).map((x) => s.bySlug.get(x)); return `<li class="kb-topic"><a class="kb-topic-link" href="${esc(t.url)}"><span class="kb-topic-name">${esc(t.name)}</span><span class="kb-count">${plural(t.count, 'answer')}</span></a><ul>${list.map((e) => `<li><a href="${esc(e.url)}">${esc(e.question)}</a></li>`).join('')}</ul></li>`; }).join('')}</ul>`;
}
function bodyGrid(s, { compact = false } = {}) {
  return `<ul class="kb-systems${compact ? ' kb-systems-compact' : ''}">${s.bodySystems.map((b) => `<li class="kb-system" id="system-${esc(b.id)}"><h3>${esc(b.name)}</h3>${b.research_label ? `<p class="kb-sub">${esc(b.research_label)}</p>` : ''}`
    + (b.summary ? `<p class="kb-blurb">${esc(compact ? excerpt(b.summary, 180) : b.summary)}</p>` : `<p class="kb-blurb kb-pending">A plain-language summary for this body system is on its way. Until then, you can browse the studies.</p>`)
    + `<a class="kb-more" href="${esc(b.research_url)}">See ${esc(b.name.toLowerCase())} studies<span aria-hidden="true"> →</span></a></li>`).join('')}</ul>`;
}
function critiquesBlock(s, { full = false } = {}) {
  const c = s.critiques;
  if (c.status !== 'live') return `<div class="kb-soon"><span class="kb-badge">Coming soon</span><p>Research Bot is preparing plain-language critiques of common safety claims, such as "phones meet federal limits, so they are safe." Each one will say who made the claim, what the evidence shows and where to read more.</p></div>`;
  let html = '';
  const ov = (c.overview || []).map((x) => s.bySlug.get(x)).filter(Boolean); const st = (c.studies || []).map((x) => s.bySlug.get(x)).filter(Boolean);
  if (ov.length || st.length) {
    if (!full) html += `<p class="kb-sub">${plural(ov.length + st.length, 'answer')} on studies often cited as proof that phones are safe, and what is wrong with them.</p><ul class="kb-qs">${(ov.length ? ov : st).slice(0, 4).map((e) => qCard(e)).join('')}</ul><p><a class="kb-more" href="/kb/safety-claims">All safety-claim critiques<span aria-hidden="true"> →</span></a></p>`;
    else html += (ov.length ? `<section aria-labelledby="ov-h"><h2 id="ov-h">The big picture</h2><ol class="kb-qs">${ov.map((e) => qCard(e)).join('')}</ol></section>` : '')
      + (st.length ? `<section aria-labelledby="st-h"><h2 id="st-h">Study by study</h2><p class="kb-sub">${plural(st.length, 'study', 'studies')}.</p><ul class="kb-qs">${st.map((e) => qCard(e)).join('')}</ul></section>` : '');
  }
  if (c.items.length && (full || !html)) {
    const items = full ? c.items : c.items.slice(0, 4);
    html += `<ul class="kb-crit">${items.map((x) => `<li id="claim-${esc(x.id)}"><h3>Claim: ${esc(x.claim)}</h3>${x.claimed_by ? `<p class="kb-sub">Made by ${esc(x.claimed_by)}</p>` : ''}${full ? renderText(x.critique) : `<p>${esc(excerpt(x.critique, 260))}</p>`}`
      + (full && x.sources.length ? `<p class="kb-sub">Sources: ${x.sources.map((y) => `<a href="${esc(y.url)}" rel="noopener">${esc(y.title || y.url)}</a>`).join(' · ')}</p>` : '')
      + (full && x.kb_slugs.length ? `<p class="kb-sub">Related answers: ${x.kb_slugs.map((k) => s.bySlug.get(k)).filter(Boolean).map((e) => `<a href="${esc(e.url)}">${esc(e.question)}</a>`).join(' · ')}</p>` : '') + `</li>`).join('')}</ul>${!full ? '<p><a class="kb-more" href="/kb/safety-claims">All safety-claim critiques →</a></p>' : ''}`;
  }
  return html;
}
function startPage(s, assets) {
  const core = s.core;
  const coreHtml = core
    ? `<section class="kb-core" aria-labelledby="core-h"><p class="kb-kicker">Start here · RF Safe's core position</p><h2 id="core-h"><a href="${esc(core.url)}">${esc(core.question)}</a></h2><div class="kb-prose">${renderText(core.text.split(/\n\s*\n/).slice(0, 2).join('\n\n'))}</div><p><a class="kb-btn" href="${esc(core.url)}">Read the full position<span aria-hidden="true"> →</span></a></p></section>`
    : `<section class="kb-core"><p class="kb-kicker">Start here</p><p>RF Safe's core position will appear here.</p></section>`;
  const body = `<section class="kb-hero"><p class="kb-kicker">Knowledge base</p><h1>RF Safe's positions on wireless radiation, in plain words</h1>`
    + `<p class="kb-lead">Every answer RF Safe gives by phone, text and email, in one open place. Search it, browse it by topic, or point an AI tool here. It updates by itself when RF Safe changes an answer.</p>${searchBox('', true)}`
    + `<p class="kb-stats"><span><b>${s.entries.length}</b> answers</span><span><b>${s.topics.length}</b> topics</span><span><b>${s.bodySystems.length}</b> body systems</span></p></section>`
    + coreHtml
    + `<section aria-labelledby="topics-h"><div class="kb-sec-head"><h2 id="topics-h">Topics</h2><a href="/kb/topics">All topics →</a></div>${topicGrid(s)}</section>`
    + `<section aria-labelledby="bs-h"><div class="kb-sec-head"><h2 id="bs-h">Body systems</h2><a href="/kb/body-systems">All body systems →</a></div><p class="kb-sub">What the research says about each part of the body. Each card links to the matching studies in RF Safe's research directory.</p>${bodyGrid(s, { compact: true })}</section>`
    + `<section aria-labelledby="sc-h"><div class="kb-sec-head"><h2 id="sc-h">Safety-claim critiques</h2></div>${critiquesBlock(s)}</section>`
    + `<section class="kb-ai" aria-labelledby="ai-h"><h2 id="ai-h">For AI tools</h2><p>Send an AI tool to <a href="/kb/llms.txt">rfsafe.app/kb/llms.txt</a> or <a href="/kb/all.md">rfsafe.app/kb/all.md</a> and it can read every public RF Safe position, with links. Developers can use the <a href="/kb/api/v1/kb.json">JSON feed</a>. <a href="/kb/for-ai">How it works →</a></p></section>`;
  const ld = [{ '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'RF Safe Knowledge Base', url: s.base + '/kb', description: 'RF Safe\'s public answers and positions on wireless radiation, by topic.', publisher: { '@type': 'Organization', name: 'RF Safe', url: s.base + '/' }, dateModified: s.lastUpdated || undefined, hasPart: s.topics.map((t) => ({ '@type': 'WebPage', name: t.name, url: s.base + t.url })) }, core ? faqLd(s, [core]) : null];
  return layout({ s, assets, title: 'RF Safe Knowledge Base: positions on wireless radiation, in plain words', description: 'Search RF Safe\'s public answers on phone radiation, SAR, health effects, safety limits, children and pregnancy, and more. Open to people and AI tools.', canonical: '/kb', current: '/kb', body, ld, headerSearch: false });
}
function topicsPage(s, assets) {
  const items = [['/kb', 'Knowledge base'], ['/kb/topics', 'Topics']];
  const body = crumbs(items) + `<h1>Topics</h1><p class="kb-lead">${plural(s.entries.length, 'answer')} in ${plural(s.topics.length, 'topic')}.</p>` + topicGrid(s);
  return layout({ s, assets, title: 'Topics | RF Safe Knowledge Base', description: 'Browse RF Safe\'s public answers by topic.', canonical: '/kb/topics', current: '/kb/topics', body, ld: [crumbLd(s, items)] });
}
function topicPage(s, t, assets) {
  const list = t.slugs.map((x) => s.bySlug.get(x));
  const items = [['/kb', 'Knowledge base'], ['/kb/topics', 'Topics'], [t.url, t.name]];
  const others = s.topics.filter((x) => x.id !== t.id).map((x) => `<li><a href="${esc(x.url)}">${esc(x.name)}</a> <span class="kb-count">${x.count}</span></li>`).join('');
  const body = crumbs(items) + `<p class="kb-kicker">Topic</p><h1>${esc(t.name)}</h1><p class="kb-lead">${plural(t.count, 'answer')}.</p><ol class="kb-qs">${list.map((e) => qCard(e)).join('')}</ol>`
    + `<aside class="kb-aside" aria-labelledby="ot-h"><h2 id="ot-h">Other topics</h2><ul class="kb-inline">${others}</ul></aside>`;
  return layout({ s, assets, title: t.name + ' | RF Safe Knowledge Base', description: 'RF Safe\'s answers on ' + t.name + ': ' + list.slice(0, 3).map((e) => e.question).join(' '), canonical: t.url, current: '/kb/topics', body, ld: [crumbLd(s, items), faqLd(s, list, { full: false })] });
}
function entryPage(s, e, assets) {
  const t = s.topics.find((x) => x.name === e.topic);
  const items = [['/kb', 'Knowledge base'], [t.url, t.name], [e.url, e.question]];
  const rel = (s.related.get(e.slug) || []).map((x) => s.bySlug.get(x)).filter(Boolean);
  const idx = t.slugs.indexOf(e.slug); const prev = idx > 0 ? s.bySlug.get(t.slugs[idx - 1]) : null; const next = idx < t.slugs.length - 1 ? s.bySlug.get(t.slugs[idx + 1]) : null;
  const more = t.slugs.filter((x) => x !== e.slug && !rel.some((r) => r.slug === x)).slice(0, 6).map((x) => s.bySlug.get(x));
  const body = crumbs(items) + `<article class="kb-entry" aria-labelledby="entry-h"><p class="kb-kicker"><a href="${esc(t.url)}">${esc(e.topic)}</a></p><h1 id="entry-h">${esc(e.question)}</h1>`
    + `<div class="kb-prose">${renderText(e.text)}</div>`
    + `<p class="kb-meta">${e.updated ? `Updated <time datetime="${esc(e.updated)}">${esc(fmtDate(e.updated))}</time>` : ''}${e.source ? `${e.updated ? ' · ' : ''}Source: <a href="${esc(e.source)}">${esc(e.source.replace(/^https:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>` : ''}${e.updated || e.source ? ' · ' : ''}<a href="/kb/api/v1/entries/${esc(e.slug)}.json">JSON</a></p>`
    + (prev || next ? `<nav class="kb-pn" aria-label="More in ${esc(e.topic)}">${prev ? `<a rel="prev" href="${esc(prev.url)}"><span>← Previous</span>${esc(prev.question)}</a>` : '<span></span>'}${next ? `<a rel="next" href="${esc(next.url)}"><span>Next →</span>${esc(next.question)}</a>` : ''}</nav>` : '')
    + `</article>`
    + (rel.length ? `<section class="kb-aside" aria-labelledby="rel-h"><h2 id="rel-h">Related answers</h2><ul class="kb-qs">${rel.map((r) => qCard(r, { showTopic: true })).join('')}</ul></section>` : '')
    + (more.length ? `<section class="kb-aside" aria-labelledby="more-h"><h2 id="more-h">More in ${esc(e.topic)}</h2><ul class="kb-links">${more.map((m) => `<li><a href="${esc(m.url)}">${esc(m.question)}</a></li>`).join('')}</ul></section>` : '');
  return layout({ s, assets, title: e.question + ' | RF Safe Knowledge Base', description: excerpt(firstPara(e.text), 155), canonical: e.url, current: '', body, ld: [crumbLd(s, items), faqLd(s, [e])] });
}
function bodySystemsPage(s, assets) {
  const items = [['/kb', 'Knowledge base'], ['/kb/body-systems', 'Body systems']];
  const body = crumbs(items) + `<h1>Body systems</h1><p class="kb-lead">RF Safe's research directory sorts thousands of studies by the part of the body they looked at. Pick a body system to see its studies.</p>` + bodyGrid(s);
  return layout({ s, assets, title: 'Body systems | RF Safe Knowledge Base', description: 'Wireless radiation research sorted into 13 body systems, from the brain and nerves to the skin.', canonical: '/kb/body-systems', current: '/kb/body-systems', body, ld: [crumbLd(s, items)] });
}
function claimsPage(s, assets) {
  const items = [['/kb', 'Knowledge base'], ['/kb/safety-claims', 'Safety-claim critiques']];
  const body = crumbs(items) + `<h1>Safety-claim critiques</h1><p class="kb-lead">Studies and reviews often cited as proof that phones and wireless devices are safe, and what RF Safe says is wrong with each one.</p>${s.critiques.topic ? `<p class="kb-sub">These answers are also listed under the topic <a href="${esc(s.critiques.topic.url)}">${esc(s.critiques.topic.name)}</a>.</p>` : ''}` + critiquesBlock(s, { full: true });
  return layout({ s, assets, title: 'Safety-claim critiques | RF Safe Knowledge Base', description: 'Plain-language critiques of common wireless safety claims.', canonical: '/kb/safety-claims', current: '/kb/safety-claims', body, ld: [crumbLd(s, items)] });
}
function forAiPage(s, assets) {
  const items = [['/kb', 'Knowledge base'], ['/kb/for-ai', 'For AI tools']];
  const rows = [['/kb/llms.txt', 'text/plain', 'A short guide for AI tools, with a link to every answer.'], ['/kb/all.md', 'text/markdown', 'Every public answer in full, grouped by topic, with links.'],
    ['/kb/api/v1/kb.json', 'application/json', 'Everything as JSON: answers, topics, body systems and safety-claim critiques.'], ['/kb/api/v1/entries/<slug>.json', 'application/json', 'One answer and its related answers.'],
    ['/kb/api/v1/search-index.json', 'application/json', 'The small index the search box uses.']];
  const body = crumbs(items) + `<h1>For AI tools</h1><p class="kb-lead">Everything on this page is open. An AI tool that reads these files knows every public RF Safe position, with a link to each one.</p>`
    + `<div class="kb-table-wrap"><table class="kb-table"><caption class="kb-sr">Machine-readable formats</caption><thead><tr><th scope="col">Address</th><th scope="col">Format</th><th scope="col">What it has</th></tr></thead><tbody>${rows.map(([p, f, w]) => `<tr><td>${p.includes('<') ? `<code>${esc(p)}</code>` : `<a href="${esc(p)}"><code>${esc(p)}</code></a>`}</td><td>${esc(f)}</td><td>${esc(w)}</td></tr>`).join('')}</tbody></table></div>`
    + `<h2>Good to know</h2><ul class="kb-list"><li>The files are built from the live knowledge base on every request, so they are never more than a few seconds old.</li><li>JSON responses carry <code>schema</code>, <code>version</code> and <code>data_version</code> fields. <code>data_version</code> changes whenever an answer changes.</li><li>Pages also carry schema.org FAQPage markup.</li><li>Please link to the answer's page when you quote it.</li></ul>`;
  return layout({ s, assets, title: 'For AI tools | RF Safe Knowledge Base', description: 'How AI tools and developers can read RF Safe\'s public knowledge base: llms.txt, Markdown and JSON.', canonical: '/kb/for-ai', current: '/kb/for-ai', body, ld: [crumbLd(s, items)] });
}
// Server-side search (works without JavaScript): every query word must appear; title hits count most.
function search(s, q, limit = 50) {
  const terms = D.words(q).slice(0, 12); if (!terms.length) return [];
  const docs = [...s.entries.map((e) => ({ kind: 'Answer', title: e.question, sub: e.topic, url: e.url, text: e.text, key: e._k, ex: excerpt(firstPara(e.text), 170) })),
    ...s.topics.map((t) => ({ kind: 'Topic', title: t.name, sub: plural(t.count, 'answer'), url: t.url, text: '', key: '', ex: '' })),
    ...s.bodySystems.map((b) => ({ kind: 'Body system', title: b.name, sub: b.research_label || '', url: b.research_url, text: b.summary || '', key: b.id + ' ' + (b.research_label || ''), ex: b.summary ? excerpt(b.summary, 170) : '' })),
    ...s.critiques.items.map((c) => ({ kind: 'Safety claim', title: c.claim, sub: c.claimed_by, url: '/kb/safety-claims#claim-' + c.id, text: c.critique, key: '', ex: excerpt(c.critique, 170) }))];
  const out = [];
  for (const d of docs) {
    const T = ' ' + D.words(d.title + ' ' + d.sub).join(' ') + ' '; const B = ' ' + D.words(d.key + ' ' + d.text).join(' ') + ' ';
    let score = 0; let ok = true;
    for (const w of terms) { const inT = T.includes(' ' + w); const inB = B.includes(' ' + w); if (!inT && !inB) { ok = false; break; } score += inT ? 5 : 1; }
    if (ok) out.push({ ...d, score: score + (d.kind === 'Topic' ? 2 : 0) });
  }
  return out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}
function searchPage(s, q, assets) {
  const items = [['/kb', 'Knowledge base'], ['/kb/search', 'Search']];
  const r = q ? search(s, q) : [];
  const body = crumbs(items) + `<h1>Search</h1>${searchBox(q, true)}`
    + (q ? `<p class="kb-lead" role="status">${r.length ? plural(r.length, 'result') + ' for “' + esc(q) + '”' : 'No answers match “' + esc(q) + '”. Try fewer or different words, or browse the <a href="/kb/topics">topics</a>.'}</p>` : '<p class="kb-lead">Type a word or a question.</p>')
    + (r.length ? `<ol class="kb-qs">${r.map((d) => `<li class="kb-q"><a href="${esc(d.url)}"><span class="kb-q-title">${esc(d.title)}</span><span class="kb-chip">${esc(d.kind)}${d.sub ? ' · ' + esc(d.sub) : ''}</span>${d.ex ? `<span class="kb-q-ex">${esc(d.ex)}</span>` : ''}</a></li>`).join('')}</ol>` : '');
  return layout({ s, assets, title: (q ? q + ' | ' : '') + 'Search | RF Safe Knowledge Base', description: 'Search RF Safe\'s public knowledge base.', canonical: '/kb/search', current: '', body, ld: [], q: '', noindex: true, headerSearch: false });
}
function notFoundPage(s, assets) {
  const body = `<h1>That answer isn't here</h1><p class="kb-lead">It may have moved or been taken down. Try searching, or start from the <a href="/kb">knowledge base home</a>.</p>${searchBox('', true)}`;
  return layout({ s, assets, title: 'Not found | RF Safe Knowledge Base', description: 'Not found', canonical: '/kb', body, noindex: true, headerSearch: false });
}

// ---------- AI formats ----------
function llmsTxt(s) {
  const L = [`# RF Safe Knowledge Base`, '', `> RF Safe's public answers and positions on wireless (radio-frequency) radiation: the science, health effects, safety limits, SAR testing, the FCC and HHS, children and pregnancy, everyday habits and RF Safe itself. ${s.entries.length} answers in ${s.topics.length} topics, read live from the same knowledge base RF Safe's phone line and mailbox use.`, '',
    'Notes for AI tools:', '- Quote answers as RF Safe\'s positions and link to the answer page.', '- This is general information, not medical advice.', '- Full text of every answer: ' + s.base + '/kb/all.md', '- JSON (schema ' + D.SCHEMA + ', version ' + D.API_VERSION + '): ' + s.base + '/kb/api/v1/kb.json', '- Data version: ' + s.dataVersion + (s.lastUpdated ? ' (last change ' + s.lastUpdated + ')' : ''), ''];
  if (s.core) L.push('## Start here', '', `- [${s.core.question}](${s.base}${s.core.url}): ${excerpt(firstPara(s.core.text), 240)}`, '');
  L.push('## Machine-readable', '', `- [All positions in Markdown](${s.base}/kb/all.md): every public answer in full, by topic`, `- [Knowledge base JSON](${s.base}/kb/api/v1/kb.json): answers, topics, body systems, safety-claim critiques`, `- [One answer as JSON](${s.base}/kb/api/v1/entries/${D.CORE_SLUG}.json): /kb/api/v1/entries/<slug>.json`, `- [How AI tools can use this](${s.base}/kb/for-ai)`, '');
  for (const t of s.topics) {
    L.push('## ' + t.name, '');
    for (const x of t.slugs) { const e = s.bySlug.get(x); L.push(`- [${e.question}](${s.base}${e.url}): ${excerpt(firstPara(e.text), 160)}`); }
    L.push('');
  }
  L.push('## Body systems', '', ...s.bodySystems.map((b) => `- [${b.name}](${s.base}${b.research_url}): studies in RF Safe's research directory${b.summary ? '. ' + excerpt(b.summary, 160) : ''}`), '');
  const critLines = [...(s.critiques.topic ? [`- [All safety-claim critiques](${s.base}/kb/safety-claims): see the "${s.critiques.topic.name}" topic above (${s.critiques.overview.length + s.critiques.studies.length} answers)`] : []), ...s.critiques.items.map((c) => `- [Claim: ${c.claim}](${s.base}/kb/safety-claims#claim-${c.id}): ${excerpt(c.critique, 160)}`)];
  L.push('## Safety-claim critiques', '', critLines.length ? critLines.join('\n') : '- Coming soon.', '');
  L.push('## Optional', '', `- [RF Safe research directory](${s.base}/research): thousands of study summaries`, `- [rfsafe.app llms.txt](${s.base}/llms.txt): the whole site`, '');
  return L.join('\n');
}
function allMd(s) {
  const L = ['# RF Safe Knowledge Base: all public positions', '', `Source: ${s.base}/kb · ${s.entries.length} answers in ${s.topics.length} topics · data version ${s.dataVersion}${s.lastUpdated ? ' · last change ' + s.lastUpdated : ''}`, '', 'These are RF Safe\'s positions, in RF Safe\'s words. General information, not medical advice. Please link to the answer page when you quote an answer.', ''];
  L.push('## Contents', '', ...s.topics.map((t) => `- ${t.name} (${t.count}): ${s.base}${t.url}`), '');
  for (const t of s.topics) {
    L.push('## ' + t.name, '');
    for (const x of t.slugs) {
      const e = s.bySlug.get(x);
      L.push('### ' + e.question, '', `Link: ${s.base}${e.url}${e.updated ? ' · Updated: ' + e.updated.slice(0, 10) : ''}${e.source ? ' · Source: ' + e.source : ''}`, '', e.text, '');
    }
  }
  L.push('## Body systems', '', ...s.bodySystems.map((b) => `### ${b.name}\n\nStudies: ${s.base}${b.research_url}\n\n${b.summary || 'Summary coming soon.'}\n`), '');
  L.push('## Safety-claim critiques', '', s.critiques.topic ? `The critiques are the "${s.critiques.topic.name}" answers above (${s.base}/kb/safety-claims).\n` : '', s.critiques.items.length ? s.critiques.items.map((c) => `### Claim: ${c.claim}\n\n${c.claimed_by ? 'Made by: ' + c.claimed_by + '\n\n' : ''}${c.critique}\n${c.sources.length ? '\nSources: ' + c.sources.map((y) => y.url).join(' , ') + '\n' : ''}`).join('\n') : (s.critiques.topic ? '' : 'Coming soon.'), '');
  return L.join('\n');
}
function kbJson(s) {
  const b = s.base;
  return { schema: D.SCHEMA, version: D.API_VERSION, data_version: s.dataVersion, generated_at: new Date(s.at).toISOString(), last_updated: s.lastUpdated, site: b + '/kb',
    about: 'RF Safe\'s public answers and positions on wireless radiation. General information, not medical advice. Link to each entry\'s url when quoting.',
    counts: { entries: s.entries.length, topics: s.topics.length, body_systems: s.bodySystems.length, safety_claim_critiques: s.critiques.overview.length + s.critiques.studies.length + s.critiques.items.length },
    core_slug: s.core ? s.core.slug : null,
    endpoints: { html: b + '/kb', llms_txt: b + '/kb/llms.txt', all_md: b + '/kb/all.md', json: b + '/kb/api/v1/kb.json', entry_json: b + '/kb/api/v1/entries/{slug}.json', search_index: b + '/kb/api/v1/search-index.json' },
    topics: s.topics.map((t) => ({ id: t.id, name: t.name, url: b + t.url, count: t.count, slugs: t.slugs })),
    entries: s.entries.map((e) => ({ ...D.publicShape(e, b), related: s.related.get(e.slug) || [] })),
    body_systems: s.bodySystems.map((x) => ({ id: x.id, name: x.name, research_label: x.research_label, research_url: b + x.research_url, summary: x.summary, summary_updated: x.summary_updated })),
    safety_claim_critiques: { status: s.critiques.status, topic_id: s.critiques.topic ? s.critiques.topic.id : null, overview: s.critiques.overview, studies: s.critiques.studies, items: s.critiques.items } };
}
function entryJson(s, e) {
  return { schema: D.SCHEMA, version: D.API_VERSION, data_version: s.dataVersion, entry: D.publicShape(e, s.base), related: (s.related.get(e.slug) || []).map((x) => s.bySlug.get(x)).filter(Boolean).map((r) => ({ slug: r.slug, url: s.base + r.url, question: r.question, topic: r.topic })) };
}
// Compact client-side search index: short keys, an excerpt and the distinct words of each answer.
function searchIndex(s) {
  const uniq = (t) => [...new Set(D.words(t))].join(' ');
  return { schema: D.SCHEMA + '/search-index', version: D.API_VERSION, data_version: s.dataVersion,
    docs: [...s.entries.map((e) => ({ u: e.url, t: e.question, s: e.topic, k: 'Answer', x: excerpt(firstPara(e.text), 150), w: uniq(e._k + ' ' + e.text) })),
      ...s.topics.map((t) => ({ u: t.url, t: t.name, s: plural(t.count, 'answer'), k: 'Topic', x: '', w: '' })),
      ...s.bodySystems.map((b) => ({ u: b.research_url, t: b.name, s: b.research_label || 'Body system', k: 'Body system', x: b.summary ? excerpt(b.summary, 150) : 'See the studies for this body system.', w: uniq(b.id + ' ' + (b.research_label || '') + ' ' + (b.summary || '')) })),
      ...s.critiques.items.map((c) => ({ u: '/kb/safety-claims#claim-' + c.id, t: 'Claim: ' + c.claim, s: c.claimed_by || 'Safety claim', k: 'Safety claim', x: excerpt(c.critique, 150), w: uniq(c.critique) }))] };
}

// Per-site public KB (brand.json "public_kb": { "replace": [[from, to], ...], "hide": ["/kb/body-systems", ...] };
// portable package port/site.config.js). rfsafe.app sets neither, so its pages are unchanged.
const SITE_KB = (() => { try { return require('../brand').public_kb || {}; } catch { return {}; } })();
const KB_REPLACE = Array.isArray(SITE_KB.replace) ? SITE_KB.replace.filter((p) => Array.isArray(p) && p.length === 2 && p[0]) : [];
const KB_HIDE = new Set(Array.isArray(SITE_KB.hide) ? SITE_KB.hide : []);
for (let i = NAV.length - 1; i >= 0; i--) if (KB_HIDE.has(NAV[i][0])) NAV.splice(i, 1);
const rebrand = (fn) => (KB_REPLACE.length ? (...a) => KB_REPLACE.reduce((out, [f, r]) => out.split(String(f)).join(String(r)), String(fn(...a))) : fn);
const hidden = (rest) => KB_HIDE.has('/kb' + rest) || (rest === '/critiques' && KB_HIDE.has('/kb/safety-claims'));
module.exports = { hidden, startPage: rebrand(startPage), topicsPage: rebrand(topicsPage), topicPage: rebrand(topicPage), entryPage: rebrand(entryPage), bodySystemsPage: rebrand(bodySystemsPage), claimsPage: rebrand(claimsPage), forAiPage: rebrand(forAiPage), searchPage: rebrand(searchPage), notFoundPage: rebrand(notFoundPage), llmsTxt: rebrand(llmsTxt), allMd: rebrand(allMd), kbJson, entryJson, searchIndex, search, renderText, esc, CSP, THEME_JS, excerpt };
