'use strict';
// PREFERENCES PAGES - v1.0 (server-rendered HTML; no JS needed)
const h = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CSS = 'main{max-width:640px;margin:40px auto;padding:0 20px}.card{border:1px solid rgba(127,127,127,.35);border-radius:12px;padding:18px 20px;margin:16px 0}label{display:block;margin:10px 0}input[type=email],input[type=tel],input[type=text]{-webkit-appearance:none;appearance:none;box-sizing:border-box;display:block;width:100%;padding:10px;font:inherit;font-size:16px;line-height:1.4;border-radius:8px;border:1px solid #888;background-color:var(--pf-in-bg);color:var(--pf-in-ink);color-scheme:dark;caret-color:var(--pf-in-ink)}input[type=email]::placeholder,input[type=tel]::placeholder,input[type=text]::placeholder{color:var(--pf-in-ph);opacity:1}input[type=email]:focus,input[type=tel]:focus,input[type=text]:focus{outline:none}input[type=email]:focus-visible,input[type=tel]:focus-visible,input[type=text]:focus-visible{outline:3px solid var(--pf-focus);outline-offset:2px;border-color:var(--pf-focus)}input:-webkit-autofill,input:-webkit-autofill:hover,input:-webkit-autofill:focus{-webkit-text-fill-color:var(--pf-in-ink);-webkit-box-shadow:0 0 0 1000px var(--pf-in-bg) inset;box-shadow:0 0 0 1000px var(--pf-in-bg) inset;caret-color:var(--pf-in-ink);transition:background-color 9999s ease-out 0s}input[type=email]:disabled,input[type=tel]:disabled,input[type=text]:disabled{background-color:var(--pf-dis-bg);color:var(--pf-dis-ink);border-style:dashed;border-color:var(--pf-dis-line);cursor:not-allowed;opacity:1}input[type=tel]:disabled::placeholder{color:var(--pf-dis-ph)}button{font-size:16px;padding:10px 18px;border:0;border-radius:8px;background:#0b5;color:#fff;cursor:pointer;margin-top:10px}button.out{background:#b33}.mut{opacity:.75;font-size:14px}.soon{font-weight:600}fieldset{border:0;padding:0;margin:0}fieldset[disabled]{opacity:.55}.err{color:#d33}.sec-toggle{font-size:1.05rem;margin:6px 0 10px}.sec-body{margin:0 0 6px 4px}button:disabled{opacity:.5;cursor:not-allowed}.ok{color:#0a5}'
  + '.sel-label{display:block;margin:12px 0 6px;font-weight:600}'
  + 'select.pref-select{-webkit-appearance:none;-moz-appearance:none;appearance:none;box-sizing:border-box;display:block;width:100%;padding:10px 42px 10px 10px;font:inherit;font-size:16px;line-height:1.4;border-radius:8px;border:1px solid #888;background-color:var(--pf-in-bg);color:var(--pf-in-ink);color-scheme:dark;cursor:pointer;background-image:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 16 16%27%3E%3Cpath d=%27M3 6l5 5 5-5%27 fill=%27none%27 stroke=%27%23CHEV%27 stroke-width=%272%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;background-size:16px 16px}'
  + 'select.pref-select::-ms-expand{display:none}select.pref-select option{background-color:var(--pf-in-bg);color:var(--pf-in-ink)}select.pref-select option:disabled{color:var(--pf-in-ph)}'
  + 'select.pref-select:focus{outline:none}select.pref-select:focus-visible{outline:3px solid var(--pf-focus);outline-offset:2px;border-color:var(--pf-focus)}';
// Theme colours for inputs/select come from site.theme (defaults: the dark QuantaDose palette).
const THEME = { inBg: '#120c2e', inInk: '#f4f1ff', inPh: '#b3a9d9', focus: '#9b5cff', disBg: '#1d1a2b', disInk: '#9a94b3', disLine: '#5c5670', disPh: '#c9c3de' };
function themedCss(site) {
  const isHex = (c) => /^#[0-9a-fA-F]{3,8}$/.test(String(c)); const given = site.theme || {}; const t = {};
  for (const k of Object.keys(THEME)) t[k] = isHex(given[k]) ? given[k] : THEME[k]; // hex colours only; anything else falls back
  return `:root{--pf-in-bg:${t.inBg};--pf-in-ink:${t.inInk};--pf-in-ph:${t.inPh};--pf-focus:${t.focus};--pf-dis-bg:${t.disBg};--pf-dis-ink:${t.disInk};--pf-dis-line:${t.disLine};--pf-dis-ph:${t.disPh}}`
    + CSS.replace(/%23CHEV/g, '%23' + t.inInk.slice(1)) + (site.extraCss || '');
}
function pageHtml(site, body) {
  const title = `Email &amp; text preferences · ${h(site.siteName)}`;
  if (typeof site.layout === 'function') return site.layout({ title, css: themedCss(site), body }); // site supplies its own shell (header/footer)
  return `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta name=robots content=noindex><title>${title}</title><link rel=stylesheet href="${h(site.stylesheet)}"><style>${themedCss(site)}</style></head><body>`
    + `<nav class=top><div class=wrap>${site.brandHtml}</div></nav><main>${body}</main><footer><div class="wrap foot">${site.footerHtml}</div></footer></body></html>`;
}
const smsSoon = (site) => `<p class="soon" id=sms-soon>${h(site.smsComingSoon)}</p>`;
function entryBody(site, { smsOn, error } = {}) {
  return `<h1>Email &amp; text preferences</h1><p>${h(site.entryIntro || ('Manage the ' + site.siteName + ' newsletter, support texts and news and sales texts.'))} Enter your email and we will send you a one-time sign-in link.</p>`
    + (error ? `<p class=err>${h(error)}</p>` : '')
    + `<form method=post action="/preferences/start" class=card><label>Email<input type=email name=email autocomplete=email maxlength=254></label>`
    + (smsOn ? `<label>Mobile number (optional, or use it alone to get a text code)<input type=tel name=phone autocomplete=tel maxlength=20></label>` : `<label>Mobile number<input type=tel name=phone disabled placeholder="${h(site.smsComingSoon)}"></label>${smsSoon(site)}`)
    + `<button type=submit>Send my sign-in link</button></form><p class=mut>Questions? Email <a href="mailto:${h(site.supportEmail)}">${h(site.supportEmail)}</a>.</p>`;
}
const sentBody = (site, msg) => `<h1>Check your email</h1><p>${h(msg)}</p><p class=mut><a href="/preferences">Back</a></p>`;
const codeBody = (site, { phone, msg }) => `<h1>Enter your code</h1><p>${h(msg)}</p><form method=post action="/preferences/code" class=card><input type=hidden name=phone value="${h(phone)}"><label>6-digit code<input type=text name=code inputmode=numeric pattern="[0-9]{6}" maxlength=6 autocomplete=one-time-code></label><button type=submit>Sign in</button></form>`;
const continueBody = (site, tok) => `<h1>Manage your preferences</h1><p>Press the button to sign in. This link works once.</p><form method=post action="/preferences/verify"><input type=hidden name=t value="${h(tok)}"><button type=submit>Continue</button></form>`;
const msgBody = (site, title, html) => `<h1>${h(title)}</h1><p>${html}</p>`;
function manageBody(site, { s, st, csrf, saved, err }) {
  const T = site.topics; const chk = (b) => (b ? ' checked' : '');
  const who = [s.email ? h(s.email) : '', s.phone ? h(s.phone.replace(/^(\+\d)\d+(\d{4})$/, '$1•••$2')) : ''].filter(Boolean).join(' · ');
  const smsMO = site.smsWebOptIn === false; const callNote = smsMO ? `<p class=mut id=call-to-join>To sign up for texts, call <a href="tel:${h(site.callNumberE164)}">${h(site.callNumber)}</a> and ask.</p>` : '';
  const moSms = () => { // manage-only: a type can only be switched off; an off type is shown disabled with the call note
    const on = (b) => (b ? ' checked' : ' disabled'); const newsOn = ['subscribed', 'pending'].includes(st.news_sms);
    return `<fieldset><label><input type=checkbox name=support_sms${on(st.support_sms)}> ${h(T.support_sms.label)}</label><p class=mut>${h(T.support_sms.help)}</p>`
      + `<label><input type=checkbox name=news_sms${on(newsOn)}> ${h(T.news_sms.label)}</label><p class=mut>${h(T.news_sms.help)}</p>`
      + (newsOn ? `<p>How often:</p>${Object.entries(site.freqLabels).map(([k, v]) => `<label><input type=radio name=news_freq value="${k}"${chk(st.news_freq === k)}> ${h(v)}</label>`).join('')}` : '')
      + `<p class=mut>Unticking link texts stops all texts to this number, the same as replying STOP.</p></fieldset>${callNote}`;
  };
  const SEC = site.sections || {}; const newsOn = ['subscribed', 'pending'].includes(st.news_sms); const anyText = !!(st.support_sms || st.support_pending || newsOn);
  const PAT = '(\\+?1)?(\\s|-|\\.)?\\(?[2-9][0-9]{2}\\)?(\\s|-|\\.)?[2-9][0-9]{2}(\\s|-|\\.)?[0-9]{4}';
  const toggle = (id, label, on) => `<label class=sec-toggle><input type=checkbox id=${id} data-toggle${chk(on)}> <strong>${h(label)}</strong></label>`;
  const dep = (id, inner) => `<div class=sec-body data-for=${id}>${inner}</div>`;
  const emailToggleLabel = SEC.emailToggle || `Get ${T.newsletter.label} by email`; const textsToggleLabel = SEC.textsToggle || `Get texts from ${site.siteName}`;
  let emailCard;
  if (s.email && site.emailWebSignup === false && !st.newsletter && !st.can_rejoin_email) emailCard = `<div class=card id=email-sec><h2>Email</h2><p class=mut>This address is not on the newsletter list. To join, ask on a call.</p></div>`;
  else if (s.email) emailCard = `<form method=post action="/preferences/save" class=card id=email-sec><input type=hidden name=csrf value="${h(csrf)}"><input type=hidden name=section value=email><h2>Email</h2>`
    + `<label class=sec-toggle><input type=checkbox name=newsletter id=nl-box data-toggle${chk(st.newsletter || err === 'name')}> <strong>${h(emailToggleLabel)}</strong></label>`
    + dep('nl-box', `<p class=mut>${h(T.newsletter.help)}</p><label for=nl-name>Name (required for the newsletter)</label><input type=text name=name id=nl-name maxlength=80 autocomplete=name value="${h(st.name)}">`)
    + (err === 'name' ? '<p class=err>Please enter your name to get the newsletter.</p>' : '') + `<button type=submit>Save email preferences</button></form>`;
  else emailCard = `<form method=post action="/preferences/start" class=card id=email-sec><input type=hidden name=from value=manage><h2>Email</h2>${toggle('nl-box', emailToggleLabel, false)}`
    + dep('nl-box', `<p class=mut>${h(T.newsletter.help)}</p><label for=nl-email>Email</label><input type=email name=email id=nl-email autocomplete=email maxlength=254><p class=mut>We will email you a one-time link. Open it to finish joining and add your name.</p>`
      + (err === 'bademail' ? '<p class=err>Enter a valid email address.</p>' : '') + `<button type=submit>Email me a link</button>`) + `</form>`;
  let textsCard;
  if (smsMO) textsCard = `<form method=post action="/preferences/save" class=card id=texts-sec><input type=hidden name=csrf value="${h(csrf)}"><input type=hidden name=section value=texts><h2>Texts</h2>`
    + (st.sms_available && s.phone ? moSms() + `<button type=submit>Save text preferences</button>` : `<p class=mut>${s.phone ? 'This number has no text subscriptions from a call.' : 'Sign in with your mobile number to manage texts.'}</p>${callNote}`) + `</form>`;
  else if (!st.sms_available) textsCard = `<div class=card id=texts-sec><h2>Texts</h2><fieldset disabled><label><input type=checkbox disabled> ${h(T.support_sms.label)}</label><label><input type=checkbox disabled> ${h(T.news_sms.label)}</label></fieldset>${smsSoon(site)}</div>`;
  else if (s.phone) textsCard = `<form method=post action="/preferences/save" class=card id=texts-sec><input type=hidden name=csrf value="${h(csrf)}"><input type=hidden name=section value=texts><h2>Texts</h2>${toggle('tx-box', textsToggleLabel, anyText)}`
    + dep('tx-box', `<label><input type=checkbox class=tx-type name=support_sms${chk(st.support_sms || st.support_pending)}> ${h(T.support_sms.label)}${st.support_pending ? ' <em>(waiting for your YES reply)</em>' : ''}</label><p class=mut>${h(T.support_sms.help)}</p>`
      + `<label><input type=checkbox class=tx-type name=news_sms${chk(newsOn)}> ${h(T.news_sms.label)}${st.news_sms === 'pending' ? ' <em>(waiting for your YES reply)</em>' : ''}</label><p class=mut>${h(T.news_sms.help)}</p>`
      + `<p>How often:</p>${Object.entries(site.freqLabels).map(([k, v]) => `<label><input type=radio name=news_freq value="${k}"${chk(st.news_freq === k)}> ${h(v)}</label>`).join('')}`
      + `<div class=card id=sms-consent><p>${h(site.smsConsentText)}</p><label><input type=checkbox name=consent value=yes> I agree</label></div>`)
    + (err === 'consent_required' ? '<p class=err>To turn on texts, read the text terms and tick &ldquo;I agree&rdquo;.</p>' : '') + `<button type=submit>Save text preferences</button></form>`;
  else textsCard = `<form method=post action="/preferences/start" class=card id=texts-sec><input type=hidden name=from value=manage><h2>Texts</h2>${toggle('tx-box', textsToggleLabel, err === 'badphone')}`
    + dep('tx-box', `<label for=tx-phone>Mobile number</label><input type=tel name=phone id=tx-phone autocomplete=tel inputmode=tel maxlength=20 pattern="${PAT}" title="A US mobile number, like (727) 555-0123"${err === 'badphone' ? ' aria-invalid=true' : ''}>`
      + `<p class="err" id=tx-phone-err${err === 'badphone' ? '' : ' hidden'}>Enter a valid US mobile number, like (727) 555-0123.</p>`
      + `<p class=mut>We will text you a 6-digit code. After you enter it, you can pick link texts, news texts and how often.</p><button type=submit id=tx-send>Text me a code</button>`) + `</form>`;
  const script = `<script>(function(){function sync(b){var d=document.querySelector('[data-for="'+b.id+'"]');if(!d)return;d.hidden=!b.checked;if(b.id==='nl-box'){var n=document.getElementById('nl-name')||document.getElementById('nl-email');if(n)n.required=b.checked;}if(b.id==='tx-box'&&!b.checked){d.querySelectorAll('.tx-type').forEach(function(c){c.checked=false;});}}`
    + `document.querySelectorAll('input[data-toggle]').forEach(function(b){sync(b);b.addEventListener('change',function(){sync(b);});});`
    + `var p=document.getElementById('tx-phone'),s=document.getElementById('tx-send'),e=document.getElementById('tx-phone-err');if(p&&s){var re=new RegExp('^(?:'+p.getAttribute('pattern')+')$');function v(){var ok=re.test(p.value.trim());s.disabled=!ok;if(e&&p.value.trim().length>=10)e.hidden=ok;}p.addEventListener('input',v);p.required=true;v();}})();</script>`;
  const tb = site.thanksBanner; const subs = tb ? [st.newsletter && tb.items.newsletter, (st.support_sms) && tb.items.support_sms, st.news_sms === 'subscribed' && tb.items.news_sms].filter(Boolean) : [];
  const banner = subs.length ? `<div class=card id=thanks-banner role=status style="background:var(--tint,#e7f3ee);border-color:var(--accent,#0d5c4d)"><p style="margin:0 0 .3rem;font-weight:650">${h(tb.title)}</p><p class=mut style="margin:0">${h(tb.lead)} ${h(subs.join(', '))}.</p></div>` : '';
  return `<h1>Your preferences</h1><p class=mut>Signed in as ${who}</p><form method=post action="/preferences/logout" id=not-you style="margin:-.4rem 0 .8rem"><input type=hidden name=csrf value="${h(csrf)}"><button type=submit style="background:none;color:var(--accent,#0d5c4d);padding:0;margin:0;text-decoration:underline;font-size:14px">Not you? Sign out</button></form>${banner}`
    + (saved === 'all' ? '<p class=ok>You are unsubscribed from everything.</p>' : saved === 'texts' ? '<p class=ok>Done. That number will not get any more texts from us. Reply START to a text from us if you change your mind.</p>' : saved === 'all-email' ? '<p class=ok>You are unsubscribed from all emails. No mobile number was given, so to also stop texts, enter your number above and choose texts.</p>' : saved === 'emails' ? '<p class=ok>Done. You will not get any more newsletter emails from us.</p>' : saved ? '<p class=ok>Saved.</p>' : '')
    + (err === 'phone' ? '<p class=err>Enter a valid mobile number to stop texts.</p>' : err === 'limit' ? '<p class=err>Too many requests. Please try again in 15 minutes.</p>' : err === 'pick' ? '<p class=err>Choose an option first.</p>' : '')
    + (err === 'sms_signup_by_phone' ? `<p class=err>Texts can only be turned on by phone. To sign up for texts, call ${h(site.callNumber)} and ask.</p>` : '')
    + (err === 'email_signup_by_phone' ? '<p class=err>This address is not on the newsletter list. To join, ask on a call.</p>' : '')
    + emailCard + textsCard
    + `<form method=post action="/preferences/unsubscribe" class=card id=unsubscribe><input type=hidden name=csrf value="${h(csrf)}"><h2>Unsubscribe</h2><label for=unsub-scope class=sel-label>What would you like to stop?</label><select id=unsub-scope name=scope class=pref-select required><option value="" disabled selected>Select an option</option><option value=texts>Unsubscribe from all texts</option><option value=emails>Unsubscribe from all emails</option><option value=all>Unsubscribe from everything (texts and email)</option></select>`
    + (s.phone ? '' : `<label>Mobile number to stop texts to (optional)<input type=tel name=phone autocomplete=tel maxlength=20></label><p class=mut>Used only to stop texts to that number. It is never used to sign you up.</p>`)
    + `<button class=out type=submit>Confirm unsubscribe</button></form>`
    + `<form method=post action="/preferences/unsubscribe-all" class=card><input type=hidden name=csrf value="${h(csrf)}"><p>Stop every ${h(site.siteName)} email newsletter and text.</p><button class=out type=submit>Unsubscribe from everything</button></form>`
    + `<form method=post action="/preferences/logout"><input type=hidden name=csrf value="${h(csrf)}"><button type=submit style="background:#666">Sign out</button></form>` + script;
}
module.exports = { themedCss, THEME, pageHtml, entryBody, sentBody, codeBody, continueBody, manageBody, msgBody, h };
