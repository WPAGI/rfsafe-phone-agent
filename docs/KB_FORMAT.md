# RF Safe KB bundle format, v1 (`rfsafe-kb`)

One standard file that the Second Brain export, Research Bot, and anyone else produces, and the phone bot loads.

## File
- Name: `rfsafe-kb.v1.jsonl.gz`. It is gzipped UTF-8 JSON Lines.
- Line 1 is the **header**: `{"format":"rfsafe-kb","version":1,"tenant":"rfsafe","generated":"<ISO time>","producer":"<who>","count":<cards>}`
- Every other line is one **topic card**. Card ids are unique within a bundle.

## Topic card
| field | type | rule |
|---|---|---|
| `id` | string | stable, lowercase, `[a-z0-9._/-]`, no `..`. Prefix by producer: `wiki/...` (Second Brain), `research/...` (Research Bot), `curated/...`. Same id = same topic; a newer card replaces the older one. |
| `kind` | string | one of `curated, position, answer, topic, study, harm-node, research, article, post, research-finding` |
| `title` | string | 1-300 chars, plain words a caller might use |
| `position` | string | RF Safe's position on this topic, in plain words (≤4000 chars). `""` only if none is stated in the source. Never invented. Read aloud first. |
| `body` | string | the supporting text (≤200,000 chars), Markdown allowed |
| `sources` | string[] | real `https://` links only, from: rfsafe.org, quantacase.com, doi.org, pubmed.ncbi.nlm.nih.gov, ncbi.nlm.nih.gov, ntp.niehs.nih.gov, x.com. `research-finding` cards need at least one. The bot only texts or emails rfsafe.org and quantacase.com links. |
| `aliases` | string[] | other words or spoken spellings ("lie fi", "sell m", "PL 90-602") |
| `updated` | string | `YYYY-MM-DD` date the content last changed |
| `producer` | string | optional: `second-brain`, `research-bot`, ... |

Rules: no invented studies, figures, quotes or PMIDs. Every number in `position` or `body` must appear in a listed source. Disclose RF Safe's commercial interest (cases, John's Li-Fi patent US11700058B2) where relevant.

Example card (one line in the file):
```json
{"id":"research/lifi-ieee-802-11bb","kind":"research-finding","title":"IEEE 802.11bb Li-Fi standard","position":"RF Safe supports moving indoor data to light (Li-Fi) and wires.","body":"...","sources":["https://rfsafe.org/class/start/"],"aliases":["lifi","light fidelity"],"updated":"2026-10-30","producer":"research-bot"}
```

## Producing
- **Second Brain:** `node scripts/kb-sync.js /workspace/brain/wiki /workspace/code/rpa-kb-bundle --inbox /workspace/code/rpa-kb-bundle/inbox`
  - Rebuilds from `answers/ position/ topics/ research/` (rfsafe.org study pages and the harm graph) and John's original and quote X posts and Articles. It skips replies, off-topic categories and creator/x-money pages.
  - It merges any Research Bot cards found in `inbox/`.
  - It diffs against the last bundle. If nothing changed, it says "no changes" and writes nothing.
  - Otherwise it writes the single file `rfsafe-kb.v1.jsonl.gz`, keeps the old one in `history/`, and writes `diff-<UTC stamp>.md` (added/changed/removed) for review.
  - Safe to run on a schedule.
- **Research Bot:** write cards as JSON Lines (one card per line, header optional) to `/workspace/code/rpa-kb-bundle/inbox/<date>-<topic>.jsonl`. Ids start with `research/`. The next sync validates them; a bad card stops the sync with the reason.
- Validate any file: `node -e "require('./src/kbformat').decode(require('fs').readFileSync('FILE'))"`

## Checking
- `KB_BUNDLE=/workspace/code/rpa-kb-bundle/rfsafe-kb.v1.jsonl.gz npm test`. This runs the named-topic coverage questions in `kb/curated/rfsafe/coverage-wiki.json` and checks that search stays under 100 ms.
- `node scripts/kb-coverage.js rfsafe --wiki /workspace/code/rpa-kb-bundle/rfsafe-kb.v1.jsonl.gz`

## Loading onto the phone bot (only with John's approval)
1. The code with the `kb-bundle` endpoint must be deployed first.
2. Upload (admin token, never printed):
   `curl -sS -X PUT -H "authorization: Bearer $(cat /workspace/.pa_secrets/admin)" -H "content-type: application/gzip" --data-binary @/workspace/code/rpa-kb-bundle/rfsafe-kb.v1.jsonl.gz https://callbots.org/admin/tenants/rfsafe/kb-bundle`
3. The server checks every card before touching the disk. It then unpacks the bundle to `/var/data/kb/rfsafe-wiki/` on the Render persistent disk with an atomic swap, reloads the index, and replies `{pages, version, generated}`.
4. The bundle is loaded again on every restart. Content refreshes need no redeploy and no tenant PATCH.
5. Rollback: re-upload a file from `history/`.

Not in git: the bundle (private wiki, ~6 MB gz). Short curated cards in `kb/curated/rfsafe/*.md` ship with the code.
