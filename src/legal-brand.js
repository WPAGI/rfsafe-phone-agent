'use strict';
// Privacy Policy and Terms for a tenant with its own `brand` block (Best Deal On on callbots-bdo).
// RF Safe / callbots.org (no brand block) never reaches this file; src/legal.js keeps its text byte-for-byte.
// Rules for this text: texting is listed as a feature with the carrier-approval note (John, Nov 3); never promise texts or outbound calls;
// phone numbers and texting data are not shared with third parties or affiliates.
const { OPERATOR } = require('./page');
const { brandFor, addrOf } = require('./brand');
const EFFECTIVE = 'November 3, 2026';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ctx(t) {
  const b = brandFor(t); const name = esc(b.team_name); const site = esc(b.site);
  const email = esc((t && t.owner_email) || addrOf(b.email_from));
  return { name, site, email, mailto: `<a href="mailto:${email}">${email}</a>`, op: esc(OPERATOR.name), addr: esc(`${OPERATOR.name}, ${OPERATOR.street}, ${OPERATOR.city}`) };
}
function shell(c, title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} | ${c.name}</title><meta name="robots" content="index,follow"><style>body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#222;line-height:1.55}h1{margin-bottom:4px}.eff{color:#666}li{margin:6px 0}a{color:#0a58ca}</style></head><body><main>
${body}
<p><a href="https://${c.site}/">${c.site}</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p></main></body></html>`;
}
const smsSection = (c) => `<h2 id="sms">Text messaging</h2>
<p>Texting is a feature of the ${c.name} line. Texting needs a one-time carrier approval, which usually takes about 4 to 24 hours depending on carrier acceptance. Texts are sent only with your consent, and you can reply STOP to opt out or HELP for help at any time. Msg &amp; data rates may apply.</p>
<p><strong>Your phone number and any texting data, including opt-in data and consent, are not shared with third parties or affiliates</strong> for their marketing or any other purpose, except service providers that carry calls or messages for us and are bound to use the data only for that.</p>`;

function renderBrandPrivacy(t) {
  const c = ctx(t);
  return shell(c, 'Privacy Policy', `<h1>Privacy Policy</h1>
<p class="eff">Effective date: ${EFFECTIVE}</p>
<p>This Privacy Policy explains how ${c.op} ("we", "us") handles information when you call the ${c.name} phone line, which is answered by an AI assistant, or use the pages on this site. ${c.name} is a product of ${c.op}.</p>
<h2>Information we collect</h2>
<ul>
  <li><strong>Phone number:</strong> the caller ID of the number you call from, if it is not blocked.</li>
  <li><strong>Call content:</strong> what you say on a call. Calls are answered by an AI assistant and may be recorded and transcribed. You are told this at the start of each call.</li>
  <li><strong>Information you give us:</strong> for example your name, a callback number, or a message you ask us to pass on to the ${c.name} team.</li>
  <li><strong>Email address:</strong> only if you ask the assistant to email you, and only the address you confirm on the call.</li>
  <li><strong>Technical information:</strong> standard server logs when you visit these pages or when our service handles a call.</li>
</ul>
<p>We do not ask for, and the assistant will not accept, payment card or bank details by phone.</p>
<h2>How we use information</h2>
<ul>
  <li>To answer your call, find the information you ask for, and email it to you when you ask.</li>
  <li>To pass your message to the ${c.name} team by email.</li>
  <li>To keep the service secure, prevent abuse, and meet legal obligations.</li>
</ul>
<h2>How we share information</h2>
<p>We do not sell your personal information. Your phone number and call details are not shared with third parties or affiliates for marketing. We share information only with service providers that help us run the service (AI voice processing, telephone, email delivery and hosting), only as needed for them to provide those services to us, or if required by law.</p>
${smsSection(c)}
<h2 id="email">Email</h2>
<ul>
  <li>The assistant emails you only after you say your address, it reads it back, and you say yes. One address per call.</li>
  <li>We keep a masked form of the address and what was sent, so we can honor limits and answer questions.</li>
  <li>To ask us not to email you, or to delete these records, email ${c.mailto}.</li>
</ul>
<h2 id="newsletter">Newsletter (double opt-in)</h2>
<ul>
  <li>The assistant may ask once whether you would like the ${c.name} newsletter. You are subscribed only after you open the confirmation link in our email and press the confirm button.</li>
  <li>For confirmed subscribers we keep your email address, the first name you gave, and when you confirmed.</li>
  <li>Every newsletter has an unsubscribe link, or email ${c.mailto}. We do not sell or share subscriber lists.</li>
</ul>
<h2 id="call-logs">Call records</h2>
<p>For each call we keep a short record for quality review by the ${c.name} team: the calling number, the time and length of the call, the topics asked about, and any message you left. Call records are deleted after 180 days.</p>
<h2>Your choices</h2>
<p>Email ${c.mailto} to ask about, correct, or delete information we hold about you.</p>
<h2>Children</h2>
<p>Our service is not directed to children under 13, and we do not knowingly collect their personal information.</p>
<h2>Changes</h2>
<p>We may update this policy. The effective date above shows when it last changed.</p>
<h2>Contact</h2>
<p>${c.addr}<br>${c.mailto}</p>`);
}

function renderBrandTerms(t) {
  const c = ctx(t);
  return shell(c, 'Terms of Service', `<h1>Terms of Service</h1>
<p class="eff">Effective date: ${EFFECTIVE}</p>
<p>These Terms govern your use of the ${c.name} phone line and these pages (the "Service"). The Service is operated by ${c.op}. By using the Service you agree to these Terms.</p>
<h2>The Service</h2>
<p>Calls are answered by an AI assistant, not a person, and may be recorded. The assistant answers from ${c.name}'s published information, can email you information you ask for, and can take a message for the ${c.name} team. Texting is also a feature; it needs a one-time carrier approval, which usually takes about 4 to 24 hours depending on carrier acceptance.</p>
<ul>
  <li>The assistant can make mistakes. Check important details on <a href="https://${c.site}/">${c.site}</a> or with the ${c.name} team.</li>
  <li>The assistant does not quote prices. Information provided is general information, not legal or financial advice.</li>
  <li>We do not promise to text you or to call you back. Messages are delivered to the ${c.name} team by email.</li>
  <li>We never take payments by phone.</li>
</ul>
${smsSection(c)}
<h2>Acceptable use</h2>
<p>Do not use the Service to break the law, harass anyone, send spam, or interfere with or try to gain unauthorized access to the Service.</p>
<h2>Trademarks</h2>
<p>${c.name} is a product of ${c.op}. Other names belong to their owners.</p>
<h2>Disclaimers and limitation of liability</h2>
<p>The Service is provided "as is" and "as available", without warranties of any kind, to the extent permitted by law. To the extent permitted by law, ${c.op} is not liable for indirect, incidental, special, or consequential damages arising from your use of the Service.</p>
<h2>Governing law</h2>
<p>These Terms are governed by the laws of the State of Florida, without regard to its conflict-of-law rules.</p>
<h2>Changes</h2>
<p>We may update these Terms. The effective date above shows when they last changed.</p>
<h2>Contact</h2>
<p>${c.addr}<br>${c.mailto}</p>`);
}
module.exports = { renderBrandPrivacy, renderBrandTerms, EFFECTIVE };
