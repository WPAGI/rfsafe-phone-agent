# Install checklist: one site

Tick every line. Nothing goes live without the owner's (John's) OK for that site.

## A. Config: `port/sites/<site>.config.js`
- [ ] `site.id`, `name`, `company`, `product`, `domain`, `public_base_url` and `link_allowlist` are filled in.
- [ ] `mail.from` is an address on a domain that's **verified in Resend** for this site.
- [ ] `mail.domains` lists the domain(s) whose mail this inbox answers.
- [ ] `mail.owner_email` is the only address that can sign in to /mail.
- [ ] `kb.tenant_id` is set. `kb.host_kb_dirs` lists the host's existing KB folders (read only), or `[]`.
- [ ] `data.namespace` is a new folder on the host data disk (default `sitemail`).
- [ ] `modules`: each one is on or off. With no store, `order_lookup: false` and `store.enabled: false`.
- [ ] `public_kb.replace` and `hide` reword or hide the public page sections that don't fit this site.
- [ ] `prompts.replace` rewords the default bot prompts if needed.
- [ ] `secrets` holds only env variable **names** (`SITEMAIL_*`), never values.

## B. Dry run (nothing is written)
- [ ] `node port/setup.js --config port/sites/<site>.config.js --target <host checkout>` prints `OK: dry run passed`.
- [ ] Every route collision is decided. Turn the module off, or pass `--allow-route <path>` with the owner's OK.
- [ ] Optional: add `--data-dir <copy of host DATA_DIR>` so setup also checks the namespace and KB folders.

## C. Install into a branch of the host repo (still not live)
- [ ] Run again with `--apply` on a new branch. Only `vendor/sitemail/` is added.
- [ ] Apply the 3 lines from `vendor/sitemail/HOST_PATCH.md`.
- [ ] The host's own test suite passes unchanged.
- [ ] Mock smoke test: boot with `SITEMAIL_MOCK=1` and confirm `/kb`, `/mail` (sign-in page), `/admin/kb/entries` (401 without a key) and `/health`.

## D. Env (owner sets values; never in chat or files)
- [ ] `SITEMAIL_RESEND_KEY`: this domain's Resend key, able to read received mail and send.
- [ ] `SITEMAIL_ENC_KEY`: a new 32-byte base64 key.
- [ ] `SITEMAIL_SESSION_SECRET`: a new random value.
- [ ] `SITEMAIL_WEBHOOK_SECRET`: from the Resend webhook for `https://<domain>/api/mail/webhook/resend`.
- [ ] `SITEMAIL_KB_WRITE_HASH`, `SITEMAIL_READ_HASH` and `SITEMAIL_RERUN_HASH`: sha256 hashes of new keys (keys go to the owner and Jarvis only).
- [ ] Only with the store: `SITEMAIL_SHOPIFY_SHOP`, `SITEMAIL_SHOPIFY_CLIENT_ID` and `SITEMAIL_SHOPIFY_CLIENT_SECRET` (read-only scopes).
- [ ] `SITEMAIL_ENABLED=1` (set it to `0` to switch everything off instantly).

## E. Staging, then live
- [ ] Staging service or preview with its own disk, and `SITEMAIL_MOCK=1` first, then a real test inbox.
- [ ] Mailbox bots start with auto-send off. Drafts are reviewed in /mail until the owner turns auto-send on.
- [ ] Live deploy only with the owner's words, at `active_calls: 0`, with no mail run going.
- [ ] After deploy: `/health` is ok, phone and text still answer (one test call by the owner), `/mail` sign-in works, and `/kb` loads.
- [ ] Rollback is written down: `SITEMAIL_ENABLED=0`, then revert the install commit. The data namespace stays.
