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
    // John 12:37 AM: port all of rfsafe.app's Q&A into the Callbots Brain box (wording unchanged; owner-approved, so locked).
    // One-time, additive import from the read-only package seed; rfsafe.app's live store is never written.
    seed_import: 'seed/public-kb/rfsafe-app-public-kb.json',
    // Growth loop: questions answered from the big phone KB propose compact Brain box entries for review (never live).
    growth: { proposals_per_day: 10 },
    // KB Light first, KB Full fallback (John, Nov 16, 2026, 3:07-3:08 AM ET: "Yes, deploy KB Light first then KB Full
    // to callbots.org for email and phones"). KB Light = this Brain box; KB Full = the phone KB folders above, read only.
    // Env KB_LIGHT_FIRST_MAIL / _PHONE / _SMS = 0 turns a channel back to KB Full only (port/KB_LIGHT.md).
    light_first: { mail: true, phone: true, sms: true, phone_tenants: ['rfsafe'] },
  },
  data: { namespace: 'sitemail' },                    // /var/data/sitemail: new, used by nothing else on Callbots
  modules: {
    mail_viewer: true, mailbox: true, brainbox_api: true, brainbox_admin: true, public_kb: true,
    web_research: true, order_lookup: true,           // John 11:51 PM: reuse the read access the phone agent already has
    kb_growth: true,
    read_api: true, rerun_api: true,
  },
  store: { enabled: true, store_domain: 'quantacase.com', store_hosts: ['quantacase.com', 'rfsafe.com'], own_site_names: ['quantacase', 'rfsafe', 'truthcase'],
    single_variant_color: 'Black' },   // John 12:11 AM: a product with no color option comes in black
  public_kb: {
    replace: [
      ['RF Safe Knowledge Base', 'CallBots Knowledge Base'],
      ['>rfsafe.app<', '>callbots.org<'],
      ['rfsafe.app/kb/', 'callbots.org/kb/'],
    ],
    hide: [],   // John 12:31 AM: keep the body systems and the safety-claim critiques ("it should be completely ported over")
    // Callbots chrome: title, nav, home link (rfsafe.app keeps its own defaults in src/publickb/render.js).
    brand: {
      name: 'CallBots Knowledge Base', mark: 'CB', wordmark: ['CALLBOTS', 'KNOWLEDGE BASE'], home_url: '/', home_label: 'callbots.org', twitter: '',
      menu_links: [['/', 'callbots.org home'], ['https://rfsafe.app/research', 'RF Safe research'], ['/privacy', 'Privacy'], ['/terms', 'Terms']],
      footer_label: 'CallBots', footer_links: [['/', 'CallBots home'], ['https://rfsafe.app/research', 'RF Safe research directory'], ['/privacy', 'Privacy'], ['/terms', 'Terms']],
      footer_update: 'This page updates by itself when an answer changes.',
      footer_note: 'General information from RF Safe, the company behind CallBots, not medical advice. For a health concern, talk with your doctor. Call or text QuantaCase at (727) 677-5572.',
      trademark: 'RF SAFE® is a registered trademark of Quanta X Technology LLC (U.S. Reg. No. 6,592,188).',
      hero_title: 'The answers CallBots gives on wireless radiation, in plain words',
      hero_lead: 'RF Safe\'s public positions, the body-system research summaries, and the answers the CallBots phone line uses, in one open place. Search it, browse it by topic, or point an AI tool here.',
    },
    // The full rfsafe.app KB experience (core position, answers and topics, body-system summaries with effect counts,
    // safety-claim critiques), as an exported, read-only copy in the package. rfsafe.app's live store is never written.
    seed: 'seed/public-kb/rfsafe-app-public-kb.json',
    research_base: 'https://rfsafe.app',   // study links go to rfsafe.app's research directory (Callbots has none)
    // The phone agent's own KB on top, read-only through the filtered adapter (src/publickb/hostkb.js).
    host_kb: {
      enabled: true,
      page_types: ['curated', 'position', 'answer', 'topic'],
      public_numbers: ['727-677-5572'],   // QuantaCase's published contact number (quantacase.com contact page)
      public_emails: [],
      topics: { curated: 'Phone line answers', position: 'Phone line answers', answer: 'Research summaries', topic: 'Research topics' },
    },
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
    SITEMAIL_SHOPIFY_ORDERS_HMAC: 'SITEMAIL_SHOPIFY_ORDERS_HMAC', // orders/create receiver; not registered at Shopify until John approves
  },
  shared_env: ['RESEND_MAIL_READ_KEY', 'SHOPIFY_ADMIN_CLIENT_ID', 'SHOPIFY_ADMIN_CLIENT_SECRET'],
  enable_env: 'SITEMAIL_ENABLED',
};
