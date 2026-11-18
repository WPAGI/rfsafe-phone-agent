'use strict';
// Edge testing agent grade: one small model call compares an earlier run's reply (A) with a newer run's reply (B)
// for the same saved test email, against that test's expected behavior. Output: better | same | worse + short reason.
const GRADE_SYSTEM = [
  'You compare two email replies that RF Safe\'s mailbox wrote to the same customer email. Reply A is from an earlier run; reply B is from a newer run.',
  'Judge B against A using the expected behavior first, then: answers what was asked, no invented facts, prices, links or promises, approved wording, no unasked additions, clear and short.',
  'Ignore greetings, the newsletter footer, line breaks and harmless rewording. A held reply (nothing would be sent) is worse than a correct sent reply, unless holding is the expected behavior.',
  'Return JSON only: {"grade":"better"|"same"|"worse","reason":"one short sentence, at most 30 words"}.'
].join(' ');
const GRADES = ['better', 'same', 'worse'];
// Fallback prices (USD per million tokens) when xAI does not report the cost; deliberately on the high side.
const FALLBACK = { in: 3, out: 15 };

function gradeInput({ test, a, b, aLabel, bLabel }) {
  const side = (r, label) => ({ run: label, disposition: r.disposition, checker_verdict: r.checker_verdict || null, reply: String(r.reply || '').slice(0, 6000), hold_reason: String(r.hold_reason || '').slice(0, 400) });
  return { email: { subject: test.subject, text: String(test.question || '').slice(0, 6000) }, expected_behavior: String(test.expected || '').slice(0, 2000), reply_a: side(a, aLabel), reply_b: side(b, bLabel) };
}
async function gradePair({ fetchImpl, key, model, test, a, b, aLabel, bLabel, timeoutMs = 60000 }) {
  if (!key) throw Object.assign(new Error('model_key_missing'), { status: 503 });
  const res = await fetchImpl('https://api.x.ai/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ model, temperature: 0, max_tokens: 300, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: GRADE_SYSTEM }, { role: 'user', content: JSON.stringify(gradeInput({ test, a, b, aLabel, bLabel })) }] }) });
  if (!res || !res.ok) throw Object.assign(new Error('grade_provider_error'), { status: 502, http: res && res.status });
  const j = await res.json(); const u = j.usage || {};
  let out = {}; try { out = JSON.parse(String(((j.choices || [])[0] || {}).message?.content || '{}').replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { out = {}; }
  const grade = GRADES.includes(String(out.grade).toLowerCase()) ? String(out.grade).toLowerCase() : null;
  if (!grade) throw Object.assign(new Error('grade_unreadable'), { status: 502 });
  const ticks = Number(u.cost_in_usd_ticks);
  const cost = Number.isFinite(ticks) && ticks > 0 ? ticks / 1e10 : ((Number(u.prompt_tokens) || 0) * FALLBACK.in + (Number(u.completion_tokens) || 0) * FALLBACK.out) / 1e6;
  return { grade, reason: String(out.reason || '').replace(/\s+/g, ' ').trim().slice(0, 240), model, cost_usd: Math.round(cost * 1e6) / 1e6 };
}
module.exports = { gradePair, gradeInput, GRADE_SYSTEM, GRADES };
