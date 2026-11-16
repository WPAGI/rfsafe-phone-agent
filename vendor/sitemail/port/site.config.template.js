'use strict';
// ============================================================================================================
// Site Mail + Brain box: ONE config file per site. Copy this file to sites/<your-site>.config.js and replace
// every <<CHANGE_ME ...>> placeholder. The setup script (node port/setup.js) refuses to run while any
// placeholder is left, while a required value is missing, or when installing would overwrite anything.
//
// NEVER put a secret here. Secrets stay in the host's environment (Render env). This file only names the env
// variables to read (section "secrets"), so it is safe to commit.
// ============================================================================================================
module.exports = {
  // --- Who the site is ---------------------------------------------------------------------------------------
  site: {
    id: '<<CHANGE_ME: short id, lowercase letters/digits/dashes, e.g. callbots>>',
    name: '<<CHANGE_ME: business name shown to customers, e.g. CallBots>>',
    company: '<<CHANGE_ME: legal company name>>',
    product: '<<CHANGE_ME: main product or service name>>',
    domain: '<<CHANGE_ME: the site domain, e.g. example.com (no https://)>>',
    public_base_url: '<<CHANGE_ME: https://example.com>>',
    // Domains a reply may link to (the checker refuses any other link).
    link_allowlist: ['<<CHANGE_ME: example.com>>'],
  },

  // --- Email (Resend) ----------------------------------------------------------------------------------------
  mail: {
    from: '<<CHANGE_ME: Display Name <info@example.com> (a sender on a Resend-verified domain)>>',
    // Only mail TO these domains is shown and answered.
    domains: ['<<CHANGE_ME: example.com>>'],
    // The only address that can sign in to /mail (the owner gets a magic link here).
    owner_email: '<<CHANGE_ME: owner@example.com>>',
    // Path of the owner inbox. Use another path (e.g. '/inbox') when the host already has a /mail page.
    base: '/mail',
  },

  // --- Brain box (knowledge base) ----------------------------------------------------------------------------
  kb: {
    // Brain box entries for this site are stored under DATA_DIR/<data.namespace>/kb-api/<tenant_id>/.
    tenant_id: '<<CHANGE_ME: usually the same as site.id>>',
    // The host's existing KB folders are READ ONLY to this package (it never writes, moves or deletes them).
    // Paths are relative to the host repo root, or $DATA_DIR/<folder> for folders on the host data disk.
    // Leave [] to start with only Brain box entries.
    host_kb_dirs: [],
    // Optional one-time import of an exported public KB into this site's Brain box (owner-approved, locked; additive,
    // never overwrites a slug). e.g. 'seed/public-kb/rfsafe-app-public-kb.json'. false = no import.
    seed_import: false,
    // Growth loop (modules.kb_growth): max proposals a day sent to the review inbox.
    growth: { proposals_per_day: 10 },
    // KB Light first (src/kblight.js, port/KB_LIGHT.md): search this site's Brain box first and fall back to the full KB
    // only when it has no good match. Off unless set. phone_tenants: host tenant ids whose phone/SMS lookup uses it.
    // light_first: { mail: true, phone: true, sms: true, phone_tenants: ['<host tenant id>'] },
  },

  // --- Data -------------------------------------------------------------------------------------------------
  data: {
    // A NEW folder inside the host's DATA_DIR that only this package uses (mail store, Brain box, keys, logs).
    // Must not already be used by the host. Never "kb", "kb-api", "mailbox" or anything the host writes.
    namespace: 'sitemail',
  },

  // --- Modules: turn any of them off (false) or keep them on (true) -------------------------------------------
  // Each module can also be replaced: { enabled: true, factory: './my-module.js' } (see port/README.md).
  modules: {
    mail_viewer: true,     // /mail owner inbox (read, folders, Draft badge, View draft)
    mailbox: true,         // sorter -> writer -> checker -> auto-send gate, /api/mail bot API, Resend webhook
    brainbox_api: true,    // owner KB API /admin/kb/entries (KB write key, backups, undo)
    brainbox_admin: true,  // /mail/kb editor + agent API /admin/kb/agent/* (editor/reviewer bot keys)
    public_kb: true,       // public read-only /kb pages, llms.txt, JSON
    web_research: true,    // Mailbox web-research fallback when the Brain box has no answer
    order_lookup: false,   // read-only Shopify order status (needs the store section below)
    kb_growth: false,     // Brain box coverage metric + growth loop: proposals for review, never live edits (needs mailbox, brainbox_admin)
    read_api: true,        // GET /admin/mail/messages (read key)
    rerun_api: true,       // POST /admin/mail/messages/<id>/rerun (rerun key)
  },

  // --- Store (only when modules.order_lookup is true) ---------------------------------------------------------
  store: {
    // Leave enabled false for sites without a store. Point it at any Shopify store later.
    enabled: false,
    store_domain: '',          // public store domain, e.g. shop.example.com
    store_hosts: [],           // product-link hosts the writer may use, e.g. ['shop.example.com']
    own_site_names: [],        // first label of your own shop domains, e.g. ['shop'] (third-party order rule)
    single_variant_color: 'Black',  // color named when a product has no color option (only "Default Title"); rfsafe.app default
  },

  // --- Wording -------------------------------------------------------------------------------------------------
  // Public /kb page text: [from, to] pairs replace the reference site's wording (rfsafe.app) on every page.
  // hide: public /kb sections this site does not have (e.g. '/kb/body-systems', '/kb/safety-claims').
  public_kb: {
    replace: [], hide: [],
    // Optional: header, menu, footer and start-page wording for this site (defaults: rfsafe.app's own).
    // brand: { name, mark, wordmark: [left, bold right], home_url, home_label, menu_links: [[href, label]], footer_label,
    //          footer_links: [[href, label]], footer_update, footer_note, trademark, twitter, hero_title, hero_lead },
    // Optional: an exported public KB to show under this site's own Brain box entries (read-only package file),
    // e.g. 'seed/public-kb/rfsafe-app-public-kb.json' (refresh with: node port/tools/export-public-kb.js <url> <file>).
    // seed: '',
    // Where body-system "see the studies" links point ('' = this site's own /research), e.g. 'https://rfsafe.app'.
    // research_base: '',
    // Optional: show the host's own KB folders (kb.host_kb_dirs) on /kb through the read-only filtered adapter.
    // host_kb: { enabled: false, page_types: ['curated', 'position', 'answer', 'topic'], public_numbers: [], public_emails: [], topics: {} },
  },
  // Bot prompt wording: [from, to] pairs applied to the default sorter/writer/checker prompts.
  // (The owner can still edit every prompt later in /mail; edits are versioned.)
  prompts: { replace: [] },

  // --- Secrets: the NAMES of host env variables (values stay in the host env) ---------------------------------
  // Use names unique to this package so they never clash with the host's own variables.
  secrets: {
    RESEND_MAIL_READ_KEY: 'SITEMAIL_RESEND_KEY',            // Resend API key for this domain (read + send)
    MAILBOX_ENC_KEY: 'SITEMAIL_ENC_KEY',                    // 32-byte base64 key that seals the stored mail
    MAIL_SESSION_SECRET: 'SITEMAIL_SESSION_SECRET',         // signs the /mail sign-in session
    MAILBOX_RESEND_WEBHOOK_SECRET: 'SITEMAIL_WEBHOOK_SECRET', // Resend webhook signing secret
    MAILBOX_OWNER_BOOTSTRAP: 'SITEMAIL_OWNER_BOOTSTRAP',       // optional: one-time owner switches JSON (bots on, auto_send, daily_cap)
    XAI_API_KEY: 'XAI_API_KEY',                             // model key (may be shared with the host)
    KB_API_WRITE_TOKEN_HASH: 'SITEMAIL_KB_WRITE_HASH',      // sha256 of the owner KB write key (hash only)
    MAIL_READ_TOKEN_HASH: 'SITEMAIL_READ_HASH',             // sha256 of the read key (hash only)
    MAIL_RERUN_TOKEN_HASH: 'SITEMAIL_RERUN_HASH',           // sha256 of the rerun key (hash only)
    SHOPIFY_ADMIN_SHOP: 'SITEMAIL_SHOPIFY_SHOP',            // only with order_lookup
    SHOPIFY_ADMIN_CLIENT_ID: 'SITEMAIL_SHOPIFY_CLIENT_ID',  // only with order_lookup
    SHOPIFY_ADMIN_CLIENT_SECRET: 'SITEMAIL_SHOPIFY_CLIENT_SECRET', // only with order_lookup
  },

  // --- Kill switch ----------------------------------------------------------------------------------------------
  // Env variable that turns the whole package off at runtime ("0" = off) without a code change.
  // Host env names this package may READ as-is (e.g. the store credentials the host already has). Never written.
  shared_env: [],
  enable_env: 'SITEMAIL_ENABLED',
};
