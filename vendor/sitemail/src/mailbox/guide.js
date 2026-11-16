'use strict';
// Plain guide served at /api/mail/guide for any bot that is given a key. Contains no secrets.
const GUIDE = ({ site, base }) => `# ${site} mailbox API for bots

Base URL: ${base || 'https://' + site}/api/mail
Auth: send your bot key on every call: \`Authorization: Bearer mbk_...\`
Keys are made by the site owner on the private mail page (Bot keys). Each key works on this site only, can be
revoked at any time, and has scopes: read, sort, draft. Every call is recorded with the key, time and result.

Bot keys can never send mail, delete mail, see other keys, change settings, or open the owner page.
Mail is only ever moved between folders; nothing is deleted. Trash just hides a message.

## Endpoints

| Method | Path | Scope | Body / query |
|---|---|---|---|
| GET  | /api/mail/messages?folder=inbox&unread=1&limit=50 | read | folder: inbox, spam, archive, trash |
| GET  | /api/mail/messages/:id | read | full plain text of the message (nothing removed); links shown as text; attachments listed |
| GET  | /api/mail/messages/:id/attachments | read | each attachment's id, filename, content_type, size, text_supported |
| GET  | /api/mail/messages/:id/attachments/:aid | read | download the file (Content-Disposition: attachment, application/octet-stream) |
| GET  | /api/mail/messages/:id/attachments/:aid/text | read | extracted text: PDF (up to 50 pages), plain text, CSV, HTML |
| POST | /api/mail/messages/:id/move | sort | {"folder":"archive","reason":"why you moved it"} (folder: inbox, spam, archive, trash) |
| POST | /api/mail/messages/:id/read | sort | {"read":true} or {"read":false} |
| POST | /api/mail/drafts | draft | {"reply_to_id":"<message id>","subject":"optional","body":"reply text","reason":"why"} |
| POST | /api/mail/tools/kb/search | read | {"query":"..."} search the site knowledge base (same live KB as the site phone line) |
| POST | /api/mail/tools/shopify/inventory | read | {"query":"product name"} stock for active products (only when the owner connected Shopify) |
| POST | /api/mail/tools/shopify/order_status | read | {"message_id":"<message id>","order":"#1042"} status only when the order email matches that message's sender |
| POST | /api/mail/tools/shopify/product_link | read (+draft) | {"query":"...","draft_id":"optional, your own draft"} official product link, added to your draft |

Attachments are never opened or run by the site. They are fetched from the mail provider only when you call one of the
attachment endpoints, up to 15 MB each; text extraction never executes anything in the file.

Drafts wait in Drafts for the owner, who can edit, send or discard them. A reason is required for every move and draft.

## Rules
- Sales and promotional mail is sorted to Spam first and can never be drafted (409 promotional_mail_no_drafts).
- Never agree to buy, sign up, subscribe, opt in, pay, sign anything, or commit to anything. Drafts that do are held.
- Refunds, money, legal, complaints and mail naming company staff always wait for the owner.
- Medical and personal-health email is answered like any other, and the reply must open with the medical disclaimer from the knowledge base entry medical-questions-disclaimer; without that entry it waits for the owner.
- Auto-send is off unless the owner turns it on. Even then a separate checker grades each draft, a daily cap applies,
  and only replies to people who wrote in first can go out.

## Errors
401 unauthorized (missing, wrong, revoked, or other-site key) · 403 missing_scope / not_allowed · 404 not_found ·
409 conflict · 413 attachment_too_large · 415 text_not_supported · 429 rate_limited (30 calls a minute, 2000 a day per key) · 502 mail_unavailable
`;
module.exports = { GUIDE };
