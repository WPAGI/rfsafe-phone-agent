'use strict';
// Checker evidence, health-reply allowance, and the checker-guided revise loop
// (John, 12:20–12:23 AM ET). Lookups go first in the checker payload so the 40k
// call() slice cannot drop the writer's store results. Medical replies may include
// related KB-backed facts, studies and exposure-reduction tips. After a checker
// fail, a revise step applies exact edits (at most MAX_REVISE times) and the
// checker rechecks; a full rerun is only used when critical information is
// missing and the lookups cannot supply it. Hard-block holds are never revised.
const P = require('./policy');

const MAX_REVISE = 2;
// Must match the user-content cap in MailBots.call (src/mailbox/bots.js).
const CALL_INPUT_CHARS = 40000;

function compactStore(sl) {
  if (!sl || !Array.isArray(sl.products)) return { products: [] };
  return {
    ...(sl.query ? { query: sl.query } : {}),
    ...(sl.note ? { note: sl.note } : {}),
    ...(sl.carries_asked_phone === false ? { carries_asked_phone: false } : {}),
    products: sl.products.map(p => ({
      title: p.title, url: p.url, price: p.price,
      ...(p.available != null ? { available: p.available } : {}),
      ...(p.has_color_options === false ? { has_color_options: false, single_variant_color: p.single_variant_color || 'Black' } : p.has_color_options != null ? { has_color_options: p.has_color_options } : {}),
      ...(p.requested_color ? { requested_color: p.requested_color } : {}),
      ...(p.color_note ? { color_note: p.color_note } : {}),
      colors: (p.options || []).flatMap(o => o.values || o.available || []),
      variants: (p.variants || []).map(v => ({ id: v.id, title: v.title, price: v.price, in_stock: v.in_stock, available: v.available }))
    }))
  };
}

// Lookups first, then the draft and knowledge, so a large KB dump cannot push
// the writer's store_lookup past the 40k cap (turquoise iPhone 17 Pro Max, r.86b605a8).
function checkerPayload({ original, draft, links_note, owner_approved_note, knowledge, extra = {} }) {
  const sl = extra.store_lookup || null;
  return {
    store_evidence: compactStore(sl),
    store_lookup: sl,
    ...(extra.sar_lookup ? { sar_lookup: extra.sar_lookup } : {}),
    ...(extra.order_lookup ? { order_lookup: extra.order_lookup } : {}),
    ...(extra.research_lookup ? { research_lookup: extra.research_lookup } : {}),
    ...(extra.symptom_research ? { symptom_research: extra.symptom_research } : {}),
    ...(extra.medical_disclaimer ? { medical_disclaimer: extra.medical_disclaimer } : {}),
    original, draft,
    ...(owner_approved_note ? { owner_approved_note } : {}),
    ...(links_note ? { links_note } : {}),
    knowledge: knowledge || [],
    ...(extra.web_research ? { web_research: extra.web_research } : {}),
    ...(extra.web_research_note ? { web_research_note: extra.web_research_note } : {}),
    ...(extra.web_answers ? { web_answers: extra.web_answers } : {}),
    ...(extra.hasDisclaimer ? { hasDisclaimer: true } : {}),
    ...(Array.isArray(extra.kb_gaps) ? { kb_gaps: extra.kb_gaps } : {}),
    ...(extra.sender ? { sender: extra.sender } : {}),
    ...(extra.footer ? { footer: extra.footer } : {})
  };
}

const HEALTH_TIP = /\b(?:headset|air-tube|air[- ]tube|speakerphone|bed(?:time)?|wi-?fi|bluetooth|router|tablets?|chargers?|pocket|belly|bag rather than|off your (?:belly|body)|exposure|distance|airplane mode|keep the phone off)\b/i;
const HEALTH_STUDY = /\b(?:stud(?:y|ies)|research|ntp|power[- ]lines?|laptop|ovar(?:y|ies|ian)|prenatal|in the womb|fetus|offspring|miscarriage|birth[- ]weight|childhood cancer|behavior problems)\b/i;

function relatedHealthAddition(item, { asked, knowledge, research_lookup, medical_disclaimer } = {}) {
  if (!P.isMedicalQuestion(asked)) return false;
  const t = String(item || '').trim();
  if (!t || (!HEALTH_TIP.test(t) && !HEALTH_STUDY.test(t))) return false;
  const corpus = [
    ...(knowledge || []).map(k => String((k && k.text) || '')),
    JSON.stringify(research_lookup || {}),
    medical_disclaimer && medical_disclaimer.text ? String(medical_disclaimer.text) : ''
  ].join('\n').toLowerCase();
  if (!corpus.trim()) return false;
  const words = t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(w => w.length > 4);
  if (!words.length) return true;
  const hits = words.filter(w => corpus.includes(w));
  return hits.length >= Math.min(2, Math.max(1, Math.ceil(words.length * 0.25)));
}

// Only hard-block and needs_john (money, legal, staff names, …) skip the revise
// loop. A missing disclaimer or a daily cap is not a reason to skip a revise.
function reviseBlocked(orig, draft, { settings, ownDomains, disclaimer, researched } = {}) {
  const gate = P.autoSendGate({ settings: { ...(settings || {}), auto_send: true, daily_cap: 9999 }, available: true, original: orig, draft, sentToday: 0, ownDomains: ownDomains || [], disclaimer: disclaimer || '', researched: !!researched });
  if (!gate.ok && (gate.reason === 'hard_block' || gate.reason === 'needs_john')) return gate;
  return null;
}

function normalizeEdits(grade) {
  const raw = (grade && Array.isArray(grade.edits)) ? grade.edits : [];
  const edits = raw.map(e => {
    if (!e || typeof e !== 'object') return null;
    const action = /^(add|cut|change)$/i.test(e.action) ? String(e.action).toLowerCase() : 'change';
    const text = String(e.text || e.add || e.cut || '').trim().slice(0, 500);
    if (!text) return null;
    return { action, text, ...(e.instead ? { instead: String(e.instead).slice(0, 500) } : {}), reason: String(e.reason || '').slice(0, 300), ...(e.fact ? { fact: String(e.fact).slice(0, 400) } : {}), ...(e.source ? { source: String(e.source).slice(0, 80) } : {}) };
  }).filter(Boolean);
  if (edits.length) return edits;
  return (Array.isArray(grade && grade.improvements) ? grade.improvements : []).map(s => { const text = String(s || '').trim().slice(0, 500); return text ? { action: 'add', text, reason: 'checker improvement' } : null; }).filter(Boolean);
}

function missingCritical(grade) { return !!(grade && grade.missing_critical === true); }

// An empty or failed store search is not evidence that a draft fact is invented
// (turquoise iPhone 17 Pro Max, r.86b605a8, 12:44 AM ET rerun).
function isEmptyLookupClaim(s) {
  return /returned no products|products (?:is|are|arrays are) empty|no matching product|empty (?:store )?(?:search|lookup|results)|store_lookup products is empty|store search returned no products|live store search returned no products/i.test(String(s || ''));
}
function canFillFromLookups(grade) {
  const edits = normalizeEdits(grade);
  const facts = [...edits, ...((grade && Array.isArray(grade.lookup_facts)) ? grade.lookup_facts : [])];
  return facts.some(e => {
    if (!e || !(e.fact || e.source)) return false;
    const blob = [e.fact, e.reason, e.text].filter(Boolean).join(' ');
    return !isEmptyLookupClaim(blob);
  });
}
// Cut (and other empty-lookup) edits are not applied when missing_critical is set, or when the
// only "fact" is that a search came back empty. The checker should fetch by URL instead.
function allowedEdits(grade) {
  let edits = normalizeEdits(grade);
  const blockCuts = missingCritical(grade);
  return edits.filter(e => {
    const blob = [e.fact, e.reason, e.text, e.instead].filter(Boolean).join(' ');
    if (isEmptyLookupClaim(blob)) return false;
    if (blockCuts && e.action === 'cut') return false;
    return true;
  });
}
function editSummary(edits) { return (edits || []).map(e => e.action + ': ' + e.text).join('; ').slice(0, 240); }

module.exports = { MAX_REVISE, CALL_INPUT_CHARS, compactStore, checkerPayload, relatedHealthAddition, reviseBlocked, normalizeEdits, missingCritical, canFillFromLookups, isEmptyLookupClaim, allowedEdits, editSummary };
