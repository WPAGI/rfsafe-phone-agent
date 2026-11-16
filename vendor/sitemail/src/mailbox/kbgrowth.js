'use strict';
// Brain box coverage metric + growth loop (portable package; John, Nov 16 12:37 AM ET). Observer only: it never
// changes a reply, never writes a live Brain box entry, and never touches the host (phone) KB files.
//
// Coverage method, per question the writer handles (reply step "drafted" or "kb_gap"):
//   1. Query = the email subject + the first 300 characters of the text (the same first query the writer runs), plus
//      each question the writer could not answer (kb_gap).
//   2. Search the combined KB the bots use today (host phone KB, read-only, with Brain box entries on top), top 5.
//   3. A hit is "Brain box" when its title is a live, enabled Brain box entry title; otherwise "big KB".
//   4. State:  brain_box  a Brain box hit ranks first, or is in the top 3 with a score at least 80% of the top score
//              big_kb     the top hits are big-KB only (no Brain box hit in the top 3 that qualifies)
//              none       no KB hit at all (or the writer logged a KB gap)
//   5. "Brain box alone could have answered" = state brain_box AND the writer drafted a reply. Running share =
//      brain_box_answerable / questions. The bots keep using the combined KB until John decides to switch.
//
// Growth loop, only when state is big_kb and the writer drafted a reply (the big KB answered it):
//   propose ONE compact Brain box entry built from the top big-KB page, through the existing review inbox
//   (kbadmin store.propose, actor "Phone KB growth loop", a bot edit). Never when: bot auto-publish is ON (so nothing
//   can go live without John), the Brain box already has the slug, an open proposal exists for it, it was proposed
//   before, the page fails the public privacy filters (src/publickb/hostkb.js), the daily cap is reached, or the entry is
//   locked (store.propose refuses or routes it to Locked / For John). Every outcome is logged (growth-log.jsonl).
const fs = require('fs');
const path = require('path');

const COMPACT_MAX = 1500;
function compact(text, max = COMPACT_MAX) {
  const t = String(text || '').replace(/\r/g, '').trim(); if (t.length <= max) return t;
  const cut = t.lastIndexOf('\n\n', max); return t.slice(0, cut > max / 3 ? cut : max).trim();
}
const day = (d) => d.toISOString().slice(0, 10);

function createKbGrowth({ dir, kb, brainEntries, hostEntries = () => [], store = null, tenantId, siteBase = '', checkText = () => null, slugOf, proposeCap = 10, now = () => new Date(), log = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const F = { stats: path.join(dir, 'coverage.json'), log: path.join(dir, 'growth-log.jsonl'), done: path.join(dir, 'growth-proposed.json') };
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const write = (f, v) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(v, null, 1)); fs.renameSync(tmp, f); };
  const append = (rec) => { try { fs.appendFileSync(F.log, JSON.stringify({ at: now().toISOString(), ...rec }) + '\n', { mode: 0o600 }); } catch {} };

  function classify(queries) {
    const brain = new Map((brainEntries() || []).filter((e) => e && e.enabled !== false).map((e) => [String(e.title || '').trim(), e.slug]));
    let best = null;
    for (const q of queries.filter(Boolean)) {
      let hits = []; try { hits = kb().search(q, 5) || []; } catch { hits = []; }
      if (!hits.length) continue;
      const top = hits[0].score || 0;
      const bb = hits.slice(0, 3).find((h, i) => brain.has(String(h.title || '').trim()) && (i === 0 || (h.score || 0) >= 0.8 * top));
      const r = { state: bb ? 'brain_box' : 'big_kb', top: hits.slice(0, 3).map((h) => ({ title: h.title, score: h.score, layer: brain.has(String(h.title || '').trim()) ? 'brain_box' : 'big_kb' })), brain_slug: bb ? brain.get(String(bb.title).trim()) : null, bigTop: bb ? null : hits[0] };
      if (!best || (best.state !== 'brain_box' && r.state === 'brain_box')) best = r;
    }
    return best || { state: 'none', top: [] };
  }

  function propose(c, msgId) {
    const tid = tenantId();
    const h = c.bigTop; if (!h || !store || typeof store.propose !== 'function') return { outcome: 'skipped', why: 'no_store' };
    try { if (store.settings(tid).auto_publish) return { outcome: 'skipped', why: 'auto_publish_on' }; } catch {}
    const st = read(F.stats, {}); const today = day(now());
    if (((st.proposed_by_day || {})[today] || 0) >= proposeCap) return { outcome: 'skipped', why: 'daily_cap' };
    const title = String(h.title || '').trim(); if (!title) return { outcome: 'skipped', why: 'no_title' };
    const page = (hostEntries() || []).find((e) => e.title === title);
    const text = compact(page ? page.text : h.text);
    const slug = ('kb-' + slugOf(page ? page.slug : title)).slice(0, 80).replace(/-+$/, '');
    const done = read(F.done, {}); if (done[slug]) return { outcome: 'skipped', why: 'already_proposed', slug };
    if ((brainEntries() || []).some((e) => e.slug === slug)) return { outcome: 'skipped', why: 'in_brain_box', slug };
    try { if (store.listProposals(tid).some((p) => p.slug === slug && ['in_review', 'ready', 'for_owner'].includes(p.status))) return { outcome: 'skipped', why: 'open_proposal', slug }; } catch {}
    const blocked = !page ? (checkText(text) || null) : null; // adapter pages already passed the same filters
    if (blocked) return { outcome: 'skipped', why: 'privacy_filter:' + blocked, slug };
    if (text.length < 40) return { outcome: 'skipped', why: 'too_short', slug };
    const source = page && page.source ? page.source : (/^https:\/\//.test(String(h.source || '')) ? h.source : (page && siteBase ? siteBase.replace(/\/$/, '') + '/kb/' + page.slug : ''));
    const actor = { type: 'system', id: 'kb-growth', name: 'Phone KB growth loop', role: 'propose' };
    const r = store.propose(tid, actor, { slug, title: title.slice(0, 200), text, source, rationale: 'Email ' + msgId + ' was answered from the big phone KB page "' + title + '" (' + (page ? 'phone KB ' + page.page_type + ' page' : 'phone KB passage') + '); the Brain box had no matching entry. Compact copy for review; wording from the phone KB, unchanged.', summary: 'Growth loop: ' + title.slice(0, 110) });
    if (!r.ok) return { outcome: 'refused', why: r.error || 'refused', slug };
    done[slug] = { at: now().toISOString(), proposal_id: r.proposal.id, message_id: msgId }; write(F.done, done);
    st.proposed_by_day = { ...(st.proposed_by_day || {}), [today]: ((st.proposed_by_day || {})[today] || 0) + 1 }; write(F.stats, st);
    return { outcome: 'proposed', slug, proposal_id: r.proposal.id, status: r.proposal.status };
  }

  async function onReplied({ id, subject, text, outcome, gaps = [], step = () => {} }) {
    const queries = [String(subject || '') + ' ' + String(text || '').slice(0, 300), ...gaps];
    const c = classify(queries);
    const answerable = outcome === 'drafted' && c.state === 'brain_box';
    const st = read(F.stats, {}); st.questions = (st.questions || 0) + 1; st.brain_box_answerable = (st.brain_box_answerable || 0) + (answerable ? 1 : 0);
    st.by_state = { ...(st.by_state || {}) }; const key = outcome === 'kb_gap' ? 'kb_gap' : c.state; st.by_state[key] = (st.by_state[key] || 0) + 1; st.since = st.since || now().toISOString(); st.updated = now().toISOString(); write(F.stats, st);
    let g = { outcome: 'none' };
    if (outcome === 'drafted' && c.state === 'big_kb') g = propose(c, id);
    append({ message_id: id, outcome, coverage: c.state, brain_box_answerable: answerable, top: c.top, growth: g });
    log('kb_growth', { message_id: id, coverage: c.state, growth: g.outcome, why: g.why || null });
    step(g.outcome === 'proposed' ? 'proposed' : 'checked', 'Brain box coverage: ' + (answerable ? 'the Brain box alone could have answered this' : c.state === 'big_kb' ? 'answered from the big phone KB, not the Brain box' : 'no KB match') + (g.outcome === 'proposed' ? '; proposed Brain box entry ' + g.slug + ' for review (' + g.proposal_id + ')' : g.why ? '; no proposal (' + g.why + ')' : ''), { coverage: c.state });
    return { coverage: c, growth: g };
  }

  function coverage() {
    const st = read(F.stats, {}); const q = st.questions || 0;
    return { questions: q, brain_box_answerable: st.brain_box_answerable || 0, share: q ? +((st.brain_box_answerable || 0) / q).toFixed(3) : null, by_state: st.by_state || {}, since: st.since || null, updated: st.updated || null,
      proposals_today: (st.proposed_by_day || {})[day(now())] || 0, proposals_total: Object.values(st.proposed_by_day || {}).reduce((a, b) => a + b, 0),
      method: 'Per email the writer handles: search the combined KB (phone KB + Brain box) for the subject + first 300 characters (and each KB-gap question), top 5. Covered when a Brain box entry ranks first, or is in the top 3 within 80% of the top score, and a reply was drafted. Share = covered / questions.',
      decision: 'The bots keep answering from the combined KB until John decides to switch to the Brain box alone.' };
  }
  function recent(n = 50) { try { return fs.readFileSync(F.log, 'utf8').trim().split('\n').slice(-n).map((l) => JSON.parse(l)); } catch { return []; } }
  return { onReplied, classify, coverage, recent, compact };
}

module.exports = { createKbGrowth, compact, COMPACT_MAX };
