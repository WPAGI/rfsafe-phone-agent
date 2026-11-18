# Unified admin: feature parity (callbots.org, Nov 16, 2026)

John's rule (9:17 PM ET): "we gotta make sure we don't lose any of the current features of the ... subscription page ... unified by a single Magic Link login."

Every feature of the old one-page admin (`GET /admin`), the Subscribers page and the other admin tools is listed below with where it lives now and the test that checks it. `test/unified-admin.test.js` fails if any id in this table has no test there. Tests in the "also" column are older tests that already covered the same code. They still pass, and none of their assertions were weakened. Five of them changed only the page they read (see the README).

Old = where the feature was before this change. New = where it is now. Nothing was removed.

## Sign-in and session

| Id | Feature | Old | New | Tested in |
|---|---|---|---|---|
| F01 | Sign-in page: one "Send sign-in link" button, CSRF cookie (HttpOnly, Secure, SameSite=Strict) | /admin/login | /admin/login (Mailbox-style card, same form) | unified-admin; also admin |
| F02 | Link emailed only to the fixed admin address; CSRF + origin check; at most 3 links per 15 min | POST /admin/login | unchanged | unified-admin; also admin |
| F03 | "Link sent" page with 15:00 countdown and Resend after 60 s | POST /admin/login | unchanged (card) | unified-admin |
| F04 | Token in the URL #fragment, wiped by the page, POSTed with CSRF; single use; 12 h session cookie | /admin/auth | unchanged | unified-admin; also admin, admin-token-fragment |
| F05 | Legacy `?t=` link refused, never consumed | /admin/auth | unchanged | unified-admin; also admin-token-fragment |
| F06 | Sign out needs the session CSRF, revokes the session | POST /admin/logout | unchanged, and now also clears the Mailbox cookies | unified-admin; also admin |
| F07 | Bearer admin token fallback: JSON status on `/admin`, data pages and CSVs for scripts | /admin, CSVs | unchanged, plus the new pages | unified-admin; also routes, admin |
| F08 | Signed-out browser is sent to the sign-in page; scripts get 401 | /admin, /admin/messages | every admin page | unified-admin |
| F28 | Sign out button | top of /admin | top bar of every admin page | unified-admin |

## Old one-page dashboard, now split into pages

| Id | Feature | Old | New | Tested in |
|---|---|---|---|---|
| F10 | Links: Review texts, Review emails, Outbound & owner briefing, Owner feedback, Usage & costs | /admin header | Home tiles + left nav | unified-admin; also sent-messages, owner-outbound-admin, usage-costs |
| F11 | Texting on/off per line (sender-pool check, existing Messaging Service) | /admin "Texting and email" | /admin/channels | unified-admin; also channel-toggles |
| F12 | Email on/off per line | /admin | /admin/channels | unified-admin; also channel-toggles |
| F13 | Texts: send instantly / hold for review | /admin | /admin/channels | unified-admin; also channel-toggles |
| F14 | Warning when texting and email are both off | /admin | /admin/channels | unified-admin |
| F15 | Error banner after a failed switch (`?err=`) | /admin?err= | /admin/channels?err= (old link redirects) | unified-admin; also channel-toggles |
| F16 | Change log table (time, line, setting, to, result) | /admin | /admin/channels | unified-admin; also channel-toggles |
| F17 | Note: texts only go to the caller's number | /admin | /admin/channels | unified-admin |
| F18 | Newsletter counters (7): email confirmed, email unsubscribed, news texts confirmed, awaiting YES, stopped, new last 7 days, new last 30 days | /admin | /admin/newsletter | unified-admin; also admin |
| F19 | "Manage subscribers" link | /admin | /admin/newsletter, Home tile, left nav | unified-admin; also subscribers-admin |
| F20 | Newsletter CSV (consent proof columns, formula-injection guard) | /admin/newsletter.csv | unchanged; linked from Newsletter, Subscribers, Home (Downloads) | unified-admin; also admin |
| F21 | Newsletter table, 10 columns | /admin | /admin/newsletter | unified-admin; also admin |
| F22 | "Open private Mail inbox" link | /admin | Home tile "Mail viewer", left nav | unified-admin; also mail-viewer |
| F23 | Call log filter: From, To, Number, Filter, Clear | /admin?from=&to=&number= | /admin/calls (old links redirect with the same query) | unified-admin; also admin |
| F24 | Call count and calls CSV that keeps the filter | /admin | /admin/calls | unified-admin; also admin |
| F25 | Unanswered questions CSV | /admin | /admin/calls, Home (Downloads) | unified-admin |
| F26 | Review texts / emails links and the 180-day retention note | /admin | /admin/calls | unified-admin |
| F27 | Calls table, 7 columns (withheld caller, masked email, failed sends) | /admin | /admin/calls | unified-admin; also admin |

## Sent-message review

| Id | Feature | Old | New | Tested in |
|---|---|---|---|---|
| F30 | Review texts: list, pages, detail by id, 404, CSV | /admin/messages?type=sms, /admin/messages.csv | unchanged URLs, in the layout | unified-admin; also sent-messages |
| F31 | Review emails: same for email | /admin/messages?type=email | unchanged URLs, in the layout | unified-admin; also sent-messages |

## Subscribers page

| Id | Feature | Old | New | Tested in |
|---|---|---|---|---|
| F40 | Search by name, email or phone; Clear; entry count | /admin/subscribers | unchanged, own page in the layout | unified-admin; also subscribers-admin |
| F41 | Edit name, email, phone | POST /admin/subscribers/edit | unchanged | unified-admin; also subscribers-admin |
| F42 | Unsubscribe email | POST /admin/subscribers/unsubscribe channel=email | unchanged | unified-admin; also subscribers-admin |
| F43 | Stop texts | POST /admin/subscribers/unsubscribe channel=sms | unchanged | unified-admin; also subscribers-admin |
| F44 | Merge (only fills a missing email or phone) | POST /admin/subscribers/merge | unchanged | unified-admin; also subscribers-admin |
| F45 | Delete: browser confirm, then a server confirm page | POST /admin/subscribers/delete | unchanged (confirm page in the layout) | unified-admin; also subscribers-admin |
| F46 | Audit log, last 30 changes | /admin/subscribers | unchanged | unified-admin; also subscribers-admin |
| F47 | Download CSV link | /admin/subscribers | unchanged | unified-admin |
| F48 | JSON list for the Bearer token (no internal keys) | GET /admin/subscribers | unchanged | unified-admin; also subscribers-admin |
| F49 | Every change needs the session CSRF and same origin; Saved / error banners | /admin/subscribers | unchanged | unified-admin; also subscribers-admin |

## Other admin tools

| Id | Feature | Old | New | Tested in |
|---|---|---|---|---|
| F50 | Outbound & owner briefing page: line picker, date, unanswered list, briefing preview, recent calls, audit | /admin/outbound | unchanged URL, in the layout | unified-admin; also owner-outbound-admin |
| F51 | Owner PIN (set, confirm) | POST /admin/outbound/pin | unchanged | unified-admin (form present); also owner-outbound-admin |
| F52 | Briefing settings | POST /admin/outbound/settings | unchanged | unified-admin (form present); also owner-outbound-admin |
| F53 | Test call to an owner number, with confirm | POST /admin/outbound/test-call | unchanged | unified-admin (form present); also owner-outbound-admin |
| F55 | Owner feedback review (session HTML; tenant-scoped token JSON) | /admin/owner-feedback(.json) | unchanged URLs, HTML in the layout | unified-admin; also owner-feedback |
| F56 | Usage & costs page and JSON, per-session rate limit | /admin/usage, /admin/usage.json | unchanged (own page, links back to /admin) | unified-admin; also usage-costs |
| F57 | Daily usage snapshot push (Bearer secret) | POST /admin/usage/snapshot | unchanged | unified-admin; also usage-snapshot |
| F60 | Admin to Mail viewer handover (same session, Path=/mail) | /admin/mail | unchanged | unified-admin; also mail-viewer |
| F61 | Mail viewer's own sign-in form (fallback) | /mail/login | unchanged | unified-admin; also mail-viewer |
| F70 | Tenant admin API (Bearer) | /admin/status, /admin/tenants/... | unchanged | unified-admin; also routes, http |
| F71 | Newsletter subscribers JSON (Bearer) | /admin/newsletter/subscribers | unchanged | unified-admin |
| F72 | Site Mail key APIs: KB write key, mail read key, rerun key | /admin/kb/entries, /admin/mail/messages... | unchanged | unified-admin; also sitemail-mount |

## New

| Id | Feature | Where | Tested in |
|---|---|---|---|
| N01 | Home: icon tiles (128 px) grouped by section: Callbots, People, Mailbox, Downloads | /admin | unified-admin |
| N02 | Left side nav on every admin page, current page marked; Mailbox colors; no inbox-folder column | all admin pages | unified-admin |
| N03 | Small screens: the Mailbox's own scrollable top menu (same `@media (max-width:980px)` CSS, reused), no hamburger | all admin pages | unified-admin + 390 px screenshots |
| N04 | Mailbox and Brain box tiles hand the admin session to /inbox and /inbox/kb | /admin/go/inbox, /admin/go/kb | unified-admin |
| N05 | One session everywhere: sign out in the admin or the Mailbox ends both; a cookie signed with the old Mailbox secret is refused | /admin, /inbox | unified-admin |
| N06 | The Mailbox sign-in page sends you to the admin sign-in and back to where you were going (Mailbox or Brain box) | /inbox/login -> /admin/login?next= | unified-admin; also sitemail-mount |
| N07 | Every old admin URL still answers or redirects | all | unified-admin |
| N08 | `next` is a fixed list (inbox, kb, mail): no open redirect, no header injection | /admin/login, /admin/auth | unified-admin |
| N09 | Mailbox package off: no Mailbox tiles, a clear "Mailbox is off" page | /admin, /admin/go/* | unified-admin |
| N10 | Edge testing (Nov 18, 2026, build-only): a Mailbox-section tile and a left-nav item, existing admin session only (no Bearer), product version in every admin page's footer. Page, dry run and seed tests: `test/edge-testing.test.js`, `test/edge-testing-app.test.js` | /admin/edge-testing | unified-admin; also edge-testing, edge-testing-app |
