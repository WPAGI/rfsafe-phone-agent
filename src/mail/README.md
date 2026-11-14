# Mail viewer module (`src/mail`)

Private, read-only inbox for one site's owner. Zero dependencies (Node 20+). Drop the folder into any Node
HTTP app and mount it at `/mail`.

## What it does
- Lists every inbound email whose to/cc/bcc includes an address on a domain in `MAIL_DOMAINS`, from two
  Resend sources merged server-side: received emails (`GET /emails/receiving`) and Resend Inboxes
  (`/inboxes/{id}/threads/.../emails`, inbound only). Dedupe: same Resend email id, else same Message-ID,
  else same sender + subject + minute. Newest first, times in America/New_York.
- Click to read: sanitized HTML in a sandboxed iframe (strict allowlist: no attributes except validated
  http(s) links; scripts, styles, event handlers, iframes, forms, SVG and all images are removed; CSP
  `img-src 'none'`), plus a plain-text view with clickable links and copyable verification codes.
- Filter by to-address, search, refresh. No reply, send, delete, forward or mark-read: GET only.
- `Cache-Control: no-store`, `X-Robots-Tag: noindex` on every response. The Resend key stays server-side.

## Domain filter (server enforced)
`MAIL_DOMAINS` is a comma-separated list, matched case-insensitively and exactly against the recipient
address domain. `info@bestdealon.app.evil.com`, `x@mail.bestdealon.app` and display-name tricks do not match. Empty
or missing `MAIL_DOMAINS` shows nothing and makes no Resend calls. Inboxes are auto-discovered from
`GET /inboxes` and kept only when the inbox address itself is on an allowed domain; `MAIL_INBOX_IDS`
(comma-separated) pins specific inboxes instead, still domain-checked. Message detail requests are checked
again, so a guessed id from another domain returns 404.

## Sign-in
Owner magic link: the login form accepts an email; only the owner address gets a link (everyone sees the
same page). Link is single-use, valid 15 minutes, token in the URL fragment, max 3 per 15 minutes; session
cookie `mail_session` is HttpOnly, Secure, SameSite=Strict, Path=/mail, 12 hours. Pass an existing auth
object with the same interface (`issueLink, consumeLink, newSession, session, revoke, csrfFor, email`) to
reuse a site's admin sign-in, as the phone-agent sites do with their `AdminAuth`.

## Env
| Var | Meaning |
| --- | --- |
| `MAIL_DOMAINS` | Allowed recipient domains, e.g. `bestdealon.app` |
| `RESEND_MAIL_READ_KEY` | Resend API key used only for reading (full access is required by Resend to read received mail) |
| `MAIL_OWNER_EMAIL` | Owner address (falls back to `ADMIN_LOGIN_EMAIL`, then support@quantaxtechnology.com) |
| `MAIL_INBOX_IDS` | Optional: pin Resend inbox ids instead of auto-discovery |
| `MAIL_SESSION_SECRET` | Needed only when using the built-in auth (no host auth passed in) |
| `MAIL_MOCK=1` | Demo mode only (host decides): invented sample mail, no Resend calls |

## Mount
```js
const mail = require('./mail').createMail({
  env: process.env, siteName: 'My Site', publicBaseUrl: 'https://example.com',
  sendEmail: ({ to, subject, text, html }) => mySender.send({ to, subject, text, html }), // existing send-only key
  // auth: existingAuth,   // optional; otherwise built-in MagicAuth with MAIL_SESSION_SECRET
});
// in the request handler, before static files:
if (await mail.route(req, res, new URL(req.url, 'http://x'))) return;
```
Tests: `node --test src/mail/tests/mail.test.js`.
