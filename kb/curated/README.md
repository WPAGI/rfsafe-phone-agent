# Curated knowledge cards

Short, reviewed answers the phone bot can use. They ship with the code and load automatically for the tenant whose id matches the folder (`kb/curated/rfsafe/`). No tenant PATCH is needed.

## Add a topic (3 steps)
1. Copy `rfsafe/lifi.md` to `rfsafe/<topic>.md`. Fill `title`, one real `source:` link (rfsafe.org or quantacase.com), and `aliases:` (other words or spoken spellings callers use). Write 2-4 short paragraphs in plain words, taken only from real sources. No invented studies, figures or PMIDs.
2. Add the caller's question to `rfsafe/coverage.json` with an `expect` word the answer must contain.
3. Run `npm test` (includes the coverage check), open a PR, and deploy after John approves.

## Finding gaps
Every question the bot could not answer is logged to `kb-gaps.jsonl` on the data disk. Download it from the admin dashboard: "Unanswered questions (CSV)" (`/admin/kb-gaps.csv`). Turn recurring ones into cards, or hand them to Research Bot first.

Check coverage any time: `node scripts/kb-coverage.js rfsafe demo/kb/rfsafe-live`

## Full Second Brain export (wiki + rfsafe.org study pages)
Built on the box, never committed (the wiki is private and ~58 MB):
1. `node scripts/export-wiki-kb.js /workspace/brain/wiki /workspace/code/rpa-kb-bundle/rfsafe-wiki.jsonl.gz --dir /workspace/code/rpa-kb-bundle/rfsafe-wiki`
   Includes answers/, position/, topics/ (RF Safe categories), research/ (incl. 1,465 rfsafe.org study pages and the harm graph) and John's original/quote X posts and Articles. Skips replies, off-topic categories and creator/x-money pages. Adds an allowlisted `source:` link per page.
2. Check: `KB_WIKI_DIR=/workspace/code/rpa-kb-bundle/rfsafe-wiki npm test` and `node scripts/kb-coverage.js rfsafe --wiki /workspace/code/rpa-kb-bundle/rfsafe-wiki`.
3. Upload (only with John's approval, after the code is deployed):
   `curl -X PUT -H "authorization: Bearer $(cat /workspace/.pa_secrets/admin)" -H "content-type: application/gzip" --data-binary @/workspace/code/rpa-kb-bundle/rfsafe-wiki.jsonl.gz https://callbots.org/admin/tenants/rfsafe/kb-bundle`
   The server unpacks it to `/var/data/kb/rfsafe-wiki` on the Render disk (atomic swap), reloads the index, and loads it automatically on every restart. No tenant PATCH and no redeploy needed for content refreshes; rerun steps 1-3 whenever the wiki grows.
