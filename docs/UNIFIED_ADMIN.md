# Design note: unified admin (Nov 16, 2026)

**Asked (John, 9:13-9:22 PM ET):**
- One admin home behind one magic-link sign-in, with icon tiles grouped by section.
- Clean separate pages in the Mailbox colors, with a left nav.
- Subscribers on its own page.
- Lose no feature of the old admin or subscription page.
- On small screens, the Mailbox's scrollable top menu ("no shortcuts").

## How it is built
- **One list of tools.** `src/adminui.js` `SECTIONS` drives both the home tiles and the left nav, so a tool cannot appear in one and be missing from the other. Tools that need the Site Mail package are hidden when it is off.
- **Reused, not copied.** The page CSS is `vendor/sitemail/src/mail/views.js` `CSS` plus `vendor/sitemail/src/mailbox/views.js` `CSS2`, the exact strings the Mailbox ships. That gives the same colors, the same light/dark switch and the same `@media (max-width:980px)` rule that turns `.nav` into a horizontally scrollable row. `ADMIN_CSS` adds only:
  - the tiles;
  - table and form styling;
  - a few contrast fixes for older pages that set light inline backgrounds.
- **Older pages unchanged inside.** `adm.shell(title, body, opts)` now draws the layout. Subscribers, Review texts/emails, Outbound and Owner feedback render their bodies exactly as before, so their forms, CSRF, scripts and tests are untouched. Usage & costs keeps its own page and theme. It links back to Admin home and is a tile and a nav item.
- **No new scripts.** Layout pages carry no JavaScript. Pages that already had a nonce'd script keep it, with the same CSP.

## Sign-in and session security
- **One session store.** The host's `AdminAuth` serves the admin and is handed to the Site Mail package (`mountSiteMail({ auth })`, then `createMail({ auth })`). Before, the package made its own `MagicAuth` with `SITEMAIL_SESSION_SECRET`. Both use the same interface: hashed single-use links (15 min), at most 3 links per 15 min, HMAC-signed `sid.exp.mac` cookies (12 h), HMAC CSRF bound to the session, constant-time compares.
- **Handover.** The handover copies the session value into a cookie scoped to the Mailbox path (`Path=/inbox`). It is HttpOnly, Secure and SameSite=Strict, the same pattern `/admin/mail` has used for `/mail`. A cross-site GET of `/admin/go/*` carries no session (SameSite=Strict), so it only reaches the sign-in page.
- **Sign out.** Revoking the sid in the shared store ends the session everywhere. `/admin/logout` also clears the `/mail` and `/inbox` cookies.
- **`next` after sign-in.** It comes from a fixed map (`inbox`, `kb`, `mail`) with no prototype, so an outside URL, a `__proto__` key or a CRLF value is ignored: no open redirect and no header injection.
- **Unchanged:**
  - the link only ever goes to the fixed admin address;
  - the token travels in the URL #fragment;
  - the Bearer admin token fallback;
  - the tenant-scoped owner-feedback token;
  - the Site Mail key APIs.
- **Not covered here.** Revocation is in memory, as before, so a restart forgets sign-outs. The 12 h expiry still applies.

## Known trade-offs
- After deploy, open Mailbox sessions that were signed with the old Mailbox secret end, so the owner signs in once more.
- The Mailbox's own sign-in form (POST `/inbox/login`) still works. It now checks against the admin address, which is the same default address, and the GET page redirects to the admin sign-in.
- On small screens, the active page can start scrolled out of view in the top menu. The Mailbox behaves the same way, and fixing it would need a script.
