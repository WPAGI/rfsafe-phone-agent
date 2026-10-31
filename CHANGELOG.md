# Changelog
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
