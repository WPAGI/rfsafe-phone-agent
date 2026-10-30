# Changelog
## v0.1.0 (2026-10-29)
- First pilot build. Tool server, xAI SIP bridge, SMS guard, read-only Shopify client, KB tool, multi-tenant registry with encrypted secrets, mocked click-to-connect onboarding, demo with EXAMPLE data, and 27 tests.
- Not deployed. No accounts were created and no real APIs were called.
- Known unknowns: the xAI webhook signature scheme (Standard Webhooks assumed), xAI billing after a REFER, and Node `WebSocket` header support against the live xAI endpoint. All are to be checked on the first test call.
