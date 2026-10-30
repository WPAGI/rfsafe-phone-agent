# Changelog
## v0.2.0 (2026-10-30)
- Production path for the Render service: landing page, `/health`, authenticated `/admin` readiness checklist, Twilio voice fallback, SMS status callbacks, call-end log, link-text rate limits, website lookup, disk seeding, live-mode startup errors, SIGTERM, and outbound timeouts.
- `scripts/provision-number.js` prints the xAI and Twilio setup and does not call those APIs unless `--apply` is passed. The server never runs it.
- `GO-LIVE.md` is the checklist for the day the Twilio number is paid for. `PA_MODE` stays `demo` until then.
- Test script is `node --test ./test/*.test.js` because Node 22 does not run `node --test test/`.

## v0.1.0 (2026-10-29)
- First pilot build. Tool server, xAI SIP bridge, SMS guard, read-only Shopify client, KB tool, multi-tenant registry with encrypted secrets, mocked click-to-connect onboarding, demo with EXAMPLE data, and 27 tests.
- Not deployed. No accounts were created and no real APIs were called.
- Known unknowns: the xAI webhook signature scheme (Standard Webhooks assumed), xAI billing after a REFER, and Node `WebSocket` header support against the live xAI endpoint. All are to be checked on the first test call.
