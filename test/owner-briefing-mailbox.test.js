'use strict';
// Owner briefing: same-day Site Mail mailbox + Brain box lines (team note fb_9oxoRqnbm8Cs). Mock data only.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path'); const os = require('os');
const S = require('../src/owner/summary');
const NOW = new Date('2026-11-17T01:30:00Z'); // 8:30 PM ET, Nov 16
const TZ = 'America/New_York'; const tenant = { id: 'rfsafe' };
const step = (at, step, status, reason = 'x') => ({ at, step, status, reason });

function site() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-mail-')); const sm = path.join(dir, 'sitemail');
  fs.mkdirSync(path.join(sm, 'mailbox'), { recursive: true }); fs.mkdirSync(path.join(sm, 'kb-api', 'callbots'), { recursive: true });
  const timeline = {
    m_sent: [step('2026-11-16T14:00:00Z', 'pipeline', 'started', 'New mail (webhook)'), step('2026-11-16T14:01:00Z', 'sort', 'done'), step('2026-11-16T14:03:00Z', 'auto_send', 'sent')],
    m_held: [step('2026-11-16T15:00:00Z', 'pipeline', 'started', 'New mail (webhook)'), step('2026-11-16T15:05:00Z', 'reply', 'held', 'KB gap')],
    m_fail: [step('2026-11-16T16:00:00Z', 'pipeline', 'started', 'New mail (poll)'), step('2026-11-16T16:02:00Z', 'reply', 'error', 'Draft refused')],
    // received yesterday, rerun today (8:00 PM ET) and held again: rerun + held, not received
    m_rerun: [step('2026-11-15T23:00:00Z', 'pipeline', 'started', 'New mail (webhook)'), step('2026-11-15T23:05:00Z', 'reply', 'held'), step('2026-11-17T01:00:00Z', 'pipeline', 'requested', 'Run requested by Jarvis rerun key'), step('2026-11-17T01:04:00Z', 'check', 'fail')],
    // yesterday only (ET): ignored. 11:30 PM ET Nov 15 = 04:30Z Nov 16, still Nov 15 in New York.
    m_old: [step('2026-11-16T04:30:00Z', 'pipeline', 'started', 'New mail (webhook)'), step('2026-11-16T04:31:00Z', 'reply', 'error')]
  };
  const sent = { s_1: { id: 's_1', at: '2026-11-16T14:03:00Z', via: 'auto', box: 'SEALED-mock-jane@example.com' }, s_2: { id: 's_2', at: '2026-11-15T12:00:00Z', via: 'owner', box: 'SEALED' } };
  fs.writeFileSync(path.join(sm, 'mailbox', 'mailbox.json'), JSON.stringify({ v: 1, meta: {}, copies: { m_sent: 'SEALED body Jane Doe' }, drafts: {}, sent, bots: { timeline } }));
  fs.writeFileSync(path.join(sm, 'kb-api', 'callbots', 'audit.jsonl'), [
    { at: '2026-11-16T18:00:00Z', tenant: 'callbots', slug: 'shipping-california', action: 'create', text_hash: 'h' },
    { at: '2026-11-17T01:26:40Z', tenant: 'callbots', slug: 'why-children-absorb-more-radiation', action: 'update', text_hash: 'h' },
    { at: '2026-11-16T19:00:00Z', tenant: 'callbots', kind: 'swarm', action: 'runner_started' },
    { at: '2026-11-15T19:00:00Z', tenant: 'callbots', slug: 'old', action: 'update' }].map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(path.join(sm, 'kb-gaps.jsonl'), [
    { at: '2026-11-16T15:04:00Z', tenant: 'callbots', question: 'Do you ship to California? Email me at jane.doe@example.com or 727-555-0142', reason: 'email_unanswered', channel: 'email', source: 'email', message_id: 'm_held' },
    { at: '2026-11-16T15:04:30Z', tenant: 'callbots', question: 'Do you ship to California? Email me at jane.doe@example.com or 727-555-0142', reason: 'email_unanswered', channel: 'email', source: 'email', message_id: 'm_held' },
    { at: '2026-11-15T15:00:00Z', tenant: 'callbots', question: 'yesterday question', channel: 'email', message_id: 'm_old' },
    { at: '2026-11-16T15:10:00Z', id: 'g1', status: 'resolved', by: 'admin' }].map(JSON.stringify).join('\n') + '\n');
  // phone-side gap the same day
  fs.writeFileSync(path.join(dir, 'kb-gaps.jsonl'), JSON.stringify({ at: '2026-11-16T17:00:00Z', tenant: 'rfsafe', call: 'c1', channel: 'voice', question: 'lowest SAR flip phone', reason: 'model_unanswered', from_last4: '0142' }) + '\n');
  return { dir, sm };
}

test('mailbox counts use the latest run and New York day boundaries', () => {
  const { sm } = site();
  const sameDay = (r) => r && r.at && require('../src/owner/config').localParts(new Date(r.at), TZ).date === require('../src/owner/config').localParts(NOW, TZ).date;
  const m = S.mailboxDay({ dir: sm, sameDay });
  assert.deepStrictEqual({ received: m.received, sent: m.sent, held: m.held, failed: m.failed, rerun: m.rerun, kbChanges: m.kbChanges }, { received: 3, sent: 1, held: 2, failed: 1, rerun: 1, kbChanges: 2 });
  assert.strictEqual(m.gaps.length, 2);
});

test('briefing: mailbox line in spoken and written copies; email gaps merged with channel email; no private data', () => {
  const { dir, sm } = site();
  const st = S.collect({ tenant, files: { kbGaps: path.join(dir, 'kb-gaps.jsonl'), sitemail: sm }, now: NOW, tz: TZ });
  const spoken = S.render(st); const written = spoken + '\n\n' + S.renderUnansweredList(st.unanswered);
  for (const text of [spoken, written]) {
    assert.match(text, /Mailbox: 3 emails received, 1 reply sent, 2 held for review, 1 failed, and 1 rerun\. 2 Brain box changes today\./);
    assert.doesNotMatch(text, /jane|doe|example\.com|SEALED|555-0142|m_held|shipping-california|why-children/i);
  }
  assert.strictEqual(st.gaps, 2);
  const email = st.unanswered.find((u) => u.channel === 'email');
  assert.ok(email); assert.match(email.question, /Do you ship to California\? Email me at \[email\]/); assert.strictEqual(email.outcome, 'draft held for review'); assert.strictEqual(email.caller_last4, null);
  assert.ok(st.unanswered.some((u) => u.channel === 'call'));
  assert.match(written, /Unanswered questions:\n1\. Do you ship to California\? Email me at \[email\] or \[number ending 0142\] \(email, 10:04 AM EST; draft held for review\)\n2\. lowest SAR flip phone \(call, 12:00 PM EST/);
  assert.match(spoken, /Two questions we couldn't answer: one, Do you ship to California/);
  assert.doesNotMatch(spoken, /yesterday question/);
});

test('missing mailbox files count as zero; no sitemail dir leaves the briefing unchanged', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-empty-'));
  const st = S.collect({ tenant, files: { sitemail: path.join(empty, 'sitemail') }, now: NOW, tz: TZ });
  assert.deepStrictEqual(st.mailbox, { received: 0, sent: 0, held: 0, failed: 0, rerun: 0, kbChanges: 0 });
  assert.match(S.render(st), /Mailbox: no email activity today\. No Brain box changes today\./);
  const off = S.collect({ tenant, files: {}, now: NOW, tz: TZ });
  assert.strictEqual(off.mailbox, null); assert.doesNotMatch(S.render(off), /Mailbox|Brain box/);
});

test('createOwner points the briefing at DATA_DIR/sitemail', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'owner', 'index.js'), 'utf8');
  assert.match(src, /sitemail: d\.sitemailDir \|\| \(d\.dataDir \? path\.join\(d\.dataDir, 'sitemail'\) : null\)/);
});
