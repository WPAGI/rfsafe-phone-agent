# Curated knowledge cards

Short, reviewed answers the phone bot can use. They ship with the code and load automatically for the tenant whose id matches the folder (`kb/curated/rfsafe/`). No tenant PATCH is needed.

## Add a topic (3 steps)
1. Copy `rfsafe/lifi.md` to `rfsafe/<topic>.md`. Fill `title`, one real `source:` link (rfsafe.org or quantacase.com), and `aliases:` (other words or spoken spellings callers use). Write 2-4 short paragraphs in plain words, taken only from real sources. No invented studies, figures or PMIDs.
2. Add the caller's question to `rfsafe/coverage.json` with an `expect` word the answer must contain.
3. Run `npm test` (includes the coverage check), open a PR, and deploy after John approves.

## Finding gaps
Every question the bot could not answer is logged to `kb-gaps.jsonl` on the data disk. Download it from the admin dashboard: "Unanswered questions (CSV)" (`/admin/kb-gaps.csv`). Turn recurring ones into cards, or hand them to Research Bot first.

Check coverage any time: `node scripts/kb-coverage.js rfsafe demo/kb/rfsafe-live`
