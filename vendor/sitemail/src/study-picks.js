'use strict';
// Brain box: how the Mailbox picks studies from the research directory for a medical email (src/research-dir.js search).
// John, Nov 15 2026, 11:28 PM ET: "search harm first in the filter. Cause a lot of those off-topic studies aren't
// really harm. In the classification." Harm-classified studies on the email's topic come first; other effect classes
// fill in only when there is no relevant harm study. The topic check stays: a study must match the email's topic words,
// not just "phone", "study" or "harm".
//
// Editable as one ordinary Brain box entry, slug `internal-study-picks` (the internal- prefix keeps it off the public /kb; src/kb.js keeps it out of answer passages) (Key: value lines; lists split by `;`):
//   Prefer effect: Harm
//   Then effects: Mixed; Unclear; Unknown; No effect; Benefit
//   Generic words: study; studies; phone; ...      words that never count as the topic
//   Relevance floor: 0.5                           a pick needs at least this share of the best topic score
// A missing entry or line uses the defaults below. The Mailbox reads it live at reply time (no deploy to change it).
const SLUG = 'internal-study-picks';
const EFFECTS = ['Harm', 'Mixed', 'Unclear', 'Unknown', 'No effect', 'Benefit'];
// Words that say nothing about the topic: conversation, the exposure itself, and research/classification words.
const GENERIC = ('study studies research researchers paper papers evidence proof proven science scientific found finding findings show shows showed '
  + 'phone phones cell cellphone cellphones mobile smartphone smartphones radiation radio waves wave frequency emf emfs wireless device devices '
  + 'harm harmful harms effect effects safe safety unsafe risk risks limit limits dangerous danger cause causes caused link linked '
  + 'question questions honest say says said tell know think believe really actually anyone people person someone thanks thank hello '
  + 'there their were did does doesn isn aren wasn don dont should would could might must need want keep keeps seeing true whether '
  + 'between both any each every most more less big small strongest best worst last years year day days hours two three '
  + 'groups group part paid paying funded set over right look anything besides still bother mostly held whole news stories sending followed hundreds thousands '
  + 'brother sister wife husband friend mom dad').split(/\s+/);
const DEFAULTS = Object.freeze({ prefer: ['Harm'], then: EFFECTS.filter((e) => e !== 'Harm'), generic: GENERIC, floor: 0.5 });

const list = (v) => String(v || '').split(/[;\n]/).map((x) => x.trim()).filter(Boolean);
const canonEffect = (s) => EFFECTS.find((e) => e.toLowerCase() === String(s || '').trim().toLowerCase()) || null;
// Parse an entry's text. Unknown effect names are ignored; a line that parses to nothing keeps the default.
function parse(text) {
  const out = { prefer: DEFAULTS.prefer.slice(), then: DEFAULTS.then.slice(), generic: DEFAULTS.generic.slice(), floor: DEFAULTS.floor };
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*([A-Za-z ]+?)\s*:\s*(.*)$/); if (!m) continue;
    const k = m[1].toLowerCase(); const v = m[2];
    if (k === 'prefer effect' || k === 'prefer effects') { const e = list(v).map(canonEffect).filter(Boolean); if (e.length) out.prefer = [...new Set(e)]; }
    else if (k === 'then effect' || k === 'then effects') { const e = list(v).map(canonEffect).filter(Boolean); if (e.length) out.then = [...new Set(e)]; }
    else if (k === 'generic words') { const w = list(v).map((x) => x.toLowerCase()); if (w.length) out.generic = [...new Set(w)]; }
    else if (k === 'relevance floor') { const f = Number(v); if (Number.isFinite(f) && f >= 0 && f <= 1) out.floor = f; }
  }
  out.then = out.then.filter((e) => !out.prefer.includes(e));
  return out;
}
// The live rule from the Brain box (tools.entryBySlug), or the defaults.
function fromKb(tools) {
  try { const e = tools && typeof tools.entryBySlug === 'function' ? tools.entryBySlug(SLUG) : null; return e && e.text ? { ...parse(e.text), source: 'brain_box' } : { ...parse(''), source: 'default' }; } catch { return { ...parse(''), source: 'default' }; }
}
function toText(r = DEFAULTS) {
  return ['Prefer effect: ' + r.prefer.join('; '), 'Then effects: ' + r.then.join('; '), 'Generic words: ' + r.generic.join('; '), 'Relevance floor: ' + r.floor].join('\n');
}
module.exports = { SLUG, EFFECTS, DEFAULTS, parse, fromKb, toText };
