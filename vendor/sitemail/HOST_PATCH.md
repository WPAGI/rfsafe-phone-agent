# Mount Site Mail + Brain box in the host (3 lines, additive)

Add just before the host's request handler is created (inside createApp, where `d` and `log` exist):

```js
// Site Mail + Brain box (vendor/sitemail). Additive: it answers only its own routes; a failure here never stops the host.
let sitemail = null;
try { if (d.dataDir) sitemail = require('../vendor/sitemail/port/mount').mountSiteMail({ env: d.env || process.env, dataDir: d.dataDir, rootDir: require('path').join(__dirname, '..'), log }, require('../vendor/sitemail/site.config.js')); } catch (e) { log('sitemail.mount_failed', { err: String(e && e.message || e).slice(0, 200) }); sitemail = null; }
```

and as the FIRST statement inside the request handler, right after `u` is parsed:

```js
if (sitemail && sitemail.enabled && await sitemail.route(req, res, u)) return;
```

Optional, in /health: `...(sitemail.enabled ? { sitemail: sitemail.status() } : {})`.

route() only answers: /inbox, /inbox/*, /api/mail/*, /api/mail/webhook/resend, /inbox/tools/shopify/callback, /admin/kb/entries, /admin/kb/entries/*, /admin/kb/agent/*, /inbox/kb, /inbox/kb/*, /kb, /kb/*, /admin/mail/messages, /admin/mail/messages/*/activity, /admin/mail/messages/*/rerun, /admin/mail/messages/*/redraft. Everything else falls through to the host unchanged.
Set SITEMAIL_ENABLED=0 to turn the whole package off without a deploy.
