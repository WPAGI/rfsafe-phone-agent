'use strict';
// PREFERENCES SITE CONFIG: RF Safe on callbots.org - v1.0
// Everything site-specific for the preferences module: branding, topics, sender, legal text.
// Wording is reused from callbots.org's existing Privacy (SMS + newsletter sections) and the live news-text invite.
const { CSS, BRAND, siteFooter } = require('../../page');
const { newsSmsInvite } = require('../../newsletter');
const h = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LAYOUT_CSS = '.prefs-main{max-width:640px;margin:0 auto;padding:2rem 20px 3rem}.prefs-main h1{margin-bottom:.4rem}.prefs-main a{color:var(--accent)}';
module.exports = {
  id: 'rfsafe',
  tenant: 'rfsafe',
  siteName: 'RF Safe',
  company: 'Quanta X Technology LLC',
  // Texting program for the RF Safe line is the existing one (callbots' Messaging Service, consent ledger, STOP list).
  // Text controls show by default; PREFS_SMS_ENABLED=0 hides them, and they only ever show while the tenant has sms_enabled.
  smsDefaultOn: true,
  // Email: new web sign-ups allowed (John, Nov 6 6:19 AM EST), verified by the one-time email link.
  emailWebSignup: true,
  // Texts: manage-only until RF Safe's campaign covers web opt-in (draft: a2p-rfsafe-mixed-draft.md). While false, codes go only to
  // numbers with call consent, texts can be turned off / frequency changed but never turned on, and there is no web YES enrollment.
  // true = full web flow: number -> confirmation text -> reply YES -> enrolled.
  smsWebOptIn: false,
  callNumber: '(727) 677-5572',
  callNumberE164: '+17276775572',
  theme: { inBg: '#10241e', inInk: '#f6f3ec', inPh: '#d5e6df', focus: '#2a9d84', disBg: '#1a2b26', disInk: '#9fb3ab', disLine: '#3c4e47', disPh: '#c5d1cb' },
  layout: ({ title, css, body }) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>${CSS}${LAYOUT_CSS}${css}</style></head><body>`
    + `<header class="site-header"><div class="wrap bar">\n${BRAND}\n</div></header><main id="content" class="prefs-main">${body}</main>\n${siteFooter()}\n</body></html>`,
  entryIntro: "Join or manage RF Safe's monthly newsletter, and manage RF Safe link texts and news texts.",
  supportEmail: 'support@quantaxtechnology.com',
  emailSubject: 'Your RF Safe preferences link',
  topics: {
    newsletter: { label: "RF Safe's monthly newsletter", help: 'Monthly email. Every newsletter email has an unsubscribe link.' },
    support_sms: { label: 'Link texts', help: 'Texts with the links you ask for, such as a product page or an article, and replies to texts you send us.' },
    news_sms: { label: 'RF Safe news texts', help: 'Optional. About once a month, plus breaking news, up to 4 msgs/mo.' },
  },
  freqLabels: { sales: 'Breaking news only', monthly: 'Monthly', up4: 'Up to 4 per month' },
  smsComingSoon: 'Text options are not available right now',
  // Shown in full before any text opt-in; the opt-in completes only when the customer replies YES.
  smsConsentText: 'By turning on texts, you agree to receive recurring automated texts from RF Safe (Quanta X Technology LLC) at the number above: the links you ask for and, if selected, RF Safe news texts (about once a month, plus breaking news, up to 4 msgs/mo). Consent to receive texts is not a condition of any purchase. Message frequency varies. Msg & data rates may apply. Reply STOP at any time to opt out, HELP for help. We will text you to confirm; you are signed up only when you reply YES. See https://callbots.org/privacy#sms and https://callbots.org/terms.',
  smsConfirmText: 'RF Safe: Confirm texts from RF Safe preferences. ' + newsSmsInvite('RF Safe'),
  smsCodeText: (code) => `RF Safe: Your RF Safe preferences code is ${code}. It expires in 15 minutes. If you did not ask for it, ignore this text.`,
  h,
};
