# Site Mail + Brain box: a portable package

This is rfsafe.app's proven email system and knowledge base, packaged so it can be added to another Node site (callbots.org first, then QuantaDose and Best Deal On) without touching what that site already does.

- **The package code is rfsafe.app's own code** (`src/...`), copied as-is.
- **Every site-specific value lives in one config file** (`site.config.js`).
- **A small framework** (`port/`) wires it into a host app through a single seam.

## What's inside (modules)
Each module can be turned off (`false`), kept on (`true`) or replaced (`{ enabled: true, factory: './my-module.js' }`).

| Module | What it does | Routes it answers |
|---|---|---|
| `mail_viewer` | Owner inbox at /mail: magic-link sign-in, folders, Draft badge, View draft | `/mail`, `/mail/*` |
| `mailbox` | Sorter → writer → checker → auto-send gate; bot keys and bot API; Resend webhook | `/api/mail/*`, `/api/mail/webhook/resend`, `/mail/tools/shopify/callback` |
| `brainbox_api` | Owner KB API with a write key, backups and undo | `/admin/kb/entries[/<slug>[/undo\|disable]]` |
| `brainbox_admin` | Brain box editor at /mail/kb; agent API with role keys (propose, review, publish), versions, locks, kill switch | `/admin/kb/agent/*`, `/mail/kb/*` |
| `public_kb` | Public read-only /kb pages, search, llms.txt, all.md, JSON API | `/kb`, `/kb/*` |
| `web_research` | Mailbox web-research fallback when the Brain box has no answer (settings and perspective live in the Brain box) | none |
| `order_lookup` | Read-only Shopify order status, fulfillment and tracking for verified senders (optional; off when the site has no store) | none |
| `read_api` | Read key: `GET /admin/mail/messages`, `.../<id>/activity` | as listed |
| `rerun_api` | Rerun key: `POST /admin/mail/messages/<id>/rerun` (5 per email per hour, 50 a day) | as listed |

Modules that depend on others say so (`port/lib/modules.js` `needs`), and setup refuses a config that turns on a module without its needs.

## How it plugs in (the one seam)
`port/mount.js` exports `mountSiteMail(host, config)`. The host passes `{ env, dataDir, rootDir, log }` and adds one line at the top of its request handler:

```js
if (await sitemail.route(req, res, u)) return;
```

`route()` answers only the enabled modules' paths and returns `false` for everything else, so the host's own routes (phone, text, admin) run exactly as before.

**Data.** All data goes to `DATA_DIR/<data.namespace>/` (default `sitemail`). A `.sitemail.json` marker in that folder means a second site can never reuse it, and a folder holding someone else's data is refused.

**Host knowledge.** The host's own KB folders (`kb.host_kb_dirs`) are read and never written. Brain box edits go to the package's own folder and are layered on top of the host's knowledge for email answers only. The host's phone and text agents keep reading their own KB, unchanged.

**Off switch.** Set the env named in `enable_env` (default `SITEMAIL_ENABLED`) to `0` to turn the whole package off with no deploy.

**Secrets.** Secrets come from env names listed in the config (`SITEMAIL_*`). The package gets an isolated env object holding only those values, so it never reads or changes the host's own keys. The one exception is a model key you choose to share, such as `XAI_API_KEY`.

## Install on a new site (summary; the full list is in CHECKLIST.md)
1. Copy `port/site.config.template.js` to `port/sites/<site>.config.js` and replace every `<<CHANGE_ME>>`.
2. Run a dry run: `node port/setup.js --config port/sites/<site>.config.js --target <host repo checkout>`. It validates the config and checks the target, then lists what it would add and any refusals.
3. Fix every refusal. If the host already has a route the package wants (callbots.org has an older read-only /mail viewer), decide, then pass `--allow-route /mail`.
4. Install: add `--apply`. It writes new files under `<host>/vendor/sitemail/` only, including `deploy/brand.json`, `site.config.js`, `HOST_PATCH.md` and `INSTALL.json`.
5. Apply `vendor/sitemail/HOST_PATCH.md` (3 lines) in a reviewed PR. Add the `SITEMAIL_*` env values. Stage it first, then go live with the owner's OK.

## Replacing a module
Set `modules.public_kb = { enabled: true, factory: './my-kb.js' }`. The factory gets `ctx` (`cfg`, `env`, `log`, `now`, `ns`, `tenant`, `kb()`, `kbReset()`) and returns an object with the same methods as the built-in module (for public_kb: `isKbPath(p)`, `route(req, res, u)`, `reset()`).

## Other docs
- `MERGE_PLAN_CALLBOTS.md`: the Callbots plan (decisions, steps, risks). `ROLLBACK.md`: undo steps for any site.

## Updating a site later
Updates go through `vendor/sitemail/INSTALL.json`: compare the hashes, roll back, then install the new version (setup never overwrites). The data namespace is kept across updates.

## Public /kb layers, seed import, growth loop (Nov 16)

- `public_kb.seed`: an exported public KB (port/tools/export-public-kb.js) shown under the site's own Brain box entries:
  core position, answers and topics, body-system summaries with effect counts, safety-claim critiques.
- `public_kb.host_kb`: the host's own KB folders on /kb through a read-only filtered adapter (src/publickb/hostkb.js;
  the filter rules are listed at the top of that file).
- `public_kb.brand`, `public_kb.research_base`: the site's header, menu, footer and hero text, and where body-system
  study links point.
- `kb.seed_import`: one-time additive import of the seed into the Brain box (owner-approved, locked).
- `modules.kb_growth`: Brain box coverage metric + growth loop. See KB_GROWTH.md.


## Mailbox verification (v1.2, Nov 16; rfsafe.app PRs #73-#75)

Same code as rfsafe.app main d81e5e59f: color answers from the store lookup (`store.single_variant_color`, default
Black), checker store evidence first, KB-backed health tips allowed, the revise loop (max 2), the store query from the
full message, the draft's variant URL verified, no cuts on an empty lookup or when critical info is missing, draft
version history (older drafts superseded), and separate Rerun / Redraft in the inbox and on the rerun key
(`POST /admin/mail/messages/<id>/rerun` and `/redraft`, same limits).
