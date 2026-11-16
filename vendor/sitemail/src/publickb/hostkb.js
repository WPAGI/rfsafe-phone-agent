'use strict';
// Read-only adapter: the host's own knowledge base folders (for example the Callbots phone agent's KB) as public /kb
// entries. It only opens files for reading (fs.openSync 'r' / readFileSync); it never writes, moves or deletes, so the
// host KB files and its bundle hash stay exactly as they are.
//
// Filter rules (an entry is left out when ANY rule matches; every skip is counted by rule):
//   not_markdown   only *.md pages; BUNDLE.json, dotfiles and marker files are not pages
//   page_type      only the page types listed in config (default: curated, position, answer, topic). The bulk research
//                  library (study, harm-node, research, article, post) stays on the research site, linked from entries
//   internal       internal or owner-only by slug or title: answer/voice/reference guides, prompts, instructions,
//                  system or agent text, readme, build briefs and product specs, owner-only, staff-only, internal, draft, confidential, symptom-map
//   instructions   text written for the phone agent or the team, not for readers ("you are the assistant", "when a caller",
//                  "system prompt", "tool call", "do not tell the caller", build notes for Jarvis or Coder, "John says" ...)
//   secret         anything that looks like a key, token or password (re_, sk_, whsec_, shpat_, xai-, Bearer, or
//                  "api key: / password: / secret= / token=" followed by a value)
//   private_number a phone number not on the config's public_numbers list
//   private_email  an email address not on the config's public_emails list
//   (note lines)   a single line that is a team note (Jarvis, Coder, "John's review", "spec §", TODO) is cut from an
//                  otherwise public page; the count is reported as notes.lines
//   empty          no readable text after the header
//   duplicate      the slug already exists in a higher layer (Brain box, then the exported site KB)
const fs = require('fs');
const path = require('path');

const DEFAULT_TYPES = ['curated', 'position', 'answer', 'topic'];
const INTERNAL_RE = /(?:^|[-_ ])(?:voice-answer-guide|answer[- ]guide|reference[- ]guide|prompts?|instructions?|system|agent|owner[- ]only|staff[- ]only|internal|draft|confidential|private|symptom-map|readme|build-brief|product-spec|spec)(?:$|[-_ ])/i;
const INSTRUCTION_RE = /\b(?:you are (?:an?|the) (?:assistant|agent|bot|ai)|system prompt|tool call|function call|when (?:a|the) caller|tell the caller|ask the caller|do not tell (?:the )?(?:caller|customer)|never (?:say|tell|mention)|the agent (?:should|must)|as an ai)\b/i;
// Team notes inside otherwise public pages (review flags, build notes): the LINE is removed, the page stays.
const NOTE_RE = /\b(?:for coder|coder|jarvis|john says|john's (?:approval|review|ok|call|decision)|pending (?:john|review)|spec §|todo|fixme|internal note)\b|spec §/i;
const SECRET_RE = /(?:\b(?:re|sk|rk|pk)_(?:live_|test_)?[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9+/=]{10,}|shp(?:at|ss|ca|pa)_[a-f0-9]{10,}|xai-[A-Za-z0-9]{16,}|\bbearer\s+[A-Za-z0-9._-]{12,}|\b(?:api[ _-]?key|password|passcode|secret|token)\s*[:=]\s*\S{6,})/i;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const digits = (s) => String(s).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text); const fm = {};
  if (!m) return { fm, body: text };
  for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) { let v = line.slice(i + 1).trim(); if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch {} } fm[line.slice(0, i).trim()] = v; } }
  return { fm, body: text.slice(m[0].length) };
}
// Page type from the header only (first 1 KB), so the large research library is skipped without a full read.
function headType(file) {
  let fd; try { fd = fs.openSync(file, 'r'); const b = Buffer.alloc(1024); const n = fs.readSync(fd, b, 0, 1024, 0); const m = /\npage_type:\s*([a-z-]+)/.exec(b.toString('utf8', 0, n)); return m ? m[1] : null; } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
const slugOf = (rel) => path.basename(rel, '.md').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);

// dirs: absolute folders; opts: { pageTypes, publicNumbers, publicEmails, topics: {page_type: topic name}, ttlMs }
function createHostKb({ linkBase = () => '', maxChars = 12000, dirs = [], pageTypes = DEFAULT_TYPES, publicNumbers = [], publicEmails = [], topics = {}, ttlMs = 300000, now = () => Date.now() } = {}) {
  const okNums = new Set(publicNumbers.map(digits)); const okMails = new Set(publicEmails.map((e) => String(e).toLowerCase()));
  const types = new Set(pageTypes); let cache = null;
  function scan() {
    const entries = []; const skipped = {}; const samples = {}; const notes = { lines: 0, pages: 0, samples: [] };
    const skip = (rule, rel) => { skipped[rule] = (skipped[rule] || 0) + 1; (samples[rule] ||= []); if (samples[rule].length < 5) samples[rule].push(rel); };
    for (const root of dirs) {
      const walk = (d) => {
        let list = []; try { list = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
        for (const e of list) {
          const f = path.join(d, e.name); const rel = path.relative(root, f);
          if (e.isDirectory()) { if (!e.name.startsWith('.') && !/\.(tmp|old)(-\d+)?$/.test(e.name)) walk(f); continue; }
          if (!e.isFile() || !e.name.endsWith('.md') || e.name.startsWith('.')) { skip('not_markdown', rel); continue; }
          const ht = headType(f); const type = ht || 'curated'; // pages without a header are hand-written cards
          if (!types.has(type)) { skip('page_type', rel); continue; }
          let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
          const { fm, body } = frontmatter(text); const title = String(fm.title || (/^#\s+(.+)$/m.exec(body) || [])[1] || path.basename(f, '.md')).trim();
          const slug = slugOf(rel);
          if (INTERNAL_RE.test(slug) || INTERNAL_RE.test(' ' + title + ' ')) { skip('internal', rel); continue; }
          let clean = body.replace(/^#\s+.+\n+/, '').replace(/\n+Sources:[^\n]*\n*$/, '');
          const lines = clean.split('\n'); const kept = lines.filter((l) => !NOTE_RE.test(l));
          if (kept.length !== lines.length) { notes.lines += lines.length - kept.length; notes.pages++; if (notes.samples.length < 5) notes.samples.push(rel); }
          clean = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
          if (!clean) { skip('empty', rel); continue; }
          if (INSTRUCTION_RE.test(clean)) { skip('instructions', rel); continue; }
          if (SECRET_RE.test(clean) || SECRET_RE.test(title)) { skip('secret', rel); continue; }
          if ((clean.match(PHONE_RE) || []).some((n) => !okNums.has(digits(n)))) { skip('private_number', rel); continue; }
          if ((clean.match(EMAIL_RE) || []).some((m) => !okMails.has(m.toLowerCase()))) { skip('private_email', rel); continue; }
          const src = /\nSources:\s*(https:\/\/\S+)/.exec(body); const source = String(fm.source || (src ? src[1] : '') || '');
          entries.push({ slug, title, text: clean, source: /^https:\/\//.test(source) ? source : '', updated: /^\d{4}-\d{2}-\d{2}/.test(String(fm.updated || '')) ? String(fm.updated).slice(0, 10) : null,
            aliases: String(fm.aliases || '').slice(0, 600), page_type: type, topic: topics[type] || null, origin: 'host_kb' });
        }
      };
      walk(root);
    }
    // Second pass: Markdown to the plain text the /kb renderer shows. A link to another public page becomes its /kb
    // address; a link to a page that is not public (the research library, posts) keeps only its label.
    const pub = new Set(entries.map((e) => e.slug)); const base = String(linkBase() || '').replace(/\/$/, '');
    let links = { kept: 0, to_kb: 0, label_only: 0 };
    for (const e of entries) {
      let t = e.text.replace(/\[([^\]\n]{0,300})\]\(([^)\s]+)\)/g, (m, label, href) => {
        if (/^https:\/\//.test(href)) { links.kept++; return label && label !== href ? label + ' (' + href + ')' : href; }
        const sl = slugOf(href.split('#')[0]);
        if (/\.md(#.*)?$/.test(href) && pub.has(sl) && base) { links.to_kb++; return label + ' (' + base + '/kb/' + sl + ')'; }
        links.label_only++; return label;
      });
      t = t.replace(/^#{1,6}\s+(.+)$/gm, '\n$1\n').replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1').replace(/^\|?[-:| ]+\|[-:| ]*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
      if (t.length > maxChars) { const cut = t.lastIndexOf('\n\n', maxChars); t = t.slice(0, cut > maxChars / 2 ? cut : maxChars).trim() + '\n\n(Shortened here. The full list is in the research directory.)'; e.shortened = true; }
      e.text = t;
    }
    return { entries, skipped, samples, notes, links, at: now() };
  }
  const read = () => { if (!cache || now() - cache.at >= ttlMs) cache = scan(); return cache; };
  return { read, reset: () => { cache = null; }, scan };
}

// The same privacy rules for one piece of text (growth-loop proposals): returns the rule that blocks it, or null.
function checkText(text, { publicNumbers = [], publicEmails = [] } = {}) {
  const t = String(text || ''); const okNums = new Set(publicNumbers.map(digits)); const okMails = new Set(publicEmails.map((e) => String(e).toLowerCase()));
  if (INSTRUCTION_RE.test(t)) return 'instructions';
  if (SECRET_RE.test(t)) return 'secret';
  if ((t.match(PHONE_RE) || []).some((n) => !okNums.has(digits(n)))) return 'private_number';
  if ((t.match(EMAIL_RE) || []).some((m) => !okMails.has(m.toLowerCase()))) return 'private_email';
  return null;
}

module.exports = { checkText, slugOf, createHostKb, DEFAULT_TYPES, INTERNAL_RE, INSTRUCTION_RE, NOTE_RE, SECRET_RE, frontmatter };
