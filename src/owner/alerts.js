'use strict';
// Urgent-event detection. Conservative keyword rules over the caller's own words and taken messages.
const RULES = [
  ['safety', /\b(fire|smok(e|ing)|burn(ed|t|ing)?|explod(e|ed)|overheat(ed|ing)?|injur(y|ed)|hurt|hospital|911|emergency room|electric shock)\b/i],
  ['legal', /\b(lawyer|attorney|lawsuit|sue|suing|legal action|class action|small claims|attorney general|better business bureau|bbb|ftc complaint|subpoena)\b/i],
  ['angry', /\b(furious|outraged|scam(med)?|fraud|rip(ped)? ?off|chargeback|dispute (the|my) charge|unacceptable|ridiculous|worst company)\b/i],
];
const URGENT_MSG = /\b(urgent|asap|emergency|immediately|right away|time.sensitive)\b/i;

function classifyText(text) { const s = String(text || ''); for (const [kind, re] of RULES) if (re.test(s)) return kind; return null; }
function classifyCall(transcript) {
  const said = (transcript || []).filter((x) => x && x.role === 'caller').map((x) => x.text).join(' ');
  const kind = classifyText(said);
  // "angry" needs two hits so one frustrated word does not page the owners.
  if (kind === 'angry') { const hits = (said.match(new RegExp(RULES[2][1].source, 'gi')) || []).length; return hits >= 2 ? 'angry' : null; }
  return kind;
}
function classifyMessage(msg) { const k = classifyText(msg && msg.message); if (k) return k; return URGENT_MSG.test(String((msg && msg.message) || '')) ? 'urgent_callback' : null; }
const LABEL = { safety: 'a possible safety issue', legal: 'a possible legal threat', angry: 'an upset caller who is escalating', urgent_callback: 'a callback request marked urgent', system_errors: 'repeated system errors' };
module.exports = { classifyCall, classifyMessage, classifyText, LABEL };
