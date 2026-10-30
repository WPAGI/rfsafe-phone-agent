# RF Safe phone agent: v0.2.0

Demo mode is what runs on Render until `GO-LIVE.md`. Do not set `PA_MODE=live` until that checklist is done.

This is an AI phone agent for RF Safe / QuantaCase. **Grok Voice (Direct SIP)** answers calls on a **new Twilio number**. Its tools run on **our own tool server**:
- read-only Shopify product lookup;
- KB answers grounded in the brain wiki and rfsafe.org;
- link-only SMS, allowlisted **in code** to `quantacase.com` and `rfsafe.org`;
- transfer to a human during business hours, or take a message.

**There are no payments, ever.** No tool can take or read card data. Card-like numbers are refused in every tool argument and every outbound text.

The server is multi-tenant, and each business connects through click-to-connect onboarding. Onboarding is mocked in the demo.

## Quick start (no accounts, no network)
```bash
node --version      # needs >= 22
npm test            # node:test, zero dependencies
npm run demo        # full mocked call + SMS walkthrough with EXAMPLE DATA
npm run build       # dist/rfsafe-phone-agent-v0.1.0.zip + .sha256 (secret-scanned)
```

## Layout
| Path | What |
|---|---|
| `src/app.js` | HTTP routes: `/`, `/health`, `/admin`, xAI webhook, Twilio SMS, SMS status, voice fallback, admin, onboarding |
| `GO-LIVE.md` | Steps and env vars for the day the Twilio number is paid for |
| `scripts/provision-number.js` | Dry-run (or `--apply`) xAI number registration and Twilio SIP trunk |
| `src/xai.js` | webhook verify, session config and guardrail instructions, realtime bridge, call control |
| `src/tools.js` | the 7 agent tools plus the approvals queue |
| `src/linkguard.js` | **SMS guard**: URL allowlist, payment/card/length checks |
| `src/shopify.js` | read-only Shopify client (public JSON or Storefront GraphQL queries only) |
| `src/kb.js` | BM25 KB over Markdown, returns allowlisted source links only |
| `src/sms.js` | inbound SMS brain (mock or grok-4.3) plus reply guard |
| `src/twilio.js` | Twilio signature check, consent ledger (STOP/START/HELP), REST and mock |
| `src/tenants.js` | tenant registry plus AES-256-GCM per-tenant secret store |
| `src/onboarding.js` | signed OAuth state, Shopify authorize/callback, readiness checklist |
| `demo/` | EXAMPLE tenants (RF Safe, Acme Bakery), EXAMPLE KB, `run-demo.js` |
| `deploy/` | `render.yaml`, `env.example` (names only), RF Safe tenant config |
| `DESIGN.md`, `DEPLOY.md`, `RESEARCH.md`, `WIKI_PAGE.md`, `CHANGELOG.md` | docs |

## Interim texting (important)
Until A2P 10DLC texting is approved on the new number, every tenant ships with `sms_enabled: false`. The `send_link` tool tells the caller that texting is not on yet and offers to read the link aloud instead.

**Meanwhile, the existing Grok Bot Text & Voicemail bot keeps handling texts through Google Voice/Gmail. That path can only reply to people who texted first.** It cannot start a text to a caller.

## Secrets
Secrets come only from env vars or from the encrypted store (`PA_MASTER_KEY`). Tenant files hold references (`env:NAME` / `store:KEY`), never values. `.env`, `data/` and `*.enc.json` are excluded from git and from the zip, and the build fails if the secret scan finds anything.
