'use strict';
// Server-filled return-address text for send_link_sms / send_email (return_address: true).
// The model must not type the address; this module reads it from the official KB card.
const { MAX_NOTE } = require('./linkguard');

const RETURN_CARD_ID = 'curated/quantacase-return-exchange';
const RETURN_URL = 'https://quantacase.com/policies/refund-policy';
const REMINDERS = 'Your return number is your original order number from your order confirmation email. Return shipping is paid by you.';
// Shorter reminders only if the full note would exceed MAX_NOTE. The address is never shortened.
const REMINDERS_SHORT = 'Return number: original order number from your confirmation email. You pay return shipping.';
const ADDR_RE = /Quanta X Technology LLC,\s*[^.]{8,500}?United States/gi;

function cardText(card) {
  if (!card) return '';
  return [card.title, card.body].filter(Boolean).join('\n');
}

function extractAddresses(text) {
  const found = String(text || '').match(ADDR_RE) || [];
  return [...new Set(found.map((s) => s.replace(/\s+/g, ' ').trim()))];
}

function noteFor(address, reminders) {
  return address.replace(/[.\s]+$/, '') + '. ' + reminders;
}

function buildReturnContent(kb) {
  const card = kb && typeof kb.card === 'function' ? kb.card(RETURN_CARD_ID) : null;
  if (!card) return { ok: false, reason: 'return_card_missing' };
  const addresses = extractAddresses(cardText(card));
  if (!addresses.length) return { ok: false, reason: 'address_not_found' };
  if (addresses.length > 1) return { ok: false, reason: 'conflicting_addresses' };
  const address = addresses[0];
  let reminders = REMINDERS;
  let note = noteFor(address, reminders);
  if (note.length > MAX_NOTE) { reminders = REMINDERS_SHORT; note = noteFor(address, reminders); }
  if (note.length > MAX_NOTE) return { ok: false, reason: 'note_too_long', address };
  return { ok: true, address, note, summary: noteFor(address, REMINDERS), url: RETURN_URL, reminders, card_id: RETURN_CARD_ID };
}

module.exports = { RETURN_CARD_ID, RETURN_URL, REMINDERS, REMINDERS_SHORT, extractAddresses, buildReturnContent, noteFor };
