# Edge testing (design note, Nov 18, 2026)

**Asked (John, Nov 17, 2026, 10:36 PM ET, relayed by Jarvis):** product versioning, and an "Edge testing" admin page that reruns the saved edge-case emails as a dry run, shows old and new replies side by side, and carries an agent grade and a human review. **Build-only approval:** PRs with tests and screenshots, no merge or deploy until John approves.

## Product version
- One source: `VERSION` (repo root), read by `src/version.js`. Starts at **1.0.0**. Shown in `/health` (`product_version`), every admin page's footer and the Edge testing page. `package.json` mirrors it; `test/edge-testing.test.js` fails if they drift.
- Semver: patch for small fixes and prompt tweaks, minor for features, the major stays 1 through beta. Rules are in `README.md` → Product version.
- The prompt version (`vendor/sitemail/src/mailbox/bot-defaults.js`, now 1.9.27) is recorded on every run as fine print, with "(custom replier)" etc. when a saved Custom layer is in use. It is never shown as the product version.

## The page (`/admin/edge-testing`)
- **Sign-in:** the existing unified-admin session cookie (`pa_admin`, magic link, PR #74). No Bearer token and no new auth path. Without a session, JSON gets 401 and a browser is sent to the sign-in page. Every POST checks the session CSRF token and the same-origin rule, like the other admin forms.
- **Navigation:** a tile in the Mailbox section of the admin home and an item in the left nav, both drawn from `src/adminui.js` `SECTIONS`. They are hidden when the Site Mail package is off. The page uses the unified admin layout (Mailbox CSS); at ≤980px the nav becomes the scrollable top menu and the comparison stacks into one column. No scripts. Product version is in every admin page's footer (`src/adminui.js`).
- **List view:** for each saved test, the email on top and the newest reply directly under it, with chips for the run tag (for example `1.0.0 run 2, prompts 1.9.27`), what would happen (Sent, Would send, Held), the checker verdict, the baseline pass/fail, the agent grade against the baseline, and the human review. Filters: All, Checker or baseline fail, Agent: worse, Needs human review.
- **Compare view** (`?test=<id>&vs=<run>`): full email, expected behavior, newest reply, then a clickable list of every version and run of that test. The chosen earlier run sits side by side with the current reply. Below them are the agent grade (or a "Grade with agent" button) and the human review form (pass/fail plus a note).
- **Rerun edge testing:** one button. It shows the estimated model cost and the edge-run cap first. While a run is going, the page shows a progress bar, the test now running and the cost so far, and refreshes every 5 seconds (`Refresh` header).
- **Adding tests:** an "Add a test email" form and an "Import tests (JSON)" box. Both go through the same PII redaction as the importer.

## Why a dry run cannot send (by construction)
`vendor/sitemail/src/edgetest/runner.js` builds a brand-new `MailBots` per test. It is the same class, prompts and checker the Mailbox uses, including the deterministic backstops and the revise loop.
- **Own store:** a fresh `MailboxStore` in a temp folder, with a new random encryption key. It is deleted after each test. The live Mailbox store, its threads, drafts, sent log and settings are never handed to the runner.
- **No sender:** `autoSend` is a spy that only records "would send". The runner has no mail client, no Resend key and no send function. `createDraft` writes only to the temp store.
- **No other writes:** no `onReplied`, `kbGap`, web research or newsletter writes. The newsletter check is a stub that returns "not a subscriber", so the footer matches.
- **Orders off:** no order lookup or order index, `connectedForOrders()` is false, and the Shopify `order_status` and `inventory` actions are refused. `env` holds only `XAI_API_KEY`, so the order-lookup flag is off too. Test order #1173 can never be touched.
- **HTTP allowlist (`guardFetch`):** only `POST api.x.ai/v1/chat/completions`, `GET api.x.ai/v1/language-models|models`, and token-free `GET` of the public storefront (`quantacase.com` / `rfsafe.com` `/products/<handle>.js` and `/search/suggest.json`). Everything else gets a 451 without reaching the network and is counted on the run: Resend and other mail APIs, Shopify Admin, `*.myshopify.com`, any store POST, any request carrying a token, and Twilio.
- **Store lookups:** read-only public storefront data. Stock counts are not available there, so `in_stock` is null; availability and prices are real.
- **Proved by tests (`test/edge-testing*.test.js`):**
  - the real send spy and draft spy stay at 0;
  - the live mailbox file hash and its threads are unchanged;
  - every outbound call went to `api.x.ai`;
  - mail API writes during an HTTP rerun stay at 0, and the live sent log is empty;
  - each refused URL never reached the network;
  - order actions throw.

## Cost cap (choice: a separate small cap)
- **Cap:** edge runs have their own cap of **$15 per site per New York day** (`DAILY_CAP_USD` in `vendor/sitemail/src/edgetest/index.js`). It is separate from the live Mailbox's monthly bot budget and does not count against it, so a rerun can never pause real mail.
- **Before a run:** if the estimate is over what is left of today's cap, the run is refused. The estimate is tests × per-test cost: $0.15 per test plus $0.01 for its grade until a finished run gives a real average, after which that run's average is used.
- **During a run:** each test's pipeline gets the remaining budget as its hard cap (MailBots reserves the worst case before every model call). When it runs out, the rest are marked "Skipped: cost cap" and the run ends as `stopped_cost_cap`.
- **Concurrency:** one run per site. A second click, or a second tab, gets "already in progress": an in-memory job lock plus the stored `running` status. The button is disabled while a run is going. A restart marks an unfinished run `interrupted`.

## Agent grade
After a rerun, each test's new reply is graded against the baseline run (1.0.0 run 1) by one small model call (`vendor/sitemail/src/edgetest/grade.js`, the checker's model): `better | same | worse` plus a reason of 30 words or fewer. Any other pair can be graded on demand from the compare view. Grades are cached per (test, run A, run B).

## Storage
`DATA_DIR/edge-testing/callbots.org.json` is one JSON file, written like the Mailbox store (temp file, then rename, mode 0600). It holds tests, runs, results per run, grades, reviews and daily spend. Nothing in it is shared with the Mailbox's own data.

## Seed (baseline 1.0.0 run 1)
- **Source:** Jarvis's library at `/workspace/edge_tests/` (README, index.json, one JSON per test), read only.
- **Build:** `scripts/edge-seed.js <libraryDir> callbots.org seeds/edge-tests/callbots.org.json` normalizes and redacts the records, re-scans the output, and refuses to write if anything is left.
- **Import:** at boot the shipped seed is imported once per seed version, idempotently.
- **Redaction:** emails other than test and our own domains, phone numbers (except 555-01xx), street addresses (except RF Safe's business ZIP), tracking numbers, and order numbers other than test order #1173. Store product links are protected first, so their `?variant=` ids are kept.
- **Refused:** a record whose sender is not a test address.
- **Prompt version:** stored as written, or `unknown` when absent; it is never guessed.

## Known limits
- The dry run has no SAR lookup (that is the phone line's live tool), so SAR emails may read differently from production.
- Web research is off in the dry run.
- Product stock counts come from the public storefront (available or not), not inventory numbers.
- The seed's prompt version is the library's 1.9.27 for every record. The library notes that tests sent before Nov 17 may have run on an earlier prompt.

## Where the code lives (callbots)
The core (`vendor/sitemail/src/edgetest/`) is byte-identical to rfsafe.app's `src/edgetest/`. The host glue is in `src/app.js` (creation after the Site Mail mount, plus the `/admin/edge-testing` route inside the unified admin) and `src/adminui.js` (tile, nav item, footer). `FEATURE_PARITY.md` N10.
