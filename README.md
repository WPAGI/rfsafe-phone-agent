# RF Safe phone agent (product version: `VERSION`)

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
| `src/sms.js` | inbound SMS brain (mock or grok-4.7) plus reply guard |
| `src/twilio.js` | Twilio signature check, consent ledger (STOP/START/HELP), REST and mock |
| `src/tenants.js` | tenant registry plus AES-256-GCM per-tenant secret store |
| `src/onboarding.js` | signed OAuth state, Shopify authorize/callback, readiness checklist |
| `demo/` | EXAMPLE tenants (RF Safe, Acme Bakery), EXAMPLE KB, `run-demo.js` |
| `deploy/` | `render.yaml`, `env.example` (names only), RF Safe tenant config |
| `DESIGN.md`, `DEPLOY.md`, `RESEARCH.md`, `WIKI_PAGE.md`, `CHANGELOG.md` | docs |
| `docs/OWNER_EMAIL_FEEDBACK.md` | verified-owner email recipient, PIN-gated feedback, read-only review feed, deploy config still required |
| `docs/WARRANTY_CHECK.md` | $20 replacement / warranty past-order model check: Mailbox (order index on), phone and text (`warranty_check`, only with `order_lookup_enabled`) |

## Interim texting (important)
Until A2P 10DLC texting is approved on the new number, every tenant ships with `sms_enabled: false`. The `send_link` tool tells the caller that texting is not on yet and offers to read the link aloud instead.

**Meanwhile, the existing Grok Bot Text & Voicemail bot keeps handling texts through Google Voice/Gmail. That path can only reply to people who texted first.** It cannot start a text to a caller.

## Secrets
Secrets come only from env vars or from the encrypted store (`PA_MASTER_KEY`). Tenant files hold references (`env:NAME` / `store:KEY`), never values. `.env`, `data/` and `*.enc.json` are excluded from git and from the zip, and the build fails if the secret scan finds anything.


## Unified admin (/admin)
One sign-in for the whole admin (John, Nov 16, 2026, 9:13-9:22 PM ET). It covers calls, texts, subscribers, the Mailbox and the Brain box.
- **Sign in** at `/admin/login`. Press the button and a one-time link goes to the fixed admin address (`ADMIN_LOGIN_EMAIL`, default support@quantaxtechnology.com). The link works once, expires in 15 minutes, and at most 3 are sent per 15 minutes. The session lasts 12 hours. No new env vars or secrets are needed.
- **Home** (`/admin`) shows icon tiles grouped as Callbots, People, Mailbox and Downloads. Every admin page has the same left nav in the Mailbox colors (dark or light, following the device). On screens 980 px or narrower, the nav becomes the Mailbox's horizontally scrollable top menu, using the same CSS. There is no hamburger.
- **Pages** (the old one-page dashboard, split up):
  - `/admin/calls`: call log, filters, CSV.
  - `/admin/channels`: texting, email and instant-text switches, with the change log.
  - `/admin/newsletter`: counters, table, CSV.
  - `/admin/subscribers`: search, edit, unsubscribe, merge, delete, audit log.
  - Unchanged: `/admin/messages?type=sms|email`, `/admin/outbound`, `/admin/owner-feedback` and `/admin/usage`.
- **One session.**
  - The Mailbox and Brain box tiles (`/admin/go/inbox`, `/admin/go/kb`) hand the admin session to `/inbox`. `/admin/mail` already did the same for `/mail`.
  - `/inbox/login` sends you to the admin sign-in and then back to where you were going.
  - Signing out anywhere ends the session everywhere.
  - The Mailbox no longer uses `SITEMAIL_SESSION_SECRET` for sessions. That value stays set but is now unused, and Mailbox sessions from before this change end (sign in again once).
- **Fallbacks kept:**
  - The Bearer admin token still opens the data pages, the CSVs and the JSON APIs.
  - `/mail/login` still has its own form, which signs in through the same session store.
  - The Site Mail key APIs (`/admin/kb/entries`, `/admin/mail/messages`, rerun) are unchanged.
- **Old links still work:**
  - `/admin?from=&to=&number=` redirects to `/admin/calls`.
  - `/admin?err=` redirects to `/admin/channels`.
  - Every other admin URL still answers.
- **Feature list:** every feature, with its new page and its test, is in `FEATURE_PARITY.md`. `test/unified-admin.test.js` fails if an id in that list has no test.
- **Changed tests:** five older test files now read the new page instead of the old one-page `/admin` (admin, channel-toggles, sent-messages, sitemail-mount). Their assertions are the same. Design note: `docs/UNIFIED_ADMIN.md`.

## Product version

The product version lives in one place: the `VERSION` file at the repo root, read by `src/version.js`. `/health` (`product_version`), the admin footer (every admin page) and the Edge testing page all show it from there; `package.json` mirrors it (a test fails if they differ).

Semver, starting at **1.0.0**:
- **Patch** (1.0.1): small fixes and prompt tweaks.
- **Minor** (1.1.0): new features.
- **Major stays 1** while the product is in beta.

Bump `VERSION` and `package.json` together in the PR that makes the change. The **prompt version** in `vendor/sitemail/src/mailbox/bot-defaults.js` (for example 1.9.27) is separate fine print: it is recorded on each Edge testing run but is never shown as the product version. A rerun with no software change stays on the same product version and gets the next run number (for example `1.0.0 run 3, prompts 1.9.27`).

## Edge testing (/admin/edge-testing)

A tile in the Mailbox section of the admin home and an item in the left nav. Saved edge-case emails, rerun as a **dry run** through the real Mailbox sorter, writer and checker; nothing is sent. Design note, guarantees and cost cap: [docs/EDGE_TESTING.md](docs/EDGE_TESTING.md). Seed: `seeds/edge-tests/callbots.org.json` (built with `scripts/edge-seed.js`, PII-redacted).

## Private Mail inbox (/mail)

Owner-only, read-only viewer for mail received at `@callbots.org` (Resend received emails, plus any Resend Inboxes on that domain, merged and deduped, filtered server-side by `MAIL_DOMAINS`). Sign-in is the existing admin magic link to the fixed admin address (`ADMIN_LOGIN_EMAIL`), from `/mail/login` or the admin dashboard link (`/admin/mail`). Reads with `RESEND_MAIL_READ_KEY`; the existing send key only sends the sign-in link. Design, env and drop-in notes: `src/mail/README.md`.
