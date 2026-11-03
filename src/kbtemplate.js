'use strict';
// Read and check a per-business KB folder (kb/template layout), and pack its cards as a callbots-kb bundle.
const fs = require('fs'); const path = require('path');
const F = require('./kbformat');
const CARD_FILES = ['products-services.jsonl', 'pricing.jsonl', 'faq.jsonl', 'policies.jsonl'];
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function readCards(dir) {
  const out = []; const errors = [];
  for (const f of CARD_FILES) {
    const p = path.join(dir, f); if (!fs.existsSync(p)) { errors.push(f + ': missing'); continue; }
    fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => { if (!l.trim()) return; try { out.push({ card: JSON.parse(l), where: `${f}:${i + 1}` }); } catch { errors.push(`${f}:${i + 1}: not JSON`); } });
  }
  return { cards: out, errors };
}
function checkTemplate(dir, { allowDomains } = {}) {
  const errors = [];
  for (const f of ['business.md', 'escalation.md', 'links.json']) if (!fs.existsSync(path.join(dir, f))) errors.push(f + ': missing');
  let links = [];
  try { links = JSON.parse(fs.readFileSync(path.join(dir, 'links.json'), 'utf8')); if (!Array.isArray(links) || !links.every((d) => typeof d === 'string' && DOMAIN.test(d))) errors.push('links.json: must be an array of bare domains'); } catch { if (fs.existsSync(path.join(dir, 'links.json'))) errors.push('links.json: not JSON'); }
  const domains = allowDomains || links;
  const r = readCards(dir); errors.push(...r.errors);
  const allow = domains.length ? F.allowFor(domains) : /^$/;
  const ids = new Set();
  for (const { card, where } of r.cards) {
    const e = F.validateGenericCard(card, allow); if (e.length) errors.push(`${where}: bad ${e.join(', ')}`);
    if (card && ids.has(card.id)) errors.push(`${where}: duplicate id ${card.id}`); else if (card) ids.add(card.id);
  }
  return { ok: !errors.length, errors, cards: r.cards.map((x) => x.card), links };
}
function buildBundle(dir, { tenant, allowDomains, producer = 'grok-bot', now = new Date() }) {
  const c = checkTemplate(dir, { allowDomains });
  if (!c.ok) throw Object.assign(new Error('KB not valid: ' + c.errors.join('; ')), { status: 400 });
  if (!c.cards.length) throw Object.assign(new Error('KB has no cards yet'), { status: 400 });
  return F.encode({ format: F.GENERIC, tenant, generated: now.toISOString(), producer }, c.cards);
}
module.exports = { checkTemplate, buildBundle, CARD_FILES };
