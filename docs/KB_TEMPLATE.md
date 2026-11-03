# Per-business KB (`callbots-kb` v1)

Same file layout as `rfsafe-kb` (docs/KB_FORMAT.md): gzipped JSON Lines, header line then one card per line.
Header: `{"format":"callbots-kb","version":1,"tenant":"<id>","generated":"<ISO>","producer":"<who>","count":N}`.

Differences from `rfsafe-kb`:
- `kind` is one of `business, product, service, pricing, faq, policy, escalation`.
- Every card needs at least one source, and every source must be on the tenant's `brand.kb_allow_domains`.
- A card with an empty body and empty position is rejected (no placeholders).
- The bundle's `tenant` must match the tenant it is uploaded to. Tenants without a `brand` block cannot load it.
- `position` is read aloud as "<team name>'s answer: ...".

Start from `kb/template/` (empty, so the bot says "I don't have that yet" and logs a gap). Check and pack:
`node scripts/kb-template.js check kb/<id>` and `node scripts/kb-template.js bundle kb/<id> <id> out.jsonl.gz`.
Upload uses the same `PUT /admin/tenants/<id>/kb-bundle` endpoint, only with the owner's approval.
