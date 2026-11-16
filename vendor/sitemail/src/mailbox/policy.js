'use strict';
// Rules for sorting and auto-send. Everything here is deterministic except the optional AI grade, which can only
// hold a draft back or let one that already passed every hard rule go out.

// Sales / promotional mail: sorted to Spam first, never drafted or auto-sent.
const PROMO = [/\bunsubscribe\b/i, /\b\d{1,2}\s?% off\b/i, /\blimited[- ]time\b/i, /\bspecial offer\b/i, /\bexclusive (?:offer|deal|discount)\b/i, /\b(?:seo|backlinks?|link building|guest post)\b/i,
  /\b(?:partnership|sponsorship|collaboration) (?:opportunity|proposal)\b/i, /\bwebinar\b/i, /\bpromo(?:tion|tional)?(?: code)?\b/i, /\bdiscount\b/i, /\bbuy now\b/i, /\bfree trial\b/i,
  /\b(?:grow|boost|scale) your (?:business|sales|traffic|revenue)\b/i, /\bbook a (?:call|demo|meeting)\b/i, /\b(?:lead generation|marketing services|cold email)\b/i, /\bnewsletter\b/i, /\bflash sale\b/i, /\bact now\b/i, /\bwe (?:can|could) help you\b/i];
function promoScore(m) { const s = [m.subject, m.text, m.from].join('\n').slice(0, 20000); return PROMO.reduce((n, r) => n + (r.test(s) ? 1 : 0), 0); }
const isPromo = (m) => promoScore(m) >= 2;

// Topics that always wait for John.
const ESCALATE = {
  // Refund requests no longer wait for John (Nov 14, 9:28 PM ET): the reply gives the KB return instructions only. A card
  // chargeback (a payment dispute) still waits for him.
  chargeback: /\bchargebacks?\b|\bdisput(?:e|es|ed|ing)\b[^.\n]{0,40}\b(?:charges?|payments?|transactions?|with (?:my|the) (?:bank|card))\b|\b(?:file|filing|open|opening) a (?:dispute|claim) with (?:my|the) (?:bank|card)/i,
  // John, Nov 14 9:43 PM ET: a refund how-to question gets the KB refund policy; only a request that WE send or transfer
  // money directly ("send me my money", "refund my card now", "wire it back") waits for him.
  money_request: /\b(?:send|wire|transfer|give|pay|venmo|zelle|paypal)\s+(?:it\s+)?(?:me|us)\s+(?:back\s+)?(?:my|the|our)?\s*(?:money|funds|cash|refund)\b|\b(?:send|wire|transfer)\s+(?:my|the)\s+(?:money|funds|refund)\b|\brefund\s+(?:my|the)\s+(?:card|account|payment|money)\s+(?:now|today|immediately|right away|asap)\b|\bwire\s+(?:it|the money|my money)\s+back\b|\b(?:send|transfer|wire)\s+(?:it\s+)?back\s+to\s+my\s+(?:card|account|bank|paypal)\b/i,
  // Only REFUND requests hold for money (John, Nov 14 8:25 PM ET: the hold "really only needs to stop it when [the customer]
  // is actually asking for a refund"). Payments, charges, discounts, prices and quotes are answered normally; a discount
  // question gets the owner-approved KB answer, and the reply must never offer a discount (checker fails it).
  legal: /\b(?:lawyers?|attorneys?|legal|lawsuit|sue|suing|court|subpoena|cease and desist|liability|gdpr|ccpa|copyright|trademark|dmca|contract)\b/i,
  complaint: /\b(?:complain\w*|complaint|unhappy|disappointed|angry|terrible|awful|worst|unacceptable|scam|fraud|ripped off|never (?:arrived|received)|broken|defective|furious)\b/i,
};
// Jarvis triage bug 6 (John's 7:30 PM ET words): on the DRAFT reply, "legal" holds only for a real legal matter between
// RF Safe / Quanta X and the customer: a lawsuit or legal action against us, a legal threat, a subpoena, a lawyer's demand,
// cease and desist, or legal advice. Citing a public court ruling from the Brain box (r.4007ff93: "a federal court",
// "U.S. Court of Appeals ... (Environmental Health Trust v. FCC)") is not one. The customer's own email still uses
// ESCALATE.legal above, unchanged.
const US = '(?:us|we|rf ?safe|quanta ?x(?: technology)?(?: llc)?|our (?:company|business|store))';
const DRAFT_LEGAL = new RegExp([
  '\\b(?:lawsuit|legal action|legal claim|claim|case|complaint|suit)s?\\s+(?:against|with)\\s+' + US + '\\b',
  '\\b(?:sue|suing|sued|take)\\s+' + US + '\\b(?:\\s+to court)?',
  '\\b(?:you|your)\\s+(?:can|could|may|might|should|would|will)\\s+(?:sue|take legal action|file (?:a )?(?:lawsuit|claim))\\b',
  '\\bsubpoena\\w*\\b', '\\bcease[- ]and[- ]desist\\b', '\\blegal (?:advice|threat|demand|notice|counsel|team|department|representation)\\b',
  '\\b(?:our|my|your|a|an|the customer\'s)\\s+(?:lawyer|attorney|counsel)s?\\b', '\\b(?:lawyer|attorney)s?\\s+(?:letter|demand|for (?:you|us|rf ?safe))\\b',
  '\\b(?:we|rf ?safe|quanta ?x)\\s+(?:are|is|will be|would be|accept|accepts|take|takes)\\s+(?:not\\s+)?(?:liable|legally responsible|liability)\\b',
  '\\b(?:settlement|settle (?:the|this|your) (?:claim|case|dispute)|indemnif\\w*|small[- ]claims)\\b',
  '\\b(?:gdpr|ccpa|dmca|copyright|trademark)\\b', '\\b(?:breach of |our |your |the )contract\\b',
].join('|'), 'i');
// Jarvis triage bug 8 (John, 7:30 PM ET "keep modifying it until we can get all these fine-tuned and working" and 9:50 PM ET
// "We need good quality replies that flow"): r.ec6d7ce9 passed the checker at 10:02 PM ET and was held for "worst" in the
// draft ("poorer hearing ... worst at high frequencies"). The complaint hold is decided by the CUSTOMER's email (ESCALATE.complaint,
// unchanged). On the DRAFT only full complaint phrases about us count (an apology for a bad experience, "your complaint", a
// broken or missing order, a refund for a bad experience, a report or review threat); single words like worst, bad, terrible,
// awful, broken or defective never do.
const DRAFT_COMPLAINT = new RegExp([
  "\\b(?:sorry|apologi[sz]e)\\b[^.\\n]{0,40}\\b(?:poor|bad|terrible|awful|frustrating|disappointing|negative|unpleasant) (?:experience|service|support)\\b",
  "\\b(?:sorry|apologi[sz]e)\\b[^.\\n]{0,30}\\b(?:inconvenience|frustration|trouble|delay)\\b",
  "\\bsorry (?:that )?(?:you(?:'re| are| were| feel)|to hear you(?:'re| are)) (?:unhappy|disappointed|upset|frustrated|angry|dissatisfied)\\b",
  "\\byour (?:complaint|grievance|negative review|bad review)\\b",
  "\\b(?:file|filed|filing|submit|lodge) (?:a |your )?complaint\\b",
  "\\byour (?:order|case|package|item|parcel|shipment|product)\\b[^.\\n]{0,30}\\b(?:arrived|was|is|came)\\b[^.\\n]{0,15}\\b(?:broken|damaged|defective|cracked|missing|faulty)\\b",
  "\\byour (?:order|case|package|item|parcel|shipment)\\b[^.\\n]{0,30}\\b(?:never|hasn't|has not|did not|didn't) (?:arrive|arrived|come|been delivered|been received)\\b",
  "\\b(?:report|reporting) (?:us|rf ?safe|quanta ?x) to\\b", "\\b(?:better business bureau|bbb)\\b",
  "\\b(?:rf ?safe|we|quanta ?x)(?:'re| is| are)(?: not)? (?:a )?(?:scam|fraud)\\b",
].join('|'), 'i');
const ESCALATE_DRAFT = { ...ESCALATE, legal: DRAFT_LEGAL, complaint: DRAFT_COMPLAINT };
// John, Nov 15, 3:55 PM ET: "if it is medical, it's not that it gets held up because it's medical. You just put the
// proper disclaimer that should be in the database." A medical or personal-health email (pregnancy, personal symptoms,
// conditions, diseases) is NOT an owner-only topic any more: it goes through the normal writer, checker and auto-send path,
// and the reply must OPEN with the owner-approved KB entry 'medical-questions-disclaimer' (read live from the KB store).
// If that entry is missing or empty, the email is held instead (never sent without the disclaimer).
// Every other hold (chargeback, money request, legal, complaint, staff names, hard block, daily cap) is unchanged.
// Classification runs on the CUSTOMER's email only; a draft that quotes the disclaimer does not make an email medical.
const MEDICAL_TERMS = /\b(?:doctors?|physicians?|pediatrician|obgyn|ob-gyn|midwife|medical|medicine|diagnos\w*|symptoms?|cancers?|tumou?rs?|glioma|glioblastoma|meningioma|acoustic neuroma|schwannoma|leuka?emia|pregnan\w*|unborn|fetus|foetus|fetal|miscarr\w*|fertility|infertil\w*|sperm|breast[- ]?feed\w*|health (?:condition|problem|issue|concern)s?|my health|illness|diseases?|disorders?|syndrome|headaches?|migraines?|insomnia|tinnitus|ringing in (?:my|the|his|her) ears?|dizz\w*|vertigo|nause\w*|fatigue|palpitations?|heart (?:condition|problem|issue)s?|seizures?|epilep\w*|autis\w*|adhd|anxiety|depression|numbness|tingling|rash(?:es)?|electro-?(?:magnetic )?hyper-?sensitiv\w*|\behs\b|pacemakers?|implants?|hospital\w*|treatments?|prescriptions?|medications?|medicines?)\b/i;
// Personal symptoms in plain words ("I get burning ears", "my son feels sick", "my head hurts after calls").
const PERSONAL_SYMPTOM = /\b(?:i|my (?:son|daughter|child|kids?|baby|wife|husband|partner|mom|mother|dad|father|family))\s+(?:(?:have|has|had|get|gets|got|am getting|is getting|feel|feels|felt|am feeling|is feeling|suffer|suffers|suffered|am suffering|experience|experiences|experienced|was diagnosed|were diagnosed)\s+)(?:(?:a|an|some|really|very|so|bad|severe|constant|frequent|chronic|these|this|burning|sharp)\s+)*(?:sick|unwell|ill|pain|aches?|burning|hot|warm|tired|exhausted|weak|nausea|dizzy|headaches?|migraines?|sleep\w*|trouble sleeping)\b|\bmy (?:head|ear|ears|chest|eyes?|skin|heart|hand|arm|leg|body)\s+(?:hurts?|aches?|burns?|tingles?|is (?:hot|burning|tingling|sore|warm))\b|\b(?:can'?t|cannot|trouble|problems?) sleep\w*\b/i;
function isMedicalQuestion(text) { const s = String(text || '').slice(0, 40000); return MEDICAL_TERMS.test(s) || PERSONAL_SYMPTOM.test(s); }
function medicalMatch(text) { const s = String(text || '').slice(0, 40000); const m = s.match(MEDICAL_TERMS) || s.match(PERSONAL_SYMPTOM); return m ? m[0].slice(0, 40) : null; }
// Kept for callers and tests from the Nov 15, 1:03 PM ET rule. It no longer skips anything: a pregnancy question is a
// personal-health question and gets the disclaimer (the 3:33 PM ET pregnancy + Pixel 8 reply went out without one).
const PREGNANCY = /\bpregnan(?:t|cy|cies)?\b/i;
const EMF_EXPOSURE = /\b(?:emfs?|rfr?\b|radio[- ]?frequenc\w*|wireless|wi-?fi|wifi|routers?|bluetooth|cell(?:ular)?(?:[ -]?phones?)?|smartphones?|phones?|pixels?(?:\s*\d)?|iphones?|android|truthcase|quantacase|phone[ -]?cases?|sars?\b|distance|exposure)\b/i;
function isPregnancyEmfQuestion(text) { const s = String(text || ''); return PREGNANCY.test(s) && EMF_EXPOSURE.test(s); }

// The disclaimer text of the KB entry (its first "# Title" line removed), or '' when the entry is missing or empty.
const DISCLAIMER_SLUG = 'medical-questions-disclaimer';
// KB API entries are indexed with an "Owner-approved answer (source: ...):" line in front (src/kbapi.js toMarkdown); that
// line is index metadata, not part of the disclaimer, and must never appear in a customer reply.
// A KB entry's "Related: <other questions>" line is navigation for the site, never customer text (Jarvis triage bug 5:
// the 9:21 PM ET r.e68a51d3 reply carried the disclaimer entry's Related line). Only whole lines that START with
// "Related:" (any case, leading spaces allowed) are removed; "related" inside a sentence is untouched.
const RELATED_LINE = /^[ \t]*related:.*(?:\r?\n|$)/gim;
function hasRelatedLine(text) { return /^[ \t]*related:/im.test(String(text || '')); }
function stripRelated(text) { const s = String(text || ''); if (!hasRelatedLine(s)) return s; return s.replace(RELATED_LINE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); }
function disclaimerFromEntry(e) { return e ? stripRelated(String(e.text || '').replace(/^\s*#\s+[^\n]+\n+/, '').replace(/^\s*Owner-approved answer \(source:[^)\n]*\):\s*/i, '').trim()) : ''; }
// Compare words only: quotes, markdown marks and whitespace do not matter.
const normWords = (t) => String(t || '').replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[*_`>#]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const GREETING = /^\s*(?:hi|hello|hey|dear|greetings|good (?:morning|afternoon|evening))\b[^\n,!]{0,60}[,!]?[ \t]*\n?/i;
function splitGreeting(body) { const b = String(body || '').replace(/^\s+/, ''); const g = b.match(GREETING); return g ? { greeting: g[0].trim(), rest: b.slice(g[0].length).replace(/^\s+/, '') } : { greeting: '', rest: b }; }
// True when the reply opens (after an optional "Hi Name," greeting) with the disclaimer text, word for word.
function disclaimerFirst(body, disclaimer) { const d = normWords(disclaimer); if (!d) return false; return normWords(splitGreeting(body).rest).startsWith(d); }
// Puts the disclaimer first (right after the greeting) when the writer did not; a verbatim copy elsewhere is moved, not duplicated.
function ensureDisclaimerFirst(body, disclaimer) {
  const d = String(disclaimer || '').trim(); if (!d) return String(body || '');
  const { greeting, rest } = splitGreeting(body);
  let r = rest;
  if (disclaimerFirst(body, d)) { const n = normWords(d); let i = 0; const words = rest.split(/(\s+)/); let acc = ''; for (; i < words.length && normWords(acc).length < n.length; i++) acc += words[i]; r = words.slice(i).join(''); }
  else { const esc = d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'); try { r = rest.replace(new RegExp(esc, 'i'), ' '); } catch {} }
  // A partial or reworded copy of the disclaimer later in the reply (Nov 15 symptom samples: the writer pasted its first
  // paragraphs again) is dropped paragraph by paragraph, so the disclaimer appears once, at the top.
  const dp = new Set(d.split(/\n\s*\n/).map(normWords).filter(x => x.length > 20));
  const parts = r.split(/\n\s*\n/); const kept = parts.filter(x => !dp.has(normWords(x)));
  if (kept.length === parts.length && disclaimerFirst(body, d)) return String(body || ''); // already first, no repeat: unchanged
  r = kept.join('\n\n');
  r = r.replace(/[ \t]{2,}/g, ' ').replace(/\n[ \t]+(?=\n)/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return (greeting ? greeting + '\n\n' : '') + d + (r ? '\n\n' + r : '');
}
// John, Nov 15, 9:38 PM ET: "the medical disclaimer should still be at the bottom, not the first thing that they lead
// into. The first thing that they lead into should be about the question." Medical replies go: greeting, the direct
// answer, study links, exposure tips, then the disclaimer as its own block right before the sign-off, exactly once.
// (Replaces disclaimer-first from #38, #53, #58.)
const SIGNOFF_FIRST = /^\s*(?:(?:many |big )?thanks(?: again| so much)?|thank you(?: again)?|best(?: regards| wishes)?|kind regards|warm regards|warmly|regards|sincerely|cheers|all the best|take care|talk soon|with care)\b[^\n]{0,30}$|^\s*(?:-{1,2}|\u2014)\s*\S[^\n]{0,40}$|^\s*(?:the\s+)?(?:rf\s*safe|quanta\s*x(?:\s+technology)?)(?:\s+(?:team|support|customer support))?\.?\s*$/i;
const SIGNOFF_NAME = /^\s*[A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,3}(?:,?\s+(?:RF Safe|Quanta X(?: Technology)?)(?: team)?)?\.?\s*$/;
function isSignoffPara(p) { const ls = String(p || '').trim().split('\n').filter(l => l.trim()); return ls.length > 0 && ls.length <= 3 && SIGNOFF_FIRST.test(ls[0]) && ls.slice(1).every(l => SIGNOFF_FIRST.test(l) || SIGNOFF_NAME.test(l)); }
// Splits a reply body (no greeting) into the main text and a trailing sign-off ("Thanks,\nThe RF Safe team").
function splitSignoff(text) {
  const paras = String(text || '').replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/); let k = paras.length;
  while (k > 1 && paras.length - k < 2 && isSignoffPara(paras[k - 1])) k--;
  return { main: paras.slice(0, k).join('\n\n').trim(), signoff: paras.slice(k).join('\n\n').trim() };
}
function countDisclaimer(body, disclaimer) { const n = normWords(disclaimer); if (!n) return 0; return normWords(body).split(n).length - 1; }
// True when the disclaimer appears exactly once, as the last block before the sign-off, after some answer text.
function disclaimerLast(body, disclaimer) {
  const n = normWords(disclaimer); if (!n) return false;
  if (countDisclaimer(body, disclaimer) !== 1) return false;
  const main = normWords(splitSignoff(splitGreeting(body).rest).main);
  return main.endsWith(n) && main.length > n.length + 20;
}
// Moves (or inserts) the disclaimer to just before the sign-off, with exactly one copy; verbatim copies and paragraph copies
// elsewhere are removed. A top-placed disclaimer is moved, never a reason to hold.
function ensureDisclaimerLast(body, disclaimer) {
  const d = String(disclaimer || '').trim(); if (!d) return String(body || '');
  if (disclaimerLast(body, d)) return String(body || '');
  const { greeting, rest } = splitGreeting(body);
  let r = rest; const esc = d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  try { r = r.replace(new RegExp(esc, 'gi'), '\n\n'); } catch {}
  const dp = new Set(d.split(/\n\s*\n/).map(normWords).filter(x => x.length > 20));
  r = r.split(/\n\s*\n/).filter(x => !dp.has(normWords(x))).join('\n\n');
  r = r.replace(/[ \t]{2,}/g, ' ').replace(/\n[ \t]+(?=\n)/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const { main, signoff } = splitSignoff(r);
  return (greeting ? greeting + '\n\n' : '') + (main ? main + '\n\n' : '') + d + (signoff ? '\n\n' + signoff : '');
}
// Writer layout (Jarvis triage bug 1, John's 7:30 + 7:50 PM ET words): the 8:07 PM FDA reply went out as one 1,268-char
// paragraph. Deterministic, whitespace-only: the greeting and a medical disclaimer each stand as their own block; a long
// prose line (over 400 chars) is split at sentence ends into short paragraphs of at most 2 sentences, with a blank line
// between them. Lists, links, citations, numbers, the disclaimer and owner-approved word-for-word answers are never split.
const ABBR = /(?:\b(?:U\.S|U\.K|e\.g|i\.e|etc|vs|Dr|Mr|Mrs|Ms|Prof|No|Nos|Inc|Ltd|Co|Corp|St|Jr|Sr|Fig|Vol|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|al|approx|cf)|\b[A-Z])\.$/;
function splitSentences(line) {
  const out = []; let start = 0; const re = /[.!?]["”')\]]?\s+(?=["“(]?[A-Z0-9])/g; let m;
  while ((m = re.exec(line))) { const end = m.index + m[0].trimEnd().length; const head = line.slice(start, end); if (ABBR.test(head.replace(/["”')\]]$/, ''))) continue; out.push(head.trim()); start = m.index + m[0].length; }
  out.push(line.slice(start).trim()); return out.filter(Boolean);
}
function formatParagraphs(body, disclaimer, { keep = [] } = {}) {
  const ws = (x) => String(x || '').replace(/\s+/g, ' ').replace(/[’]/g, "'").trim(); const keepN = keep.map(ws).filter(x => x.length > 20);
  let b = String(body || '').replace(/\r\n?/g, '\n'); const d = String(disclaimer || '').trim(); const KEEP = '\u0000DISCLAIMER\u0000';
  const hasD = d && b.includes(d); if (hasD) b = b.replace(d, '\n\n' + KEEP + '\n\n');
  b = b.replace(/^(\s*(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))\b[^\n]{0,80}[,!:])[ \t]*\n(?=[ \t]*\S)/i, '$1\n\n');
  const paras = b.split(/\n\s*\n/).map(p => p.replace(/^\n+|\n+$/g, '')).filter(p => p.trim());
  const out = [];
  for (const p of paras) {
    if (p.includes(KEEP)) { out.push(p); continue; }
    const lines = p.split('\n'); const blocks = []; let cur = [];
    for (const line of lines) {
      const isList = /^\s*(?:[-•*]|\d+[.)])\s+/.test(line);
      // An owner-approved answer quoted word for word keeps its own layout (never split mid-answer).
      if (isList || line.length <= 400 || keepN.some(k => ws(line).includes(k))) { cur.push(line); continue; }
      if (cur.length) { blocks.push(cur.join('\n')); cur = []; }
      const ss = splitSentences(line); let g = [];
      for (const x of ss) { g.push(x); if (g.length >= 2 || g.join(' ').length >= 320) { blocks.push(g.join(' ')); g = []; } }
      if (g.length) { if (g.join(' ').length < 60 && blocks.length) blocks[blocks.length - 1] += ' ' + g.join(' '); else blocks.push(g.join(' ')); }
    }
    if (cur.length) blocks.push(cur.join('\n'));
    out.push(...blocks);
  }
  let r = out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  if (hasD) r = r.replace(KEEP, d);
  return r;
}
// Staff-name rule (John, Nov 15, 7:04 PM ET: "I think for some reason it blocked it because you had my name in the
// email"). A customer's own name, signature or sign-off ("Thanks, John", "- John Smith", "I'm Katie") never holds an
// email. Only questions about John Coates or Katie Webb personally, or requests to reach or contact them, wait for
// John: the full name, a staff surname, or a staff first name in a contact or about-them phrase ("can I talk to John?",
// "who is Katie?", "John's email"). A greeting ("Hi John,") or a passing "thanks John" is not a request.
// John Coates and Katie Webb are always staff; Mailbox settings staff_names can add more names.
const STAFF_PEOPLE = [['John', 'Coates'], ['Katie', 'Webb']];
const reEsc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SIGNOFF = /^(?:thanks|thank you|thanks again|many thanks|thx|cheers|regards|best|best wishes|best regards|kind regards|warm regards|warmly|all the best|sincerely|yours|yours truly|respectfully|take care|talk soon|love|blessings|god bless)\b[\s\S]{0,40}$/i;
const NAME_LINE = /^[-–—~]*\s*(?:[A-Z][A-Za-z'’.-]{0,20})(?:\s+[A-Z][A-Za-z'’.-]{0,20}){0,2}\s*$/;
// The text without a quoted earlier message, a "-- " signature, and the closing sign-off and name lines. names: the
// sign-off names that were removed (the sender's own name).
function stripSignature(text) {
  let lines = String(text || '').replace(/\r/g, '').split('\n'); const names = [];
  const q = lines.findIndex((l) => /^\s*(?:>|on .+ wrote:|-{2,}\s*original)/i.test(l)); if (q >= 0) lines = lines.slice(0, q);
  const sig = lines.findIndex((l) => /^\s*--\s*$/.test(l)); if (sig >= 0) { names.push(...lines.slice(sig + 1, sig + 3).join(' ').split(/\s+/)); lines = lines.slice(0, sig); }
  const idx = lines.map((l, i) => [l.trim(), i]).filter(([l]) => l).slice(-5);
  let cut = -1;
  for (let k = idx.length - 1; k >= 0; k--) { const [l, i] = idx[k]; if (SIGNOFF.test(l) && !/[?]/.test(l)) { cut = i; break; } }
  if (cut >= 0) { names.push(...lines.slice(cut).join(' ').split(/[\s,!.]+/)); lines = lines.slice(0, cut); }
  else { const last = idx[idx.length - 1]; if (last && idx.length > 1 && NAME_LINE.test(last[0])) { names.push(...last[0].split(/[\s-–—~]+/)); lines = lines.slice(0, last[1]); } }
  return { text: lines.join('\n'), names: names.map((x) => x.replace(/[^A-Za-z'’-]/g, '')).filter((x) => /^[A-Z]/.test(x) && x.length >= 2) };
}
// The sender's own names: the From header display name and its address local part ("John Smith" <john.smith@x>).
function fromNames(from) {
  const f = String(from || ''); const out = [];
  const disp = f.match(/^\s*"?([^"<]+?)"?\s*</); if (disp) out.push(...disp[1].split(/[\s,]+/));
  const local = (f.match(/<?([^<>@\s]+)@/) || [])[1]; if (local) out.push(...local.split(/[._+-]+/).filter((x) => /^[A-Za-z]{2,}$/.test(x)));
  return out.map((x) => x.trim()).filter(Boolean);
}
const SELF_INTRO = /\b(?:i am|i'm|im|my name is|my name's|this is|it's|it is|signed)\s+([A-Z][a-z'’-]+)(?:\s+([A-Z][a-z'’-]+))?/g;
const CONTACT_BEFORE = "(?:talk(?:ing)?|speak(?:ing)?|chat(?:ting)?|meet(?:ing)?|connect(?:ed)?(?: me)?|get(?:ting)? (?:in touch|ahold|a hold)|reach(?:ing)?|contact(?:ing)?|call(?:ing)?|phon(?:e|ing)|e-?mail(?:ing)?|messag(?:e|ing)|text(?:ing)?|ask(?:ing)?|forward(?:ing)?(?: (?:this|it|my \\w+))?|pass(?:ing)?(?: (?:this|it|my \\w+))?(?: on| along)?|put me (?:through|in touch)|hear(?:ing)?(?: back)?|(?:a )?word|interview(?:ing)?|repl(?:y|ies)|respon(?:se|d)|answer|question|message|note|letter|appointment|meeting)\\s+(?:to|with|from|for|of|at)?\\s*(?:(?:mr|ms|mrs|dr)\\.?\\s+)?";
// One text (customer email, subject or draft): which staff names it raises as a staff topic, and the phrase.
function staffMatches(text, staffNames = [], opts = {}) {
  if (!(staffNames || []).filter(Boolean).length) return []; // the owner emptied the staff-name list: no staff check (as before)
  const st = stripSignature(text); let s = st.text.slice(0, 40000);
  s = s.replace(/^\s*(?:hi|hello|hey|dear|greetings|good (?:morning|afternoon|evening))\b[^\n]{0,60}\n/i, '\n'); // greeting line
  const self = new Set([...st.names, ...fromNames(opts.from), ...(opts.senderNames || [])].map((x) => x.toLowerCase()));
  s = s.replace(SELF_INTRO, (m, a, b) => { self.add(a.toLowerCase()); if (b) self.add(b.toLowerCase()); return ' '; });
  const firsts = new Set(STAFF_PEOPLE.map(([f]) => f.toLowerCase()));
  const tokens = [...new Set([...STAFF_PEOPLE.flat(), ...(staffNames || [])].map((n) => String(n).trim()).filter((n) => n.length >= 3))];
  const out = [];
  for (const [f, l] of STAFF_PEOPLE) { const m = s.match(new RegExp('\\b' + f + '\\s+' + l + '\\b', 'i')); if (m) out.push(m[0]); }
  for (const n of tokens) {
    if (/\s/.test(n)) { const m = s.match(new RegExp('\\b' + reEsc(n).replace(/\s+/g, '\\s+') + '\\b', 'i')); if (m) out.push(m[0]); continue; }
    const N = reEsc(n);
    // A staff surname (or an added name) holds on its own, unless it is the sender's own name.
    if (!firsts.has(n.toLowerCase()) && !self.has(n.toLowerCase())) { const m = s.match(new RegExp('\\b' + N + '\\b', 'i')); if (m) out.push(m[0]); continue; }
    // A first name (or the sender's own name) holds only when the email asks about that person or to reach them.
    const ctx = [new RegExp('\\b' + CONTACT_BEFORE + N + '\\b', 'i'),
      new RegExp('\\b(?:who|what|where) (?:is|was|are)\\s+' + N + '\\b|\\b(?:who|what|where)\'s\\s+' + N + '\\b|\\babout\\s+' + N + '\\b|\\b(?:is|was|does|did|has|can|could|would|will)\\s+' + N + '\\s+(?!and\\b)\\w+', 'i'),
      new RegExp('\\b' + N + '(?:\'s|’s)\\s+(?:e-?mail|phone|number|contact|address|cell|background|credentials?|qualifications?|bio|story|age|family|health|personal|own|degree|training|expertise|opinion|view|views|company)\\b', 'i'),
      new RegExp('\\b' + N + '\\s+(?:himself|herself|personally|directly)\\b|\\b(?:mr|ms|mrs|dr)\\.?\\s+' + N + '\\b', 'i')];
    for (const r of ctx) { const m = s.match(r); if (m) { out.push(m[0].slice(0, 60)); break; } }
  }
  return [...new Set(out)];
}
function escalations(texts, staffNames = [], opts = {}) {
  const s = texts.filter(Boolean).join('\n').slice(0, 40000); const out = [];
  for (const [k, r] of Object.entries(opts.rules || ESCALATE)) if (r.test(s)) out.push(k);
  if (texts.filter(Boolean).some((t) => staffMatches(t, staffNames, opts).length)) out.push('names_staff');
  return out;
}

// Same rules as escalations(), but says exactly what matched and where, so a hold reason is accurate and specific.
// texts: [{ where: 'customer email' | 'draft reply', text }]
function escalationMatches(texts, staffNames = [], opts = {}) {
  const out = [];
  for (const { where, text } of texts) {
    const s = String(text || '').slice(0, 40000); if (!s) continue;
    for (const [k, r] of Object.entries(where === 'draft reply' ? ESCALATE_DRAFT : ESCALATE)) {
      const m = s.match(r); if (m) out.push({ topic: k, phrase: m[0].slice(0, 40), where });
    }
    for (const ph of staffMatches(s, staffNames, opts)) out.push({ topic: 'names_staff', phrase: ph, where });
  }
  return out;
}
// Hard block: a reply may never agree to buy, sign up, subscribe, opt in, pay, sign anything, or commit/promise.
// Deliberately broad: any mention fails the draft and leaves it for John.
const HARD = [
  // Narrowed (John, Nov 14 8:46 PM ET): only US offering to buy. "You buy the case for your phone" and "before purchasing" are fine.
  ['buy', /\b(?:we|i)(?:'ll|'d| will| would| shall| can| could| are going to| am going to)? (?:buy|purchase|order)\b|\bwe(?:'ll| will) place (?:an|the) order\b|\badd (?:us|me) to\b/i],
  ['sign_up', /\bsign(?:ing|ed)?[- ]?(?:up|on)\b|\bsignup\b|\bregister (?:us|me)\b|\benrol+(?:ing)? (?:us|me)\b/i],
  // Narrowed (bug 8 audit): research wording ("mobile phone subscribers", "subscription records" in COSMOS and the Danish
  // cohort) never blocks; a reply that subscribes the customer or pushes a subscription still does.
  ['subscribe', /\b(?:we|i)(?:'ll|'ve|'d| will| would| can| could| have| are going to| am going to)?(?: (?:go ahead and|now|already))? (?:subscribe|subscribed|re-?subscribe)(?: you| your)?\b|\bsubscribe (?:you|us|me|now|here|today|below)\b|\byou(?:'re| are| have been| will be| were)(?: now| already)? (?:subscribed|re-?subscribed)\b|\b(?:your|our|the|a|this) (?:new |monthly |annual |paid |premium )?subscription\b(?! (?:records?|data|registr\w*|database))|\bsubscri\w* (?:plan|fee|price|link|button|page)\b/i],
  ['opt_in', /\bopt(?:ing|ed)?[- ]?in\b/i],
  // Narrowed (Jarvis triage bug 2, Nov 15 8:11 PM ET COSMOS reply; John 7:30 + 7:50 PM ET, and his Nov 14 money-hold
  // narrowing): only a real payment or billing action between us and the customer blocks. Talk about who paid for or
  // funded research ("Industry money helped pay for the work", "funded by the industry", "who paid for") does not.
  // Blocks: us paying or sending money; asking for card, bank or payment details; a refund, charge, credit, discount or
  // bill promised to the customer; payment links, invoices and "pay now". Negated clauses ("we can't refund") do not block.
  ['pay', new RegExp([
    // we pay / send money
    "\\b(?:we|i)(?:'ll|'d| will| would| shall| can| could| are going to| am going to)? (?:pay(?! (?:close |careful |special |more |less )?attention)|send|wire|transfer|venmo|zelle)(?: (?:you|it|for|the|your|that|this))?\\b",
    "\\bsend (?:you )?(?:the )?(?:money|funds|payment)\\b", "\\bwire (?:the )?(?:money|funds)\\b", "\\binvoice us\\b", "\\bpay (?:the|this|that|your|our) (?:invoice|bill|balance|fee)\\b",
    // asking for payment details
    "\\b(?:card number|credit card(?: number| details| info(?:rmation)?)?|debit card|cvv|cvc|security code on|expir(?:y|ation) date|billing (?:details|info(?:rmation)?|address)|payment (?:details|info(?:rmation)?|method)|bank (?:details|account|info(?:rmation)?)|routing number|account number)\\b",
    // refund / charge / credit / discount / bill promised to the customer
    "\\b(?:we|i)(?:'ll|'ve|'d| will| would| can| could| have| are going to| am going to)?(?: (?:go ahead and|now|already))? (?:refund|refunded|charge|charged|credit|credited|reimburse|reimbursed|bill|billed|invoice|invoiced) (?:you|your|the card|the account)\\b",
    "\\b(?:we|i)(?:'ll| will| would| can| could| are going to| am going to)? (?:give|send|issue|offer|apply|process) (?:you )?(?:a |an |the |your )?(?:full |partial |\\d+% )?(?:refund|credit|discount|coupon|rebate|chargeback)\\b",
    "\\byou(?:'ll| will)? (?:be|get|receive) (?:charged|billed|invoiced|refunded|credited|a refund|a credit|a discount)\\b",
    "\\byour (?:refund|credit|charge|payment) (?:has been|was|is being|will be) (?:issued|processed|approved|sent|charged|applied)\\b",
    // payment links and pay-now prompts
    "\\b(?:payment|pay|checkout|invoice) (?:link|page|portal|button)\\b", "\\bpay (?:here|now|online|today|by card)\\b", "\\binvoice (?:is )?(?:attached|enclosed)\\b",
  ].join('|'), 'i')],
  // Narrowed (bug 8 audit): "molecular / gene / exposure signature", "in agreement with earlier studies" and "agreement
  // between dosimetry methods" are research wording; a signature, contract or agreement between us and the customer still blocks.
  ['sign', /(?<!\b(?:a|an|the|no|any|one|another|clear|early|first|warning|vital|good|bad|positive|negative|major|key) )\bsign(?:ing|ed)? (?:the|a|an|this|that|your|our|it)\b|\b(?:your|our|a|the) (?:e-?)?signature\b(?! (?:of|in|for (?:the )?(?:cells?|genes?|tumou?rs?|exposure|radiation)))|\bsignature (?:here|below|line|page|required|block)\b|\be-?sign\b|\bcontract\b|\b(?:our|your|this|the attached|the enclosed|a|an) (?:\w+ )?agreement\b(?! (?:with|between|among) (?:the |previous |prior |earlier |other |published )?(?:literature|results?|findings|studies|reports|measurements?|models?|methods?|data))/i],
  // Narrowed (John, Nov 14 8:46 PM ET): only our own promises or guarantees ("we promise", "I guarantee", "we're committed to"),
  // and never a negated one ("we do not promise", "no case guarantees", "not guarantee"); see hardBlock().
  ['commit', /\b(?:we|i)(?:'ll| will| can| do)? (?:agree|accept|commit|promise|guarantee)\b|\b(?:we|i) (?:will (?:definitely|certainly) (?:do|deliver|have))\b|\b(?:we|i)(?:'re| are| am) (?:committed|guaranteeing|promising)\b|\bour (?:promise|guarantee|commitment)\b|\b(?:is|are) guaranteed\b|\bguaranteed to\b|\b(?:it'?s|that'?s|you(?:'ve)? got|we have) a deal\b|\b(?:special|exclusive|limited[- ]time) deal\b|\b(?:make|cut|strike|work out|offer you|give you|get you) a (?:better |good |great |special )?deal\b|\bdeal (?:for you|on (?:a|the|your|our) (?:case|order|product))\b|\bcount (?:us|me) in\b|\bwe(?:'re| are) in\b/i],
  ['yes_to_offer', /^\s*(?:yes|yeah|yep|sure|ok(?:ay)?|sounds good|let'?s do it|absolutely)\b/i],
];
// commit and buy are checked clause by clause: a match is negated only when a negator sits in the same clause within
// ~4 words before the verb ("We do not promise…"), so "We don't sell 99% claims, but we promise it blocks 99%" blocks.
// Links are ignored.
const NEG = /^(?:not|no|never|neither|nor|cannot|can't|don't|doesn't|won't|isn't|aren't|without|didn't|wouldn't|shouldn't)$/i;
function negatedAt(clause, idx) { const before = clause.slice(0, idx).trim().split(/\s+/).filter(Boolean).slice(-4); return before.some(w => NEG.test(w.replace(/[^a-z']/gi, ''))); }
function clauseHit(text, r) {
  const g = new RegExp(r.source, r.flags.includes('g') ? r.flags : r.flags + 'g');
  for (const clause of String(text).split(/[.!?;:,\n]+|\b(?:but|however|although|though|while|yet|whereas)\b/i)) {
    g.lastIndex = 0; let m; while ((m = g.exec(clause))) { const words = m[0].split(/\s+/); const verbAt = m.index + m[0].length - words[words.length - 1].length; if (!negatedAt(clause, verbAt) && !NEG.test(words.slice(0, -1).join(' ').split(/\s+/).pop() || '')) return true; if (!m[0].length) g.lastIndex++; }
  }
  return false;
}
// The reply subject usually just quotes the customer's own subject ("Re: A few questions before I order for my family").
// Their words are not our commitment (John, Nov 14 10:19 PM ET), so the hard block checks only subject text we wrote:
// an unchanged "Re:/RE:/Fwd:" + original subject (case- and whitespace-insensitive) contributes nothing; any other subject is checked whole.
const SUBJ_PREFIX = /^\s*(?:(?:re|fwd?|aw|sv)\s*(?:\[\d+\])?\s*:\s*)+/i;
const normSubject = (t) => String(t || '').replace(SUBJ_PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase();
function ownSubject(subject, originalSubject) {
  const s = String(subject || ''); if (!s.trim()) return '';
  if (originalSubject != null && normSubject(s) === normSubject(originalSubject)) return '';
  return s;
}
// John, Nov 15 2026, 4:48 PM ET: "Allow agreement, contract, and guarantee in researched answers." In a reply that uses
// the web-research fallback (draft.web_research), those words are allowed when they describe third parties (funding
// disclosures: "firewall agreements that guarantee independence", "a research contract with Ericsson"). They still
// count when the same clause ties them to us or the customer within 3 words ("we guarantee", "our agreement", "your
// contract", "an agreement with us"), so a researched reply can never commit RF Safe to anything. Every other reply,
// the customer's own email and every other hard block / hold (money, legal, chargeback) are unchanged.
const RESEARCH_WORDS = /\b(?:agreements?|contracts?|contractual(?:ly)?|guarantee(?:s|d|ing)?|guarantor)\b/gi;
const PARTY = /^(?:we|i|our|ours|us|me|my|mine|you|your|yours|we'll|we're|we'd|we've|i'll|i'm|i'd|i've|you're|you'll|you'd|rf|safe|rfsafe)$/i;
function researchedWords(text) {
  return String(text || '').split(/([.!?;:\n]+)/).map((clause) => clause.replace(RESEARCH_WORDS, (m, off) => {
    const near = [...clause.slice(0, off).trim().split(/\s+/).slice(-3), ...clause.slice(off + m.length).trim().split(/\s+/).slice(0, 3)].map((w) => w.replace(/[^a-z']/gi, ''));
    return near.some((w) => PARTY.test(w)) ? m : 'term';
  })).join('');
}
function hardBlock(text, { researched = false } = {}) {
  let s = String(text || '').slice(0, 40000).replace(/https?:\/\/[^\s<>()"'\]]+/gi, ' ');
  if (researched) s = researchedWords(s);
  return HARD.filter(([k, r]) => (k === 'commit' || k === 'buy' || k === 'pay') ? clauseHit(s, r) : r.test(s)).map(([k]) => k);
}

// Codes and links hidden in copies of the site's own outgoing mail (sign-in emails etc.).
function redact(text) {
  return String(text || '')
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi, '[link hidden]')
    .replace(/\b(?=[A-Za-z0-9_-]{16,}\b)(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/g, '[code hidden]')
    .replace(/\b(?=[A-Z0-9-]{4,10}\b)(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)*\b/gi, (m) => /^(?:19|20)\d\d$/.test(m) ? m : '[code hidden]')
    .replace(/\b\d{3}[\s-]\d{3}\b/g, '[code hidden]');
}

const CHECKER_INSTRUCTIONS = `You are the independent checker for replies a support bot drafted for a website's mailbox.
You did not write the draft. Grade it strictly. Reply with JSON only: {"verdict":"pass"|"fail"|"unsure","notes":"<short reason>"}.
Fail if ANY of these is true:
- It states facts that are not supported by the original message or the site's public information, or makes up claims.
- It makes any promise, commitment, offer or timeline on behalf of the company or its owner, or offers, promises or invents a discount, code or percentage off.
- It agrees to buy, sign up, subscribe, opt in, pay, sign anything, or join anything. It says YES to a sales pitch.
- It reveals private data (addresses, phone numbers, order numbers, emails of others, internal notes, keys or codes).
- It discusses refunds, legal questions, a complaint, or names a person at the company.
- It answers a medical or personal-health question (pregnancy, symptoms, a condition or disease) without opening with the site's medical disclaimer, or it diagnoses, recommends treatment or medication, says EMF, RF, Wi-Fi or phones caused the person's condition, or links research anywhere but an https://rfsafe.app/research/papers/ page. A medical reply that opens with the disclaimer and shares RF Safe's knowledge base positions and rfsafe.app study pages is allowed.
- The tone is rude, pushy, or does not fit a short, helpful support reply.
- It mixes sales into a support answer.
Use "unsure" whenever you are not confident. Only use "pass" for a short, polite, accurate support answer.`;

// Optional AI grade using the site's existing XAI_API_KEY. Returns { verdict, notes } and never throws.
class XaiChecker {
  constructor({ apiKey, model = 'grok-4.7', fetchImpl = globalThis.fetch, timeoutMs = 20000 }) { this.key = apiKey; this.model = model; this.fetch = fetchImpl; this.timeoutMs = timeoutMs; }
  get available() { return !!this.key; }
  async grade({ original, draft, siteName }) {
    if (!this.key) return { verdict: 'unsure', notes: 'checker unavailable' };
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), this.timeoutMs);
      const r = await this.fetch('https://api.x.ai/v1/chat/completions', { method: 'POST', signal: ctl.signal, headers: { authorization: 'Bearer ' + this.key, 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, temperature: 0, max_tokens: 200, messages: [{ role: 'system', content: CHECKER_INSTRUCTIONS + `\nSite: ${siteName}.` },
          { role: 'user', content: 'ORIGINAL MESSAGE (untrusted):\n<<<\n' + String(original || '').slice(0, 6000) + '\n>>>\n\nDRAFT REPLY:\n<<<\n' + String(draft || '').slice(0, 6000) + '\n>>>' }] }) });
      clearTimeout(t);
      if (!r.ok) return { verdict: 'unsure', notes: 'checker error ' + r.status };
      const j = await r.json(); const c = String(j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '');
      const m = c.match(/\{[\s\S]*\}/); const o = m ? JSON.parse(m[0]) : {};
      const verdict = ['pass', 'fail', 'unsure'].includes(o.verdict) ? o.verdict : 'unsure';
      return { verdict, notes: String(o.notes || '').slice(0, 300) };
    } catch { return { verdict: 'unsure', notes: 'checker unreachable' }; }
  }
}

// Every rule except the AI grade, in order. Returns { ok:true } or { ok:false, reason, detail }.
// Automated senders (no-reply, bounces, notification systems) never get a reply.
const AUTOMATED = /^(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|notify|alerts?|status|system|automated|daemon)(?:[+._-][^@]*)?@/i;
function isAutomated(m) { const a = (String((m && m.from) || '').match(/<([^>]+)>/) || [null, String((m && m.from) || '')])[1].trim(); return AUTOMATED.test(a); }
const RETURNS_REFUND_LINE = /For a refund, just say you(?:'|’)d like it refunded, and we(?:'|’)ll take care of it\.?/gi;
// Verbatim owner-approved KB sentences (John Coates, Nov 14, 2026) are pre-approved wording: they never trip a hard block,
// an escalation or a refund-timeline check when a draft quotes them ("matter a great deal" is not a "deal").
const OWNER_APPROVED = [
  RETURNS_REFUND_LINE,
  /Within 30 days of receiving your case, mail it back to our return address,[^.]*?with a note saying you(?:'|’)d like a refund, and we(?:'|’)ll give you back your money\.?/gi,
  /We don(?:'|’)t recommend that children use cell phones\.?/gi,
  /If they do, we recommend an air-tube headset\.?/gi,
  /Research has shown that children absorb much more radiation than adults, and the timing of their development can also matter a great deal\.?/gi,
  /Children aren(?:'|’)t just small adults, so cell phone use by developing bodies should be limited as much as possible\.?/gi,
  /We ship by USPS from Seminole, Florida\.?/gi,
  /Orders usually arrive in about 1 to 3 business days on the East Coast and about 4 to 6 business days on the West Coast\.?/gi,
  /USPS says its standard service takes 2 to 5 business days, and delivery times can vary\.?/gi,
  /Right now we only ship within the United States\.?/gi,
  /International shipping will start again soon\.?/gi,
];
function stripOwnerApproved(text) { let s = String(text || ''); for (const r of OWNER_APPROVED) s = s.replace(r, ' '); return s; }
function autoSendGate({ settings, available, original, draft, sentToday, ownDomains, disclaimer, researched = false } = {}) {
  if (settings.kill_switch) return { ok: false, reason: 'kill_switch' };
  if (!settings.auto_send) return { ok: false, reason: 'auto_send_off' };
  if (!available) return { ok: false, reason: 'checker_unavailable' };
  if (!original || !original.from || original.folder === 'sent') return { ok: false, reason: 'not_a_reply' };
  const fromDom = (String(original.from).match(/@([^>\s]+)>?\s*$/) || [])[1];
  if (fromDom && ownDomains.includes(fromDom.toLowerCase())) return { ok: false, reason: 'not_a_reply' };
  if (original.folder === 'spam' || isPromo(original)) return { ok: false, reason: 'promo' };
  if (isAutomated(original)) return { ok: false, reason: 'automated_sender' };
  const hb = hardBlock(ownSubject(draft.subject, original.subject) + '\n' + stripOwnerApproved(draft.body), { researched });
  if (hb.length) return { ok: false, reason: 'hard_block', detail: hb };
  // "disease" holds only when the customer's email raises it (John, Nov 14 8:46 PM ET); the KB disclaimer in a draft does not.
  // John's owner-approved returns answer (Nov 14, 9:25 PM ET) mentions refunds; quoting it in an exchange reply is not a refund request.
  let dBody = stripOwnerApproved(draft.body).replace(/\bdiseases?\b/gi, ' ');
  if (researched) dBody = researchedWords(dBody); // only the draft's own words; the customer's email is checked as before
  const customerText = [original.subject, original.text].join('\n');
  const so = { from: original.from, senderNames: stripSignature(original.text).names };
  const esc = [...new Set([...escalations([original.subject, original.text], settings.staff_names, so), ...escalations([draft.subject, dBody], settings.staff_names, { ...so, rules: ESCALATE_DRAFT })])]; // draft: narrow legal rule (bug 6)
  if (esc.length) return { ok: false, reason: 'needs_john', detail: esc, matches: escalationMatches([{ where: 'customer email', text: customerText }, { where: 'draft reply', text: [draft.subject, dBody].join('\n') }], settings.staff_names, so) };
  // John, Nov 15, 3:55 PM ET: a medical or personal-health email is answered, never sent without the KB disclaimer (at the bottom since 9:38 PM ET).
  if (isMedicalQuestion(customerText)) {
    const d = typeof disclaimer === 'string' ? disclaimer.trim() : '';
    if (!d) return { ok: false, reason: 'medical_disclaimer_missing', detail: ['medical or personal-health email ("' + medicalMatch(customerText) + '"), but the KB entry ' + DISCLAIMER_SLUG + ' is missing or empty'] };
    if (!disclaimerLast(draft.body, d)) return { ok: false, reason: 'medical_disclaimer_not_last', detail: ['medical or personal-health reply does not carry the ' + DISCLAIMER_SLUG + ' text exactly once at the bottom, before the sign-off'] };
  }
  if (sentToday >= Math.max(0, Number(settings.daily_cap) || 0)) return { ok: false, reason: 'daily_cap' };
  return { ok: true };
}
module.exports = { DRAFT_COMPLAINT, draftEscalations: (texts, staffNames, opts = {}) => escalations(texts, staffNames, { ...opts, rules: ESCALATE_DRAFT }), DRAFT_LEGAL, disclaimerLast, ensureDisclaimerLast, splitSignoff, countDisclaimer, stripRelated, hasRelatedLine, formatParagraphs, splitSentences, ownSubject, stripOwnerApproved, OWNER_APPROVED, isAutomated, isPromo, promoScore, isPregnancyEmfQuestion, isMedicalQuestion, medicalMatch, DISCLAIMER_SLUG, disclaimerFromEntry, disclaimerFirst, ensureDisclaimerFirst, splitGreeting, escalations, escalationMatches, staffMatches, stripSignature, STAFF_PEOPLE, hardBlock, researchedWords, redact, autoSendGate, XaiChecker, CHECKER_INSTRUCTIONS };
