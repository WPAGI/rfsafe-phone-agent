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

## Per-site modes (site config)
- `smsDefaultOn` - text controls show without `PREFS_SMS_ENABLED=1` (still need tenant `sms_enabled`; `PREFS_SMS_ENABLED=0` hides them).
- `emailWebSignup` - default open. `false` = email manage-only: links only to addresses ever confirmed on the newsletter list (identical answer for everyone); listed addresses may turn the newsletter back on, new ones cannot join.
- `smsWebOptIn` - default open. `true` = full web flow: number -> 6-digit code -> tick texts + "I agree" -> confirmation text -> reply YES -> enrolled.
  `false` = text manage-only: codes go only to numbers with call consent (`verbal_call` in the consent ledger, or a news-text record), with an identical answer for every number;
  the page can turn a text type off and change frequency (max 4/mo), never turn one on; an off type is disabled with "To sign up for texts, call <callNumber> and ask.";
  no web YES enrollment. Unticking link texts = STOP for the number (ledger is per number).
- rfsafe (beta test config): `emailWebSignup: true`, `smsWebOptIn: false`, `callNumber (727) 677-5572`.

## Scope
Beta / programming test on callbots' codebase only (John, Nov 6 6:21 AM EST). Not for deploy on callbots.org; nothing submitted to Twilio; Privacy/terms unchanged.
RF Safe will move to rfsafe.app; see "Porting" below.

## Porting to another site (e.g. rfsafe.app)
Copy `src/prefs/` + `sites/<id>.js`; the host app must provide: `dataDir`, `tenants.list()`, `newsletter` (isSubscriber, everConfirmed, profileName, append, smsState, requestSms, confirmSms, stopSms),
`consent` (record, isOptedOut, canText, hasCallConsent), `emailFor(tenant).send({to,subject,text,html,headers})`, `smsFor(tenant).sendSms(...)`, `publicBaseUrl`,
route `/preferences*` to `prefs.route`, call `prefs.confirmSupportYes(from)` on inbound YES, and add the footer link. Then update that site's privacy/SMS terms and its A2P campaign before enabling web text opt-in.
