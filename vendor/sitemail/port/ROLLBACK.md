# Rollback (any site)

1. Instant, no deploy: set `SITEMAIL_ENABLED=0` (the site's `enable_env`) and restart. The package answers nothing; every
   host route, including any host /mail, runs as before.
2. Code: revert the install commit (removes `vendor/sitemail/` and the 3 mount lines in the host app). Redeploy.
3. Data: `$DATA_DIR/<namespace>/` holds only this package's data (mail state, Brain box entries, logs). Leave it, or archive
   it. Never delete without the owner's OK. The host's own data is never written by the package.
4. Resend: point the inbound webhook back to where it was (or remove it) if the site is going back to no inbox.
5. Env: the `SITEMAIL_*` values can stay (unused when off) or be removed. Shared names (`shared_env`) were never changed.

`port/setup.js` prints this list on every dry run and writes it into `vendor/sitemail/INSTALL.json`.
