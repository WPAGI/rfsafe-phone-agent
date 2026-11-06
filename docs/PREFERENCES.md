# /preferences on callbots.org (RF Safe) - design note

Port of the QuantaDose preferences module (WPAGI/quantadose-cards, commits 8592633..7929996). Same core, one new site config.
Status: built on branch `feature/preferences-page`, NOT deployed.

## Layout
- `src/prefs/core.js` - site-agnostic engine: magic-link tokens, SMS codes, sessions, rate limits, audit log. Tokens, codes and
  session ids are stored only as HMAC hashes, single use, 15 min (links/codes) / 30 min (session).
- `src/prefs/index.js` - routes: `GET /preferences`, `POST /preferences/start|verify|code|save|unsubscribe|unsubscribe-all|logout`, `GET /preferences/manage`.
- `src/prefs/page.js` - server-rendered HTML. Input/select colours come from `site.theme` (hex only); a site may supply `layout()` to wrap pages in its own header/footer.
- `src/prefs/sites/rfsafe.js` - RF Safe branding, topics and legal text (wording reused from callbots.org Privacy + the live news-text invite).

## Data (Render disk, DATA_DIR=/var/data)
- Newsletter list: existing `newsletter.jsonl` (same file the call flow uses). Web changes append `confirmed` / `unsubscribed` / `profile` events, `source: web-preferences`.
- News texts: existing `sms_pending` / `sms_confirmed` / `sms_stopped` events in `newsletter.jsonl`.
- STOP list: existing consent ledger `consent.jsonl` (`Consent.record(tenant, phone, 'stop')`), the same list a STOP reply writes.
- New: `prefs/rfsafe/state.json` (hashed tokens/codes/sessions, per-person text frequency), `prefs/rfsafe/audit.jsonl` (append-only, every opt-in/opt-out: time, channel, from, to, method, source; never name values), `prefs/rfsafe/prefs-secret.key` (0600, generated once unless PREFS_SECRET is set).

## Behaviour
- Sign-in: email magic link (GET shows a Continue button, POST consumes, so link scanners cannot), or a 6-digit text code when text controls are on. Every request gets the same generic answer (no enumeration). Limits: 3 per address and 10 per IP per 15 min.
- Manage: newsletter toggle with one required Name field (80 max, cleaned, escaped, prefilled); link texts and RF Safe news texts with frequency (never more than 4/mo); unsubscribe dropdown (texts / emails / everything); unsubscribe-from-everything button; sign out. CSRF token + SameSite=Strict HttpOnly Secure cookie.
- Turning texts on shows the full consent wording, needs "I agree", and completes only when the person replies YES to a confirmation text.
- Text opt-outs (toggle, dropdown, typed number) go to the existing STOP list and send no text. A typed number can only be opted out, never signed up.
- Newsletter emails now carry RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post` headers; one-click POSTs are audited. Greetings use the first word of the stored name ("Hi John,"), else "Hi there,".
- STOP/START/HELP replies, the SMS wording, campaign text and Twilio settings are unchanged.

## Text controls flag
`sites/rfsafe.js` sets `smsDefaultOn: true` (John, Nov 6 6:11 AM EST: texting options stay on for RF Safe/callbots). Text controls show only while
the rfsafe tenant has `sms_enabled` true. `PREFS_SMS_ENABLED=0` is a kill switch that hides them. QuantaDose-style sites (no `smsDefaultOn`) still need `PREFS_SMS_ENABLED=1`.

## Env (names only)
- `RESEND_API_KEY` (existing; sends from `RF Safe <rfsafe@callbots.org>` like the call emails) - live mode only; demo uses the mock.
- `PUBLIC_BASE_URL` (existing) - base of the magic link.
- `PREFS_SECRET` (optional, >= 32 chars). `PREFS_SMS_ENABLED` (optional, `0` = hide text controls).
- Texts use the tenant's existing Twilio number / Messaging Service and `RFSAFE_TWILIO_AUTH_TOKEN` through `smsFor`.

## A2P risk (read before deploy)
The local campaign draft `deploy/a2p-campaign.draft.md` describes only verbal opt-in on an inbound call, Customer Care only, "No marketing".
It does not describe a web opt-in or the news texts. Web text opt-in on /preferences is the same gap that got QuantaDose rejected (30907/30544).
Draft wording to add (not applied) is in the PR description / report: Privacy SMS section bullet + campaign message flow sentence.
