'use strict';
// Module registry for the Site Mail + Brain box framework. Each module names its entry files in the reference
// repo (rfsafe-app), the routes it answers, the modules it needs and the env it reads. port/setup.js copies the
// require-closure of the enabled modules; port/mount.js only routes to enabled modules.
const MODULES = {
  mail_viewer: { label: 'Owner inbox at /mail (read, folders, Draft badge, View draft)', entry: ['src/mail/index.js'], routes: ['/mail', '/mail/*'], needs: [] },
  mailbox: { label: 'Mailbox bots: sorter, writer, checker, auto-send gate; bot API; Resend webhook', entry: ['src/mailbox/index.js', 'src/mailbox/pdf-worker.js', 'src/mailbox/mock.js'], routes: ['/api/mail/*', '/api/mail/webhook/resend', '/mail/tools/shopify/callback'], needs: ['mail_viewer'] },
  brainbox_api: { label: 'Owner KB API (write key, backups, undo)', entry: ['src/kbapi.js'], routes: ['/admin/kb/entries', '/admin/kb/entries/*'], needs: [] },
  brainbox_admin: { label: 'Brain box editor /mail/kb and agent API (bot keys, roles, versions, locks)', entry: ['src/kbadmin/index.js', 'src/kbcontrol.js'], assets: ['src/kbadmin/client.js', 'kb-agent-prompts/propose.md', 'kb-agent-prompts/publish.md', 'kb-agent-prompts/review_accuracy.md', 'kb-agent-prompts/review_improvement.md', 'kb-agent-prompts/rules.md', 'kb-agent-prompts/web_research.md'], routes: ['/admin/kb/agent/*', '/mail/kb', '/mail/kb/*'], needs: ['brainbox_api', 'mail_viewer'] },
  public_kb: { label: 'Public read-only knowledge base /kb (pages, llms.txt, JSON)', entry: ['src/publickb/index.js', 'src/publickb/hostkb.js'], assets: ['site/kb/assets/kb.css', 'site/kb/assets/kb.js'], routes: ['/kb', '/kb/*'], needs: ['brainbox_api'] },
  web_research: { label: 'Mailbox web-research fallback (settings live in the Brain box)', entry: ['src/mailbox/webresearch.js', 'src/kbadmin/webresearch.js'], routes: [], needs: ['mailbox', 'brainbox_admin'] },
  order_lookup: { label: 'Read-only Shopify order status for verified senders', entry: ['src/mailbox/orderlookup.js', 'src/shopify.js'], routes: [], needs: ['mailbox'] },
  kb_growth: { label: 'Brain box coverage metric + growth loop (proposals to the review inbox), GET /admin/mail/kb-coverage', entry: ['src/mailbox/kbgrowth.js', 'src/publickb/hostkb.js'], routes: ['/admin/mail/kb-coverage'], needs: ['mailbox', 'brainbox_admin'] },
  read_api: { label: 'Read key: GET /admin/mail/messages', entry: ['src/mailreadapi.js'], routes: ['/admin/mail/messages', '/admin/mail/messages/*/activity'], needs: ['mailbox'] },
  rerun_api: { label: 'Rerun key: POST /admin/mail/messages/<id>/rerun and /redraft', entry: ['src/mailrerunapi.js'], routes: ['/admin/mail/messages/*/rerun', '/admin/mail/messages/*/redraft'], needs: ['mailbox'] },
};
// Always copied: the framework itself.
const CORE = ['port/mount.js', 'port/lib/config.js', 'port/lib/modules.js', 'port/lib/closure.js', 'port/README.md', 'port/CHECKLIST.md', 'port/ROLLBACK.md', 'port/KB_GROWTH.md', 'port/tools/export-public-kb.js', 'port/site.config.template.js', 'src/util.js', 'src/kb.js', 'src/kblight.js', 'src/brand.js', 'port/KB_LIGHT.md'];
module.exports = { MODULES, CORE, IDS: Object.keys(MODULES) };
