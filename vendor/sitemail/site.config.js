'use strict';
// callbots.org (WPAGI/rfsafe-phone-agent, Render srv-dbi7t58u01pc7398c3j0). First install target.
// Values marked "CONFIRM" need John's OK before the live install (see CHECKLIST.md). No secrets here: the
// "secrets" section only names env variables that will be added to the Callbots Render service.
module.exports = {
  site: {
    id: 'callbots',
    name: 'CallBots',
    company: 'Quanta X Technology LLC',
    product: 'CallBots',
    domain: 'callbots.org',
    public_base_url: 'https://callbots.org',
    link_allowlist: ['callbots.org', 'quantacase.com', 'rfsafe.com', 'rfsafe.org', 'rfsafe.net'],
  },
  mail: {
    from: 'CallBots <info@callbots.org>',            // CONFIRM: a sender on the Resend-verified callbots.org domain
    domains: ['callbots.org'],
    base: '/inbox',                                   // the host keeps its own /mail and /admin/mail (John via Jarvis, Nov 16)
    owner_email: 'support@quantaxtechnology.com',     // CONFIRM: who signs in to callbots.org/mail (same as the host's admin sign-in today)
  },
  kb: {
    tenant_id: 'callbots',
    // The phone line's own knowledge, READ ONLY (same folders the rfsafe tenant answers calls from):
    host_kb_dirs: ['kb/curated/rfsafe', '$DATA_DIR/kb/rfsafe-live', '$DATA_DIR/kb/rfsafe-wiki'],
  },
  data: { namespace: 'sitemail' },                    // /var/data/sitemail: new, used by nothing else on Callbots
  modules: {
    mail_viewer: true, mailbox: true, brainbox_api: true, brainbox_admin: true, public_kb: true,
    web_research: true, order_lookup: true,           // John 11:51 PM: reuse the read access the phone agent already has
    read_api: true, rerun_api: true,
  },
  store: { enabled: true, store_domain: 'quantacase.com', store_hosts: ['quantacase.com', 'rfsafe.com'], own_site_names: ['quantacase', 'rfsafe', 'truthcase'] },
  public_kb: {
    replace: [
      ['RF Safe Knowledge Base', 'CallBots Knowledge Base'],
      ['>rfsafe.app<', '>callbots.org<'],
      ['rfsafe.app/kb/', 'callbots.org/kb/'],
    ],
    hide: ['/kb/body-systems', '/kb/safety-claims'],   // CONFIRM: these use rfsafe.app's research directory
  },
  prompts: { replace: [] },
  secrets: {
    RESEND_MAIL_READ_KEY: 'RESEND_MAIL_READ_KEY',                // the host's existing callbots-mail-reader key (shared_env)
    MAILBOX_ENC_KEY: 'SITEMAIL_ENC_KEY',
    MAIL_SESSION_SECRET: 'SITEMAIL_SESSION_SECRET',
    MAILBOX_RESEND_WEBHOOK_SECRET: 'SITEMAIL_WEBHOOK_SECRET',
    XAI_API_KEY: 'XAI_API_KEY',
    KB_API_WRITE_TOKEN_HASH: 'SITEMAIL_KB_WRITE_HASH',
    MAIL_READ_TOKEN_HASH: 'SITEMAIL_READ_HASH',
    MAIL_RERUN_TOKEN_HASH: 'SITEMAIL_RERUN_HASH',
    SHOPIFY_ADMIN_SHOP: 'SITEMAIL_SHOPIFY_SHOP',
    MAILBOX_OWNER_BOOTSTRAP: 'SITEMAIL_OWNER_BOOTSTRAP',        // optional one-time owner switches (bots, auto-send, daily cap)
    SHOPIFY_ADMIN_CLIENT_ID: 'SHOPIFY_ADMIN_CLIENT_ID',          // the phone agent's existing read-only store app (shared_env)
    SHOPIFY_ADMIN_CLIENT_SECRET: 'SHOPIFY_ADMIN_CLIENT_SECRET',
  },
  shared_env: ['RESEND_MAIL_READ_KEY', 'SHOPIFY_ADMIN_CLIENT_ID', 'SHOPIFY_ADMIN_CLIENT_SECRET'],
  enable_env: 'SITEMAIL_ENABLED',
};
