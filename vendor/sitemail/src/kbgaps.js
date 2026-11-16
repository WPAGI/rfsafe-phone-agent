'use strict';
// KB gaps: questions the agent could not answer (calls and texts, from kb-gaps.jsonl), grouped by question,
// with a resolve flow that writes a curated answer card into DATA_DIR/kb/<tenant>-wiki/ (indexed by the KB,
// curated cards rank first) and records the resolution in kb-gaps-resolved.jsonl. Admin-only; nothing public.
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const norm = (q) => String(q || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const gapId = (tenant, q) => crypto.createHash('sha256').update(String(tenant) + '|' + norm(q)).digest('hex').slice(0, 16);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = (s) => norm(s).replace(/ /g, '-').slice(0, 60) || 'answer';

function resolvedFile(gapFile) { return path.join(path.dirname(gapFile), 'kb-gaps-resolved.jsonl'); }
function wikiDir(dataDir, tenant) { return path.join(dataDir, 'kb', String(tenant).replace(/[^a-z0-9_-]/gi, '') + '-wiki'); }

// Grouped list, newest first: { id, tenant, question, count, channels, reasons, first_at, last_at, calls, status, resolved_at, card }
function list(gapFile, { status = 'all' } = {}) {
  const res = new Map(); for (const r of readJsonl(resolvedFile(gapFile))) res.set(r.id, r);
  const g = new Map();
  for (const e of readJsonl(gapFile)) {
    if (!e.question) continue; const id = gapId(e.tenant, e.question);
    let x = g.get(id); if (!x) { x = { id, tenant: e.tenant || '', question: String(e.question), count: 0, channels: [], reasons: [], first_at: e.at, last_at: e.at, calls: [], messages: [], sources: [] }; g.set(id, x); }
    x.count++; if (e.at > x.last_at) { x.last_at = e.at; x.question = String(e.question); } if (e.at < x.first_at) x.first_at = e.at;
    for (const [k, v] of [['channels', e.channel], ['reasons', e.reason], ['calls', e.call], ['messages', e.message_id], ['sources', e.source]]) if (v && !x[k].includes(v) && x[k].length < 10) x[k].push(v);
  }
  const out = [...g.values()].map((x) => { const r = res.get(x.id); const open = !r || r.status === 'reopened' || (r.resolved_at && x.last_at > r.resolved_at); return { ...x, status: open ? 'open' : 'resolved', resolved_at: r && r.resolved_at || '', card: r && r.card || '', note: r && r.note || '' }; });
  out.sort((a, b) => (a.status === b.status ? (b.last_at > a.last_at ? 1 : -1) : a.status === 'open' ? -1 : 1));
  return status === 'all' ? out : out.filter((x) => x.status === status);
}

// Add or update an answer card and mark the gap resolved. answer required (unless mark_only).
function resolve({ gapFile, dataDir, id, tenant, title, answer, aliases, source, note, who, markOnly = false, now = () => new Date() }) {
  const gap = list(gapFile).find((x) => x.id === id);
  if (!gap) return { ok: false, error: 'not_found' };
  const t = gap.tenant || tenant; let card = '';
  if (!markOnly) {
    const body = String(answer || '').replace(/\r/g, '').trim().slice(0, 6000);
    if (body.length < 10) return { ok: false, error: 'answer_required' };
    const src = String(source || '').trim();
    if (src && !/^https:\/\/[^\s"<>]+$/.test(src)) return { ok: false, error: 'bad_source' };
    const ti = String(title || gap.question).replace(/[\r\n"]+/g, ' ').trim().slice(0, 140);
    const al = [gap.question, String(aliases || '')].join(' ').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
    const dir = wikiDir(dataDir, t); fs.mkdirSync(dir, { recursive: true });
    card = 'gap-' + slug(ti) + '-' + id.slice(0, 6) + '.md';
    const md = ['---', 'title: ' + JSON.stringify(ti), src ? 'source: ' + src : null, 'aliases: ' + al, 'page_type: answer', 'updated: ' + now().toISOString().slice(0, 10), '---'].filter(Boolean).join('\n') + '\n' + body + '\n' + (src ? '\nSources: ' + src + '\n' : '');
    const tmp = path.join(dir, '.' + card + '.tmp'); fs.writeFileSync(tmp, md, { mode: 0o600 }); fs.renameSync(tmp, path.join(dir, card));
  }
  const rec = { at: now().toISOString(), id, tenant: t, question: gap.question, status: 'resolved', resolved_at: now().toISOString(), card, note: String(note || '').slice(0, 300), by: who || 'admin' };
  fs.appendFileSync(resolvedFile(gapFile), JSON.stringify(rec) + '\n', { mode: 0o600 });
  return { ok: true, card, tenant: t };
}
function reopen({ gapFile, id, who, now = () => new Date() }) {
  if (!list(gapFile).some((x) => x.id === id)) return { ok: false, error: 'not_found' };
  fs.appendFileSync(resolvedFile(gapFile), JSON.stringify({ at: now().toISOString(), id, status: 'reopened', by: who || 'admin' }) + '\n', { mode: 0o600 }); return { ok: true };
}
function readCard(dataDir, tenant, card) { if (!/^gap-[a-z0-9-]+\.md$/.test(card || '')) return ''; try { return fs.readFileSync(path.join(wikiDir(dataDir, tenant), card), 'utf8'); } catch { return ''; } }

function page({ rows, csrf, status, msg, err, edit, editCard }) {
  const tab = (s, l) => `<a href="/bizinator/admin/kb-gaps?status=${s}"${status === s ? ' style="font-weight:bold"' : ''}>${l}</a>`;
  const open = rows.filter((r) => r.status === 'open').length;
  const tr = rows.slice(0, 300).map((r) => `<tr><td>${esc(r.question)}<br><small>${esc(r.channels.join(', '))} · ${esc(r.reasons.join(', '))}</small></td><td>${r.count}</td><td><small>${esc(r.last_at)}</small></td><td>${r.status === 'open' ? '<b>open</b>' : 'resolved<br><small>' + esc(r.resolved_at) + (r.card ? '<br>' + esc(r.card) : '') + '</small>'}</td><td><a href="/bizinator/admin/kb-gaps?status=${esc(status)}&amp;edit=${esc(r.id)}#edit">${r.status === 'open' ? 'Answer' : 'Update'}</a>${r.status === 'resolved' ? ` <form method="post" action="/bizinator/admin/kb-gaps/reopen" style="display:inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="id" value="${esc(r.id)}"><button class="sm">Reopen</button></form>` : ''}</td></tr>`).join('');
  let form = '';
  if (edit) {
    const body = editCard ? editCard.replace(/^---[\s\S]*?---\n/, '').replace(/\n\nSources:[^\n]*\n?$/, '').trim() : '';
    const src = (editCard.match(/^source: (.*)$/m) || [])[1] || ''; const ti = ((editCard.match(/^title: (.*)$/m) || [])[1] || '').replace(/^"|"$/g, '');
    form = `<h2 id="edit">${edit.status === 'open' ? 'Add an answer' : 'Update the answer'}</h2><p><b>Question:</b> ${esc(edit.question)} <small>(asked ${edit.count}×)</small></p>
<form method="post" action="/bizinator/admin/kb-gaps/resolve"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="id" value="${esc(edit.id)}">
<p><label>Title<br><input name="title" size="70" value="${esc(ti || edit.question)}"></label></p>
<p><label>Answer (what the agent should say; facts only, the agent reads this from the knowledge base)<br><textarea name="answer" rows="8" cols="90" required>${esc(body)}</textarea></label></p>
<p><label>Other ways people ask it (optional keywords)<br><input name="aliases" size="70"></label></p>
<p><label>Source link (optional, https on an official site)<br><input name="source" size="70" value="${esc(src)}"></label></p>
<p><label>Note (optional)<br><input name="note" size="70"></label></p>
<p><button type="submit">Save answer and mark resolved</button> <button type="submit" name="mark_only" value="1" class="sm">Mark resolved without an answer</button></p></form>`;
  }
  return `<p><a href="/bizinator/admin">← Admin</a></p><h1>Unanswered questions (KB gaps)</h1>
${msg ? `<p class="ok">${esc(msg)}</p>` : ''}${err ? `<p class="err">${esc(err)}</p>` : ''}
<p>Questions the phone and text agent could not answer from the knowledge base. Add an answer to put it in the knowledge base (used on the next call) and mark the question resolved. A resolved question that is asked again reopens.</p>
<p>${tab('open', 'Open (' + open + ')')} · ${tab('resolved', 'Resolved')} · ${tab('all', 'All')} · <a href="/bizinator/admin/kb-gaps.json">JSON</a> · <a href="/bizinator/admin/kb-gaps.csv">CSV</a></p>
${form}<table><tr><th>Question</th><th>Times</th><th>Last asked</th><th>Status</th><th></th></tr>${tr || '<tr><td colspan="5">Nothing here.</td></tr>'}</table>`;
}
module.exports = { list, resolve, reopen, readCard, page, gapId, resolvedFile, wikiDir, readJsonl };
