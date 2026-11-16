# Brain box growth loop and coverage metric

John, Nov 16 12:37 AM ET: keep the bots on the big phone KB for now, grow the compact Brain box from real questions,
and measure how often the Brain box alone would have been enough. The switch to Brain box only is John's decision.

## What runs (modules.kb_growth, src/mailbox/kbgrowth.js)

An observer on the Mailbox writer. It is called after the writer saves a draft (`reply: drafted`) or logs a KB gap
(`reply: kb_gap`). It never changes a draft, a send decision, a live Brain box entry or a host KB file. An error in it is
ignored by the pipeline.

## Coverage method

Per email the writer handles:

1. Query: the subject + the first 300 characters of the text (the writer's own first KB query), plus each KB-gap question.
2. Search the combined KB the bots use today (host phone KB read-only, Brain box entries on top), top 5.
3. A hit counts as **Brain box** when its title is a live, enabled Brain box entry title; otherwise **big KB**.
4. State: `brain_box` when a Brain box hit ranks first, or is in the top 3 with a score of at least 80% of the top
   score; `big_kb` when not; `none` when no hit; `kb_gap` when the writer logged a gap.
5. **Brain box alone could have answered** = state `brain_box` and a reply was drafted.
   Running share = answerable / questions.

Where to read it: `GET /admin/mail/kb-coverage` with the Mailbox read key (counts, method, the last 50 log rows with
titles only, the seed import result), and `brain_box_coverage` { questions, share } in the host `/health` status.
Files: `DATA_DIR/<namespace>/kb-growth/coverage.json` and `growth-log.jsonl` (no email text, no addresses).

## Growth loop

Only when the state is `big_kb` and a reply was drafted (the big KB carried the answer): propose ONE compact Brain box
entry built from the top big-KB page, through the existing review inbox (`kbadmin store.propose`, actor
`Phone KB growth loop`, a bot edit that needs both reviews and a publish like any other suggestion).

- Text: the page's public text (the /kb adapter's filtered copy), first paragraphs up to 1,500 characters, wording
  unchanged. Source: the page's own https source, else its callbots.org/kb page.
- Never proposed when: bot auto-publish is ON, the Brain box already has the slug, an open proposal exists, it was
  proposed before, the text fails the public privacy filters (instructions, keys, private numbers or emails), the daily
  cap is reached (kb.growth.proposals_per_day, default 10), or the entry is locked (store.propose refuses, or routes
  it to Locked / For John when suggestions are allowed).
- Every outcome is logged (growth-log.jsonl) and shown in the email's activity as a `kb_growth` step.

## Phone calls (design note, not built)

Hooking live calls would need a change in the phone agent's call path, which John asked to leave unchanged. The
passive option, not built: a reader that tails the host's call records (`DATA_DIR/call-records.jsonl`) read-only
with a saved offset, pulls the caller questions, and feeds them to the same coverage + growth functions. Call records
hold transcripts, so this needs John's OK on privacy first (redaction before anything is logged or proposed).

## Seed import (kb.seed_import)

One-time, additive copy of an exported public KB (e.g. rfsafe.app's) into this site's Brain box as owner-approved
entries (so they start locked). Existing slugs are never touched; a marker (`kb-seed-import.json`, with the seed's
sha256) stops a second run. The source site is never written. Symptom-map entries are skipped by the Brain box
validator because the public feed carries only their reader text; they still show on /kb from the seed layer.
