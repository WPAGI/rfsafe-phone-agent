'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path'); const os = require('os');
const S = require('../src/owner/summary');
const { Tools, Approvals } = require('../src/tools');

const TZ = 'America/New_York'; const NOW = new Date('2026-10-31T16:00:00Z');
function files(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unans-'));
  const f = {}; for (const [k, list] of Object.entries(rows)) { f[k] = path.join(dir, k + '.jsonl'); fs.writeFileSync(f[k], list.map((x) => JSON.stringify(x)).join('\n') + '\n'); }
  return f;
}
const tenant = { id: 'r', name: 'RF Safe' };

test('collect lists actual unanswered questions with channel, EDT time and outcome; dedupes no_match vs note', () => {
  const f = files({
    kbGaps: [
      { at: '2026-10-31T12:05:00Z', tenant: 'r', question: 'lowest sar phone 2025', reason: 'no_match', channel: 'voice', call: 'c1', from_last4: '4752' },
      { at: '2026-10-31T12:06:00Z', tenant: 'r', question: 'Which phone has the lowest SAR in 2025?', reason: 'model_unanswered', channel: 'voice', call: 'c1', from_last4: '4752' },
      { at: '2026-10-31T13:00:00Z', tenant: 'r', question: 'Do you ship to Canada', reason: 'model_unanswered', channel: 'sms', call: 'sms-1', from_last4: '0142' },
      { at: '2026-10-31T13:30:00Z', tenant: 'r', question: 'my pin is 8317, email me at joe@x.com or call 727-555-0142, card 4111 1111 1111 1111', reason: 'no_match', channel: 'email' },
      { at: '2026-10-30T13:30:00Z', tenant: 'r', question: 'yesterday', reason: 'no_match', channel: 'voice' },
    ],
    callRecords: [{ at: '2026-10-31T12:04:00Z', call: 'c1', tenant: 'r', tools: ['kb_answer', 'note_unanswered', 'take_message'] }],
    sentMessages: [{ at: '2026-10-31T13:01:00Z', tenant: 'r', channel: 'sms', call: 'sms-1', text: 'See https://rfsafe.org/x' }],
    outbox: [], events: [],
  });
  const st = S.collect({ tenant, files: f, now: NOW, tz: TZ });
  assert.strictEqual(st.gaps, 3);
  const [a, b, c] = st.unanswered;
  assert.strictEqual(a.question, 'Which phone has the lowest SAR in 2025?'); assert.strictEqual(a.channel, 'call'); assert.strictEqual(a.time, '8:06 AM EDT'); assert.match(a.outcome, /message taken/);
  assert.strictEqual(b.channel, 'text'); assert.match(b.outcome, /link texted/);
  assert.doesNotMatch(c.question, /8317|joe@x\.com|727-555|4111/); assert.match(c.question, /\[email\]/); assert.match(c.question, /number ending 0142/);
  const spoken = S.render(st);
  assert.match(spoken, /Three questions we couldn't answer: one, Which phone has the lowest SAR in 2025 \(call, 8:06 AM EDT, message taken\); two, Do you ship to Canada/);
  assert.doesNotMatch(spoken, /8317|joe@|1111 1111/);
  assert.match(S.renderUnansweredList(st.unanswered), /^Unanswered questions:\n1\. Which phone/);
});

test('spoken briefing caps at 5, the list keeps up to 25, long questions are paraphrased short', () => {
  const gaps = Array.from({ length: 30 }, (_, i) => ({ at: new Date(Date.parse('2026-10-31T11:00:00Z') + i * 60000).toISOString(), tenant: 'r', question: 'question number ' + 'abcdefghijklmnopqrstuvwxyzABCD'[i] + ' ' + 'blah '.repeat(i === 0 ? 60 : 1), reason: 'model_unanswered', channel: 'voice', call: 'k' + i }));
  const st = S.collect({ tenant, files: files({ kbGaps: gaps, callRecords: [], sentMessages: [], outbox: [], events: [] }), now: NOW, tz: TZ });
  assert.strictEqual(st.unanswered.length, 25); assert.ok(st.unanswered.every((u) => u.question.length <= 141));
  const spoken = S.render(st); assert.match(spoken, /questions we couldn't answer: one, .*five, [^;]*\. Plus \d+ more; ask me for the full list\./); assert.doesNotMatch(spoken, /six,/);
});

test('kb gaps record the conversation id and caller last 4 only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-')); const gf = path.join(dir, 'g.jsonl');
  const t = { id: 'r', name: 'RF Safe', numbers: ['+17276775572'], link_allowlist: ['rfsafe.org'], blocked_topics: [] };
  const tools = new Tools(t, { kbFor: () => ({ answer: () => ({ found: false }) }), approvals: new Approvals(), log: () => {}, kbGapFile: gf });
  await tools.run('note_unanswered', { question: 'case for pixel 9' }, { channel: 'voice', callId: 'CALL9', caller: '+17272444752' });
  const r = JSON.parse(fs.readFileSync(gf, 'utf8').trim());
  assert.strictEqual(r.call, 'CALL9'); assert.strictEqual(r.from_last4, '4752'); assert.doesNotMatch(JSON.stringify(r), /7272444752/);
});
