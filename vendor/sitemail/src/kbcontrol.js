'use strict';
// Owner-only, read-only knowledge-base control page. Driven by the live KB (repo base + curated +
// wiki + API entries). No edit controls; changes go through the owner API. Never includes customer mail.
const fs = require('fs');
const path = require('path');
const { parse } = require('./kb');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function topicOf(doc) {
  if (doc.topic) return String(doc.topic).trim() || 'General';
  const blob = [doc.title, doc.aliases, doc.slug, doc.file].filter(Boolean).join(' ').toLowerCase();
  const rules = [
    ['Shipping', /ship|usps|delivery|international|transit|seminole|east coast|west coast/],
    ['Returns and refunds', /refund|return|exchange|money-back|guarantee|replacement/],
    ['Children and families', /child|children|kid|teen|family|pregnant/],
    ['MagSafe and wireless charging', /magsafe|wireless charg|qi\b/],
    ['Cases and products', /quantacase|truthcase|case|product|iphone|galaxy|pixel/],
    ['SAR and radiation', /\bsar\b|radiation|rf exposure|emissions|absorption/],
    ['Science and research', /science|study|studies|research|ntp|fcc|who\b/],
    ['How we answer', /voice-answer|how we answer|disclosure|script|instruction/],
    ['Policies', /policy|terms|privacy|newsletter/]
  ];
  for (const [name, re] of rules) if (re.test(blob)) return name;
  const titled = String(doc.title || '').replace(/^Owner-approved (?:answer|refund policy):\s*/i, '').trim();
  const head = titled.split(/[:—–-]/)[0].trim();
  if (head && head.length >= 3 && head.length <= 48 && head !== titled) return head;
  return 'General';
}

function walkMd(dir, into) {
  if (!dir || !fs.existsSync(dir)) return;
  const walk = (p) => {
    let ents = [];
    try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) walk(q);
      else if (e.name.endsWith('.md')) into.set(e.name, q);
    }
  };
  walk(dir);
}

function sourceKind(file, apiDir) {
  const f = String(file || '').replace(/\\/g, '/');
  if (apiDir && f.startsWith(String(apiDir).replace(/\\/g, '/') + '/')) return 'api';
  if (/\/kb\/curated\//.test(f) || /\/curated\//.test(f)) return 'curated';
  if (/-wiki\//.test(f)) return 'wiki';
  return 'base';
}

function catalog({ tenant, tenantsDir, dataDir, apiStore, maxDocs = 20000 } = {}) {
  const id = tenant && tenant.id ? tenant.id : 'rfsafe';
  const files = new Map(); // name -> path, later dirs do not yet override
  const overrides = new Map();
  const apiDir = apiStore ? apiStore.entriesDir(id) : path.join(dataDir || '', 'kb-api', id, 'entries');
  walkMd(apiDir, overrides);
  const dirs = [];
  for (const p of (tenant && tenant.kb && tenant.kb.dirs) || []) dirs.push(path.resolve(tenantsDir, p));
  const curated = path.join(__dirname, '..', 'kb', 'curated', String(id).replace(/[^a-z0-9_-]/gi, ''));
  const wiki = dataDir ? path.join(dataDir, 'kb', String(id).replace(/[^a-z0-9_-]/gi, '') + '-wiki') : null;
  for (const d of [curated, wiki]) if (d) dirs.push(d);
  for (const d of dirs) walkMd(d, files);
  const entries = [];
  const seen = new Set();
  const addFile = (name, file, kind) => {
    if (seen.has(name) || entries.length >= maxDocs) return;
    let raw = ''; try { raw = fs.readFileSync(file, 'utf8'); } catch { return; }
    const doc = parse(raw, file);
    let mtime = null; try { mtime = fs.statSync(file).mtime.toISOString(); } catch {}
    const slug = name.replace(/\.md$/i, '');
    const meta = kind === 'api' && apiStore ? apiStore.get(id, slug) : null;
    entries.push({
      slug, title: doc.title || slug, text: String(doc.body || '').trim(), aliases: doc.aliases || '',
      source: doc.source || (meta && meta.source) || '', topic: topicOf({ ...doc, slug, file }),
      kind: meta ? 'api' : kind, updated: (meta && meta.updated) || mtime,
      enabled: meta ? !!meta.enabled : true,
      gap_id: (meta && meta.gap_id) || '', source_question: (meta && meta.source_question) || '',
      owner_approved: meta ? !!meta.owner_approved : /Owner-approved (?:answer|refund policy)/i.test(raw)
    });
    seen.add(name);
  };
  // API entries overlay the same filename in the base.
  for (const [name, file] of [...overrides.entries()].sort((a, b) => a[0].localeCompare(b[0]))) addFile(name, file, 'api');
  for (const [name, file] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (overrides.has(name)) continue;
    addFile(name, file, sourceKind(file, apiDir));
  }
  const topics = [...new Set(entries.map((e) => e.topic))].sort((a, b) => a.localeCompare(b));
  const counts = {
    entries: entries.length,
    topics: topics.length,
    base: entries.filter((e) => e.kind === 'base').length,
    api: entries.filter((e) => e.kind === 'api').length,
    curated: entries.filter((e) => e.kind === 'curated').length,
    wiki: entries.filter((e) => e.kind === 'wiki').length
  };
  const history = apiStore && apiStore.history ? apiStore.history(id, { limit: 200 }) : [];
  return { tenant: id, entries, topics, counts, history };
}

function excerpt(s, n = 220) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '') + '…';
}

function page({ catalog, view = 'topics', q = '', topic = '', entry = '', shell }) {
  const counts = catalog.counts || { entries: 0, topics: 0, base: 0, api: 0 };
  const query = String(q || '').trim();
  const topicF = String(topic || '').trim();
  const slugF = String(entry || '').trim();
  const v = ['topics', 'newest', 'history'].includes(view) ? view : 'topics';
  const qlow = query.toLowerCase();
  const match = (e) => !qlow || [e.title, e.text, e.aliases, e.slug, e.topic].join('\n').toLowerCase().includes(qlow);
  const kindLabel = { base: 'Base', api: 'API', curated: 'Curated', wiki: 'Wiki' };
  const href = (over) => {
    const p = new URLSearchParams();
    const next = { view: v, q: query, topic: topicF, entry: slugF, ...over };
    for (const [k, val] of Object.entries(next)) if (val) p.set(k, val);
    const s = p.toString();
    return '/bizinator/admin/kb' + (s ? '?' + s : '');
  };
  const nav = ['topics', 'newest', 'history'].map((name) => {
    const label = name === 'topics' ? 'By topic' : name === 'newest' ? 'Newest' : 'Change history';
    const cur = v === name;
    return `<a href="${esc(href({ view: name, entry: name === 'history' ? '' : slugF }))}"${cur ? ' style="font-weight:bold"' : ''}>${label}</a>`;
  }).join(' · ');
  const countsLine = `<p><b>${counts.entries}</b> entries · <b>${counts.topics}</b> topics · ${counts.base} base · ${counts.api} from the API${counts.curated ? ' · ' + counts.curated + ' curated' : ''}${counts.wiki ? ' · ' + counts.wiki + ' wiki' : ''}</p>`;
  const search = `<form method="get" action="/bizinator/admin/kb"><input type="hidden" name="view" value="${esc(v)}">${topicF ? `<input type="hidden" name="topic" value="${esc(topicF)}">` : ''}<label>Search <input name="q" value="${esc(query)}" size="40" placeholder="title or text"></label> <button type="submit">Search</button>${query ? ' <a href="' + esc(href({ q: '', entry: '' })) + '">Clear</a>' : ''}</form>`;
  let body = '';
  const one = slugF ? (catalog.entries || []).find((e) => e.slug === slugF) : null;
  if (one) {
    body += `<p><a href="${esc(href({ entry: '' }))}">← Back</a></p><h2>${esc(one.title)}</h2>`
      + `<p><small>${esc(one.topic)} · ${esc(kindLabel[one.kind] || one.kind)}${one.updated ? ' · updated ' + esc(one.updated) : ''}${one.gap_id ? ' · gap ' + esc(one.gap_id) : ''}</small></p>`
      + (one.source_question ? `<p><small>From question: ${esc(one.source_question)}</small></p>` : '')
      + `<pre style="white-space:pre-wrap;font:14px/1.45 ui-monospace,monospace">${esc(one.text)}</pre>`;
  } else if (v === 'history') {
    let rows = catalog.history || [];
    if (qlow) rows = rows.filter((r) => [r.title, r.slug, r.old_text, r.new_text, r.source_question, r.gap_id].join('\n').toLowerCase().includes(qlow));
    if (!rows.length) body += '<p>No API changes recorded yet. History lists additions and updates made through the knowledge-base API, with the previous wording from each backup.</p>';
    else body += rows.map((r) => {
      const gap = r.gap_id || r.source_question
        ? `<p><small>${r.gap_id ? 'Gap ' + esc(r.gap_id) : ''}${r.gap_id && r.source_question ? ' · ' : ''}${r.source_question ? 'Question: ' + esc(r.source_question) : ''}</small></p>`
        : '';
      const changed = r.old_text !== r.new_text;
      return `<section style="border-top:1px solid #ddd;margin:18px 0;padding-top:12px"><h3>${esc(r.title || r.slug)}</h3>`
        + `<p><small>${esc(r.at || '')} · ${esc(r.action)} · ${esc(r.slug)}</small></p>${gap}`
        + (changed
          ? `<p><b>Previous wording</b></p><pre style="white-space:pre-wrap;background:#f6f6f6;padding:8px">${esc(r.old_text || '(none)')}</pre><p><b>New wording</b></p><pre style="white-space:pre-wrap;background:#f6f6f6;padding:8px">${esc(r.new_text || '(none)')}</pre>`
          : `<p><small>No wording change.</small></p>`)
        + `</section>`;
    }).join('');
  } else if (v === 'newest') {
    let rows = (catalog.entries || []).filter(match).slice();
    rows.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
    rows = rows.slice(0, 80);
    body += '<p>Most recently added or changed cards (API updates first when they have a timestamp; base files use the file time).</p>';
    body += '<table><tr><th>Updated</th><th>Title</th><th>Topic</th><th>Source</th></tr>'
      + (rows.map((e) => `<tr><td><small>${esc(e.updated || '')}</small></td><td><a href="${esc(href({ entry: e.slug }))}">${esc(e.title)}</a></td><td>${esc(e.topic)}</td><td>${esc(kindLabel[e.kind] || e.kind)}</td></tr>`).join('') || '<tr><td colspan="4">Nothing matches.</td></tr>')
      + '</table>';
  } else {
    let rows = (catalog.entries || []).filter(match);
    if (topicF) rows = rows.filter((e) => e.topic === topicF);
    const by = new Map();
    for (const e of rows) { const t = e.topic || 'General'; if (!by.has(t)) by.set(t, []); by.get(t).push(e); }
    const names = [...by.keys()].sort((a, b) => a.localeCompare(b));
    if (topicF) body += `<p>Topic: <b>${esc(topicF)}</b> · <a href="${esc(href({ topic: '' }))}">All topics</a></p>`;
    else body += '<p>Topics: ' + (catalog.topics || []).map((t) => `<a href="${esc(href({ topic: t }))}">${esc(t)}</a>`).join(' · ') + '</p>';
    for (const name of names) {
      const list = by.get(name).slice().sort((a, b) => a.title.localeCompare(b.title));
      body += `<h2>${esc(name)} <small>(${list.length})</small></h2><ul>`;
      for (const e of list) body += `<li><a href="${esc(href({ entry: e.slug, topic: topicF }))}">${esc(e.title)}</a> <small>${esc(kindLabel[e.kind] || e.kind)}</small>${query ? '<br><small>' + esc(excerpt(e.text)) + '</small>' : ''}</li>`;
      body += '</ul>';
    }
    if (!names.length) body += '<p>Nothing matches that search.</p>';
  }
  const html = `<p><a href="/bizinator/admin">← Admin</a></p><h1>Knowledge base</h1>`
    + `<p>Read-only view of the live knowledge base used by the phone line and the mailbox. Edits go through the approved API.</p>`
    + countsLine + `<p>${nav}</p>` + search + body;
  return shell('Knowledge base', html);
}

module.exports = { catalog, page, topicOf, excerpt };
