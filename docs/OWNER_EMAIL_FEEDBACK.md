# Owner email and owner feedback (review only)

This note is the review package for the verified-owner email fix and PIN-gated feedback. It does not deploy, merge, or send anything.

## What was wrong

Checked on remote `main` at `9328e0ef697493b9e7e78e75760e009ab37f5138` (not a detached checkout).

`owner_send_email` in `src/owner/index.js` took the recipient from `newsletter.emailOnFile(tenant, ownerNumber)`. That helper returns a confirmed newsletter subscriber linked to the caller number. A verified owner with no subscriber record was skipped with `no_email_on_file`. The Nov 9 report matches that path. `tenant.owner_email` was not consulted there.

`deploy/rfsafe.tenant.json` still has `"owner_email": "SET_AT_DEPLOY"`. This repo cannot see the live tenant file, so the live address is unknown. `support_email` in that template is `support@quantaxtechnology.com`. That field was not, and is not, a fallback recipient.

Daily `sendCopies` already targets `tenant.owner_email`, and only when `owner_briefing.copy_email` is true (default false). That path was left as it is. This change does not turn on automatic email copies.

## What the code does now

Verified-owner `owner_send_email` sends only to validated `tenant.owner_email`:

- No newsletter subscription is required, and `emailOnFile` is not called.
- Missing, blank, invalid, or placeholder values (`SET_AT_DEPLOY`, `changeme`, `placeholder`, `todo`, `tbd`) fail closed. Nothing is sent. `support_email` is not used as the recipient.
- Tool fields `to`, `email`, `address`, `recipient`, `owner_email`, `reply_to`, and `replyTo` are denied. A match with the configured address is still denied. A note cannot change the recipient; addresses inside the note are redacted.
- Caller ID alone does not authorize. The session must already be an owner number (or a Grok token bound to one) and the PIN must verify. A spoofed caller on that session is `unknown_tool`.
- `asked_anything_else`, 3 emails and 3 texts per session, SMS opt-out, duplicate suppression, and the link allowlist on the body are unchanged. SMS opt-out does not block the configured owner email.
- A provider `ok: true` is recorded as `accepted` with `delivered: false`. Spoken text says the provider accepted it and that acceptance is not delivery. `replyTo` may still be the tenant `support_email` when that value is a valid address. It is a header, not the recipient.

`owner_leave_feedback` is available only after the same PIN gate:

- Instructions tell the model to ask exactly: `Would you like to leave any feedback for the team?`
- The tool requires `asked_feedback: true` and `confirmed_readback: true`. It does not store anything until both are set.
- The record is appended to `DATA_DIR/owner-feedback.jsonl` (mode 0600) and fsynced. The spoken "Saved" result is returned only after that append is read back. A throw or a missing read-back says nothing was kept and does not say saved.
- Stored fields include timestamp, call id, redacted content, `status: "unreviewed"`, `approval: false`, and `provenance: "owner_verified_call"`.
- Emails, phone numbers, card-like runs, SSNs, and 4–8 digit runs are redacted before write. Content is untrusted data.
- The tool never applies a knowledge-base edit and never sends email or text, including when the model passes `approval`, `approve_kb`, or `send_email`.
- At most 3 feedback items per session.
- Lines already in the file with `provenance: "manual"` are left in place. The read model still forces `unreviewed` and `approval: false`.

## Review feed

Two read-only views. No routine, cron, or scheduler in this repo was changed.

- `GET /admin/owner-feedback?tenant=<id>` uses the existing admin session cookie. With more than one tenant, omitting `tenant` shows no feedback rows. HTML is escaped. The master admin bearer token is not accepted.
- `GET /admin/owner-feedback.json?tenant=<id>` requires `Authorization: Bearer` with a token from `mintReviewToken` and `PA_OWNER_REVIEW_SECRET` (at least 16 characters, dedicated, not derived from `PA_ADMIN_TOKEN` or `PA_MASTER_KEY`). The token's tenant must match the query. Another tenant is 403 with an empty error and no rows. The admin token, a query-string token, a missing secret, and a POST are rejected. The feed does not write.

The 6AM / noon / 6PM review can open the dashboard page with the session it already uses, or call the JSON feed after a scoped token is issued. Issuing that token is a deploy step. This change does not edit those routines.

## Files

- `src/owner/recipient.js` — validated `tenant.owner_email` and recipient-override denial
- `src/owner/feedback.js` — redaction, durable store, scoped review tokens, read-only page
- `src/owner/index.js` — send tool, feedback tool, prompts
- `src/app.js` — read-only routes
- `src/admin.js` — dashboard link
- `src/messages.js` — "accepted by provider (delivery not confirmed)"
- `test/owner-send.test.js`, `test/owner-feedback.test.js`
- `docs/OWNER_EMAIL_FEEDBACK.md`

No change to `deploy/rfsafe.tenant.json`, knowledge-base articles, routines, or staff-hours / returns copy.

## Deployment config still required

Do this only in a later deploy review. This branch does not do it.

1. Set the live RF Safe tenant `owner_email` to the address the owner should receive. The requested address is `support@quantaxtechnology.com`. Put it in the live tenant config. Do not rely on this repository: the template value is still `SET_AT_DEPLOY`, and the code will not assume that address.
2. Confirm `owner_briefing.enabled` and the owner PIN stay as they are. Owner numbers stay the configured owner numbers. Caller ID is not enough.
3. Leave `copy_email` and `copy_sms` as they are unless a separate change turns copies on. This fix does not send automatic copies.
4. For the JSON review feed, set `PA_OWNER_REVIEW_SECRET` to a new random value that is not `PA_ADMIN_TOKEN`, `PA_MASTER_KEY`, or `PA_STATE_SECRET`. Mint one `owner_feedback:read` token per tenant with `mintReviewToken` and give it only to the review reader. Do not put the admin token in that job. Until the secret is set, the JSON feed stays closed.
5. No Resend, Twilio, or xAI call was made for this change. A provider accept on a future live send still does not prove delivery.

## Tests

`node --test ./test/owner-send.test.js ./test/owner-feedback.test.js` and the full `npm test` suite. All mail and SMS in these tests use the in-process mocks. No live send.
