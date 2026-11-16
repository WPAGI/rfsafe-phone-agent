# KB Light first, KB Full fallback

John Coates, Nov 16, 2026, 3:06 AM ET: "Search KB Light first, fall back to KB Full". 3:07-3:08 AM ET: "Yes, deploy KB
Light first then KB Full to callbots.org for email and phones once tests pass".

- **KB Light** = this site's Brain box: the owner-approved, locked entries shown on `/kb` (on Callbots, the 212 entries
  imported from rfsafe.app plus any the owner adds). Only enabled entries are on disk, so only they are searched.
- **KB Full** = what each channel searched before this change, unchanged and read only:
  - Mailbox (writer, checker, revise): the host's phone KB folders (`kb.host_kb_dirs`) with the Brain box on top.
  - Phone and SMS (`kb_answer` tool): the host tenant's own phone KB (on Callbots the 9,849-file bundle + curated cards).

## How a question is answered

1. Search KB Light (`src/kb.js` BM25 over the Brain box entries only).
2. If KB Light has a **good match**, return only those Light passages (an approved Light entry always wins, and fewer
   tokens go to the model). Results carry `layer: 'light'` (Mailbox) or `kb_layer: 'light'` (phone/SMS).
3. Otherwise return the KB Full result exactly as before (`kb_layer: 'full'` on phone/SMS).

## Match threshold (src/kblight.js)

- Question words = the `src/kb.js` tokens of the question, minus generic shop words (`case`, `phone`, `quantacase`,
  `safe`, …; list `GENERIC`).
- Topic groups (`EXPAND`) add topic words for a few question shapes: MagSafe, wireless charging, Canada / international,
  shipping time / West Coast, and children ("10 year old", kids, son, daughter, teen).
- A Light passage is a good match when it has **at least 2 matching words** (`min_terms`, question words plus topic
  words) **and covers at least 60% of the question words** (`min_coverage`), each question word weighted by how rare it is
  in KB Light (IDF), so missing a rare word ("talk", "staff") counts more than having common ones ("real", "person").
- A topic group is met when the passage has at least 2 of that group's topic words that are not already question words
  (all of them when fewer are left); the question words that triggered it (e.g. "10 year old", "Canada") then count as
  covered. A question that triggered any group needs at least one group met: a MagSafe question needs a passage about
  magnets or charging, a kids question one with RF Safe's recommendation. This keeps "wireless" (in almost every RF Safe
  answer) from matching a MagSafe question to an unrelated radiation entry.
- Good matches are ranked by how much of the question they cover, then by search score.
- A one-word question needs that word in the entry title.
- Extra Light passages that score under 50% of the best good match are dropped.
- `min_terms` and `min_coverage` can be set per site in `kb.light_first`.

## Switches (per channel)

Site config `kb.light_first: { mail, phone, sms, phone_tenants }`. Without it every channel is off (old behaviour), so
installing the package changes nothing on another site. Callbots: all three on, phone tenant `rfsafe`.

Env overrides, read at boot (a Render env change restarts the service): `KB_LIGHT_FIRST_MAIL`, `KB_LIGHT_FIRST_PHONE`,
`KB_LIGHT_FIRST_SMS`. `0`/`false`/`off` turns that channel back to KB Full only; `1`/`true`/`on` forces it on; unset
uses the config. `/health` shows `sitemail.kb_light_first` (`mail`, `phone`, `sms`, `light_entries`).

## Rollback

1. One channel: set `KB_LIGHT_FIRST_<MAIL|PHONE|SMS>=0` on the host (no code change).
2. Everything in the package: `SITEMAIL_ENABLED=0` (the phone line then answers from its own KB exactly as before).
3. Code: redeploy the previous commit, or revert the merge.

Nothing here writes a KB file: the KB Full folders and their checksum (`/health` → `sitemail.host_kb`) stay unchanged.
