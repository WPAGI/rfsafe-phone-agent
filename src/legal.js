'use strict';
// Privacy Policy and Terms of Service for callbots.org. Same look as the homepage (shared CSS, brand, footer).
// Standard language only; SMS section follows CTIA / carrier A2P 10DLC disclosure requirements.
const { CSS, BRAND, OPERATOR, siteFooter, esc } = require('./page');

const EFFECTIVE = 'October 30, 2026';
const ADDRESS = `${OPERATOR.name}, ${OPERATOR.street}, ${OPERATOR.city}`;
const MAILTO = `<a href="mailto:${OPERATOR.email}">${OPERATOR.email}</a>`;

const SMS_SECTION = `<h2 id="sms">SMS / Text Messaging</h2>
<p>When you call a phone line answered by our AI assistant (including the RF Safe line), the assistant may offer to text you a link you asked for, such as a product page or an article.</p>
<ul>
  <li><strong>How you consent:</strong> consent is given verbally on the call. The assistant asks whether the number you are calling from is okay to text, and texts only if you say yes.</li>
  <li><strong>Which number:</strong> texts are sent only to the phone number you are calling from. We do not text a different number given on the call, and we cannot text callers whose caller ID is blocked or withheld.</li>
  <li><strong>What we send:</strong> the links you asked for during the call, and replies to texts you send us. Consent to receive texts is not a condition of any purchase.</li>
  <li><strong>Message frequency varies.</strong> Msg &amp; data rates may apply.</li>
  <li><strong>Opt out:</strong> reply <strong>STOP</strong> at any time to stop receiving texts. You will receive one message confirming you are unsubscribed. Reply <strong>START</strong> to resubscribe.</li>
  <li><strong>Help:</strong> reply <strong>HELP</strong> for help, or email ${MAILTO}.</li>
  <li>Carriers are not liable for delayed or undelivered messages.</li>
  <li><strong>Mobile opt-in data and consent will not be shared with third parties or affiliates for marketing purposes.</strong> Text messaging originator opt-in data and consent are not shared with any third parties, except service providers that deliver the messages for us.</li>
</ul>`;

const EMAIL_SECTION = `<h2 id="email">Email</h2>
<p>If you ask on a call, the assistant can email you the links you requested, such as a product page on quantacase.com or an article on rfsafe.org.</p>
<ul>
  <li><strong>How you consent:</strong> you say your email address on the call, the assistant spells it back, and it sends only after you say yes. One address per call.</li>
  <li><strong>What we send:</strong> only the links you asked for, from rfsafe@callbots.org with the subject "Your RF Safe links", at most three emails per call. These are one-time messages; we do not add you to a mailing list or send marketing.</li>
  <li><strong>What we keep:</strong> a masked form of your address (for example j***@g***.com), a one-way fingerprint of it, and which links were sent, so we can honor limits and answer questions. Emails are delivered by our email provider (Resend).</li>
  <li>Replies go to our support team. To ask us not to email you, or to delete these records, email ${MAILTO}.</li>
</ul>`;

function shell({ title, description, path, body }) {
  const url = 'https://callbots.org' + path;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${url}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:url" content="${url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="CallBots">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="16x16">
<style>
${CSS}
</style>
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="site-header">
  <div class="wrap bar">
${BRAND}
    <div class="nav-end"><a class="cta solid nav-cta" href="/">Home</a></div>
  </div>
</header>
<main id="content">
  <article class="wrap legal">
${body}
  </article>
</main>
${siteFooter()}
</body>
</html>`;
}

function renderPrivacy() {
  return shell({ title: 'Privacy Policy | CallBots', description: 'How Quanta X Technology LLC collects, uses, and protects information when you call or text a line answered by CallBots, including SMS terms.', path: '/privacy', body: `
<h1>Privacy Policy</h1>
<p class="eff">Effective date: ${EFFECTIVE}</p>
<p>This Privacy Policy explains how ${OPERATOR.name} ("Quanta X Technology", "we", "us"), a ${OPERATOR.state} limited liability company at ${OPERATOR.street}, ${OPERATOR.city}, handles information when you visit callbots.org or call or text a phone line answered by our CallBots AI assistant, including the RF Safe line. ${OPERATOR.name} owns the RF Safe trademark.</p>
<h2>Information we collect</h2>
<ul>
  <li><strong>Phone number:</strong> the caller ID of the number you call or text from, if it is not blocked.</li>
  <li><strong>Call and message content:</strong> what you say on a call or send by text. Calls are answered by an AI assistant and may be recorded and transcribed. You are told this at the start of each call.</li>
  <li><strong>Information you give us:</strong> for example a name, callback number, or message you ask us to pass on, or an order number and the email or phone on an order you ask about.</li>
  <li><strong>Consent records:</strong> whether you agreed to receive texts, and any STOP or START replies.</li>
  <li><strong>Email address:</strong> only if you ask the assistant to email you links; stored masked, as described in the Email section below.</li>
  <li><strong>Technical information:</strong> standard server logs when you visit this website or when our service handles a call or text.</li>
</ul>
<p>We do not ask for, and the assistant will not accept, payment card or bank details by phone or text.</p>
<h2>How we use information</h2>
<ul>
  <li>To answer your call or text, look up the information you ask for, and send the links you request.</li>
  <li>To check the status of an order after verifying that you are the person on the order.</li>
  <li>To pass messages to Quanta X Technology staff and return your call when you ask.</li>
  <li>To honor your texting choices, keep the service secure, prevent abuse, and meet legal obligations.</li>
</ul>
<h2>How we share information</h2>
<p>We do not sell your personal information. We share it only with service providers that help us run the service, for example providers of AI voice processing, telephone, text message and email delivery, website hosting, and our online store platform, and only as needed for them to provide those services to us. We may also disclose information if required by law or to protect rights, safety, and property.</p>
${SMS_SECTION}
${EMAIL_SECTION}
<h2>Retention and security</h2>
<p>We keep information only as long as needed for the purposes above, including to resolve disputes and meet legal requirements. We use reasonable safeguards to protect it; for example, our system logs record phone numbers in a shortened, non-readable form. No method of transmission or storage is completely secure.</p>
<h2>Your choices</h2>
<ul>
  <li>Reply STOP to any text to opt out of texts.</li>
  <li>Email ${MAILTO} to ask about, correct, or delete information we hold about you. We will respond as required by applicable law.</li>
</ul>
<h2>Children</h2>
<p>Our service is not directed to children under 13, and we do not knowingly collect their personal information.</p>
<h2>Changes</h2>
<p>We may update this policy. The effective date above shows when it last changed.</p>
<h2>Contact</h2>
<p>${ADDRESS}<br>${MAILTO}</p>
<p>See also our <a href="/terms">Terms of Service</a>.</p>` });
}

function renderTerms() {
  return shell({ title: 'Terms of Service | CallBots', description: 'Terms for using callbots.org and phone lines answered by the CallBots AI assistant from Quanta X Technology LLC, including SMS terms.', path: '/terms', body: `
<h1>Terms of Service</h1>
<p class="eff">Effective date: ${EFFECTIVE}</p>
<p>These Terms govern your use of callbots.org and of phone and text lines answered by the CallBots AI assistant, including the RF Safe line (together, the "Service"). The Service is operated by ${OPERATOR.name}, a ${OPERATOR.state} limited liability company at ${OPERATOR.street}, ${OPERATOR.city}. By using the Service you agree to these Terms.</p>
<h2>The Service</h2>
<p>Calls are answered by an AI assistant, not a person, and may be recorded. The assistant answers from our published information, can text links you request, can look up an order after verifying you, and can take a message or transfer you to Quanta X Technology staff during business hours.</p>
<ul>
  <li>The assistant can make mistakes. Check important details on our official websites or with our staff.</li>
  <li>Information provided is general information, not medical, legal, or financial advice.</li>
  <li>We never take payments by phone or text. Orders are placed only on our official websites.</li>
</ul>
${SMS_SECTION}
<h2>Acceptable use</h2>
<p>Do not use the Service to break the law, harass anyone, send spam, or interfere with or try to gain unauthorized access to the Service.</p>
<h2>Trademarks</h2>
<p>RF Safe is a trademark of ${OPERATOR.name}. CallBots is a product of ${OPERATOR.name}. Other names belong to their owners.</p>
<h2>Disclaimers and limitation of liability</h2>
<p>The Service is provided "as is" and "as available", without warranties of any kind, to the extent permitted by law. To the extent permitted by law, ${OPERATOR.name} is not liable for indirect, incidental, special, or consequential damages arising from your use of the Service.</p>
<h2>Governing law</h2>
<p>These Terms are governed by the laws of the State of Florida, without regard to its conflict-of-law rules.</p>
<h2>Changes</h2>
<p>We may update these Terms. The effective date above shows when they last changed. Continued use of the Service means you accept the updated Terms.</p>
<h2>Contact</h2>
<p>${ADDRESS}<br>${MAILTO}</p>
<p>See also our <a href="/privacy">Privacy Policy</a>.</p>` });
}

module.exports = { renderPrivacy, renderTerms, EFFECTIVE };
