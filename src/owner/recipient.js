'use strict';
// Verified-owner email recipient. The address comes only from tenant.owner_email.
// A newsletter subscription, support_email, or anything said on the call is not a recipient.
const { validEmail } = require('../email');

function configuredOwnerEmail(tenant) {
  const raw = tenant && typeof tenant.owner_email === 'string' ? tenant.owner_email.trim() : '';
  if (!raw || /set_at_deploy|change_?me|placeholder/i.test(raw) || /^(todo|tbd|xxx)$/i.test(raw)) return { ok: false, reason: 'owner_email_not_configured' };
  if (!validEmail(raw)) return { ok: false, reason: 'owner_email_not_configured' };
  const to = raw.toLowerCase();
  if (!validEmail(to)) return { ok: false, reason: 'owner_email_not_configured' };
  return { ok: true, to };
}

// Tool arguments must not choose a recipient. Any supplied address or number is a denial, even when it matches.
const RECIPIENT_KEYS = ['to', 'email', 'address', 'recipient', 'owner_email', 'reply_to', 'replyto', 'replyTo'];
function recipientOverride(args) {
  if (!args || typeof args !== 'object') return false;
  return RECIPIENT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(args, k) && args[k] != null && String(args[k]).trim() !== '');
}

module.exports = { configuredOwnerEmail, recipientOverride };
