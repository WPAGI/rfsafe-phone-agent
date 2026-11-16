# Changelog
## Mailbox "System notes for this email" (Nov 16, 2026; John 12:14 PM ET)
- Callbots.org mailbox only. One block placed right under the customer's email, for the writer and the checker: "System notes for this email" / "Added automatically by our system, not written by the customer. Use these facts when replying." It replaces the separate QuantaCases block and order note. It has two sections: "QuantaCases for phones mentioned in this email" (the catalog) and "Orders on file for this sender".
- Email-matched orders show the number, status, tracking and the ordered items (product and color). Items are fetched live through STATUS_QUERY `lineItems` at reply time and are not stored in the index. The section also lists the other in-stock colors, price and link for the ordered phones. A phone-only match stays unverified and shows no details. No address or payment details ever appear.
- A processing order plus a different-color request: the writer offers to switch the order before it ships, and the checker fails a mail-it-back reply. The return-address check is skipped when the switch is offered.
- Sign-off "The RF Safe team": brand.json `mailbox.signoff` plus a prompt_replace for the old "a sign-off from the site team" wording, which let the model pick "The QuantaCase Team". A trailing "<Name> Team" line is also corrected in code. Prompt defaults are now 1.9.24.
- Phone and text paths and `order_lookup_enabled` are unchanged.
## Mailbox past-customer order index (Nov 16, 2026; REVIEW ONLY — do not merge or deploy without John's OK)
- Callbots.org mailbox only: an optional (`SITEMAIL_ORDER_INDEX`, default off) index of past Shopify orders, keeping only first name, order number, email (lowercased) and phone (E.164). Every record is marked unsubscribed from email and text and is never used for marketing. Stored sealed on the persistent disk with mode 0600; never in git, logs, /health, admin pages, or any public GET route. Phone and text lookup paths and `order_lookup_enabled` are unchanged.
- Updates: HMAC-verified `orders/create` receiver (not registered at Shopify in this PR) plus a light incremental sync every few hours. On each inbound email, a system note is given to the writer and checker only. An order is treated as the sender's only when the sender email matches; a phone-only hit is unverified and includes no order numbers, status or tracking.
- Off until John approves go-live: deploy, flag on, webhook registration, and order lookup.

## Mailbox QuantaCase catalog, daily refresh plus live stock (Nov 16, 2026; John approved deploy 4:11-4:21 AM ET)
- Callbots.org mailbox only: the full QuantaCase catalog (models, colors, price, stock, product and variant URLs) is cached in the Site Mail data dir and refreshed daily, with a refresh on a miss. The last good cache is kept if a refresh fails. Phone and text lookup paths are unchanged. Order lookup stays off.
- Before the writer runs, every phone model named in the email is matched (aliases such as "17 Pro Max", "S26 Ultra", and "wife's 17 Pro Max") and those products get a short live stock check. A titled block, "QuantaCases available for phones mentioned in this email", is given to the writer and the checker. The checker verifies against that block; existing store checks stay as fallback. A single Default Title variant is Black, one color.
- Cached model and variant counts are shown on `/health` (`sitemail.phone_catalog`) and on `GET /admin/mail/kb-coverage`. No secrets. The "The RF Safe team" sign-off and KB Full files are unchanged.

## Always include store facts for a named phone model (Nov 16, 2026; John 3:55-3:56 AM ET)
- When an email names a phone model the store carries, the reply must include that case's colors, price, stock and product link, even if a KB Light answer (for example MagSafe) covers another question. The checker fails a reply that leaves those facts out and supplies them as an edit so the revise loop can add them. The "The RF Safe team" sign-off is unchanged.
- Dave-style two-model color/price/stock replies still pass.

## Mailbox store lookup and checker fixes (Nov 16, 2026; John approved deploy 3:35 AM ET, phone-path note 3:37 AM ET)
- Every phone model in an email gets its own store lookup. The mailbox uses the same Shopify path as the phone and text agents (`ShopifyClient.searchProducts`, plus the phone Admin query for orders when order lookup is already on). A missed model is checked read-only at its public product page. "We do not carry" is only allowed when the model's search and its page both came back empty. A lookup miss is never treated as "we don't carry it." The checker fails any other "don't carry" claim and supplies the store facts as an edit so the revise loop can fix it.
- The checker fails a "the team will follow up" deferral when KB Light, KB Full or the store answers the logged gap, and adds the fact as an edit, so the revise loop runs.
- Phone product search also probes brand-prefixed handles (`apple-iphone-17-pro-max`) when the catalog handle includes the brand.

## KB Light first, KB Full fallback (Nov 16, 2026; John approved deploy 3:07-3:08 AM ET)
- Mailbox (writer and checker KB tool), phone `kb_answer` and texts search KB Light (the Callbots Brain box on /kb) first. A question with no good Light match is answered by KB Full (the phone KB) exactly as before. Rule and switches: `vendor/sitemail/port/KB_LIGHT.md`.
- On by default for mail, phone and SMS, tenant `rfsafe` only (`vendor/sitemail/site.config.js`). Env `KB_LIGHT_FIRST_MAIL`, `KB_LIGHT_FIRST_PHONE` or `KB_LIGHT_FIRST_SMS` = `0` turns one channel off; `SITEMAIL_ENABLED=0` turns Site Mail off. KB Full files are read only. `/health` shows `sitemail.kb_light_first`.

## Owner email and feedback (unreleased, review only)
- Verified-owner `owner_send_email` uses validated `tenant.owner_email` and fails closed when that value is missing, invalid, or still `SET_AT_DEPLOY`. It no longer requires a newsletter subscriber. Caller-supplied recipients are denied. Provider acceptance is not described as delivery.
- PIN-gated `owner_leave_feedback` appends unreviewed feedback (`approval: false`) for one tenant after a read-back, and says it was saved only after the append is durable. It does not edit the knowledge base or send email. `GET /admin/owner-feedback` (session) and `GET /admin/owner-feedback.json` (scoped review token, not the admin token) are read-only. See `docs/OWNER_EMAIL_FEEDBACK.md`. Live `owner_email` is still a deploy setting.

## Owner briefing module (unreleased)
- New isolated `src/owner/` module, off unless `owner_briefing.enabled` is true for the tenant. It adds the daily PIN-gated briefing call, urgent alerts with rate limits and quiet hours, the on-demand briefing for owner numbers, transfer fallback and an optional Twilio transfer bridge, and owner-call archive and audit logs. Admin: `owner_briefing` in the PATCH list, plus `/owner-pin` and `/owner-briefing`. See GO-LIVE.md.

## v0.2.0 (2026-10-30)
- Public `/` is the CallBots marketing page (title, canonical, Open Graph, JSON-LD, FAQ). `/robots.txt`, `/sitemap.xml`, and `/favicon` are served from the app. `/health`, `/admin`, and webhooks are unchanged.
- Homepage design pass: brand mark, light and dark palettes, sticky nav with a mobile menu, hero illustration, icon feature cards, and a three-step flow. SEO tags stay in place.
- Production path for the Render service: landing page, `/health`, authenticated `/admin` readiness checklist, Twilio voice fallback, SMS status callbacks, call-end log, link-text rate limits, website lookup, disk seeding, live-mode startup errors, SIGTERM, and outbound timeouts.
- `scripts/provision-number.js` prints the xAI and Twilio setup and does not call those APIs unless `--apply` is passed. The server never runs it.
- `GO-LIVE.md` is the checklist for the day the Twilio number is paid for. `PA_MODE` stays `demo` until then.
- Test script is `node --test ./test/*.test.js` because Node 22 does not run `node --test test/`.

## v0.1.0 (2026-10-29)
- First pilot build. Tool server, xAI SIP bridge, SMS guard, read-only Shopify client, KB tool, multi-tenant registry with encrypted secrets, mocked click-to-connect onboarding, demo with EXAMPLE data, and 27 tests.
- Not deployed. No accounts were created and no real APIs were called.
- Known unknowns: the xAI webhook signature scheme (Standard Webhooks assumed), xAI billing after a REFER, and Node `WebSocket` header support against the live xAI endpoint. All are to be checked on the first test call.

## News-text opt-in (unreleased)
- Voice: when texting a link, the bot may ask once about RF Safe breaking-news texts; on a spoken yes the text adds a reply-YES invite with frequency (up to 4 msgs/mo), "Msg & data rates may apply", HELP/STOP. Subscribed only after the YES reply; STOP cancels.
- One newsletter list joins email and caller-ID phone, with separate email_optin / sms_optin and proof (time, call id, wording shown, YES reply). Existing text subscribers are recognized. Admin stats + CSV columns. Privacy/Terms SMS section updated.
- This bot sends no news texts; a separate newsletter tool will.
