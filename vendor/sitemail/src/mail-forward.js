'use strict';
// Notice-only Resend inbound forward (ported from an earlier notice-forward module).
// POST /resend/inbound — verifies Svix signature, emails a notice to MAIL_FORWARD_TO.
// Body stays in the Resend inbox (notice-only; send-only API key is enough — same as BDO).
// Env: RESEND_WEBHOOK_SECRET, RESEND_API_KEY, MAIL_FORWARD_TO (comma-separated; falls back to SUPPORT_FORWARD_TO).
// Inbound match: any *@MAIL_FORWARD_DOMAIN (default: brand domain), or SUPPORT_INBOX list if set.
const B = require('./brand');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sign(secret, id, ts, body) {
  const raw = String(secret || '');
  const key = Buffer.from(raw.startsWith('whsec_') ? raw.slice(6) : raw, 'base64');
  return crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
}

function verify(secret, id, ts, sigs, body, now = Math.floor(Date.now() / 1000)) {
  if (!secret || !id || !/^\d+$/.test(String(ts)) || Math.abs(now - Number(ts)) > 300) return false;
  const want = sign(secret, id, String(ts), body);
  for (const part of String(sigs || '').trim().split(/\s+/)) {
    const [v, sig] = part.split(',', 2);
    if (v === 'v1' && sig && sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return true;
  }
  return false;
}

function addrs(v) {
  const out = [];
  for (const a of [].concat(v || [])) {
    let s = a;
    if (a && typeof a === 'object') s = a.email || a.address || '';
    const m = String(s || '').match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+/g);
    if (m) for (const e of m) out.push(e.toLowerCase());
  }
  return out;
}

function storePath(dataDir) {
  return path.join(dataDir || '/var/data', 'mail-forwards.json');
}

function loadSent(file) {
  try { return new Set(JSON.parse(fs.readFileSync(file, 'utf8')).sent || []); } catch { return new Set(); }
}

function markSent(file, id, status) {
  let data = { sent: [] };
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const sent = new Set(data.sent || []);
  if (status === 'sent') sent.add(id);
  const out = { sent: [...sent].slice(-5000), last: { id, status, at: new Date().toISOString() } };
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(out)); } catch { /* ignore */ }
}

async function handle({ req, res, body, env, fetchImpl = globalThis.fetch, now = () => Math.floor(Date.now() / 1000), json }) {
  const secret = env.RESEND_WEBHOOK_SECRET || '';
  const apiKey = env.RESEND_API_KEY || '';
  // Comma-separated forward targets. Prefer MAIL_FORWARD_TO; SUPPORT_FORWARD_TO kept as alias.
  const targets = String(env.MAIL_FORWARD_TO || env.SUPPORT_FORWARD_TO || 'support@quantaxtechnology.com')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const domain = String(env.MAIL_FORWARD_DOMAIN || B.domain).toLowerCase().replace(/^@/, '');
  // Optional explicit inbox list; otherwise any address on MAIL_FORWARD_DOMAIN.
  const inboxes = String(env.SUPPORT_INBOX || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const fromName = env.SUPPORT_FORWARD_FROM || env.MAIL_FORWARD_FROM || B.from;
  const inboxUrl = env.RESEND_INBOX_URL || 'https://resend.com/emails';
  if (!secret || !apiKey || !targets.length) return json(res, 503, { error: 'not_configured' });

  const id = req.headers['svix-id'] || req.headers['webhook-id'] || '';
  const ts = req.headers['svix-timestamp'] || req.headers['webhook-timestamp'] || '';
  const sigs = req.headers['svix-signature'] || req.headers['webhook-signature'] || '';
  if (!verify(secret, id, ts, sigs, body, now())) return json(res, 401, { error: 'bad_signature' });

  let ev;
  try { ev = JSON.parse(body); } catch { return json(res, 400, { error: 'bad_json' }); }
  if (!ev || !['email.received', 'inbox.email.received'].includes(ev.type)) return json(res, 200, { ok: true, skipped: 'event' });

  const d = ev.data || {};
  const eid = String(d.email_id || d.id || '');
  if (!/^[A-Za-z0-9-]{8,80}$/.test(eid)) return json(res, 200, { ok: true, skipped: 'no_id' });

  const file = storePath(env.DATA_DIR);
  if (loadSent(file).has(eid)) return json(res, 200, { ok: true, skipped: 'duplicate' });

  const rcpt = [...addrs(d.to), ...addrs(d.cc)];
  const matched = rcpt.find((e) => inboxes.length ? inboxes.includes(e) : e.endsWith('@' + domain));
  if (!matched) return json(res, 200, { ok: true, skipped: 'not_support' });

  const hdr = Object.fromEntries(Object.entries(d.headers || {}).map(([k, v]) => [String(k).toLowerCase(), v]));
  let subj = String(d.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || '(no subject)';
  if (hdr['x-qd-forwarded'] || hdr['x-bdo-forwarded'] || subj.startsWith('New support email: ')) {
    return json(res, 200, { ok: true, skipped: 'loop' });
  }
  const from = String(d.from || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  const fromAddr = addrs(from)[0] || '';
  const date = String(d.created_at || ev.created_at || '');
  const text = `New email to ${matched}\n\nFrom: ${from || '(unknown)'}\nSubject: ${subj}\nDate: ${date}\nResend email id: ${eid}\n\nRead it in the Resend inbox: ${inboxUrl}\n\nReplying to this notice replies to the sender.\n`;
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<p>New email to ${esc(matched)}</p><p><b>From:</b> ${esc(from || '(unknown)')}<br><b>Subject:</b> ${esc(subj)}<br><b>Date:</b> ${esc(date)}<br><b>Resend email id:</b> ${esc(eid)}</p><p><a href="${esc(inboxUrl)}">Open the Resend inbox</a></p><p style="color:#777;font-size:12px">Replying to this notice replies to the sender.</p>`;
  const payload = {
    from: fromName,
    to: targets,
    subject: 'New support email: ' + subj,
    text,
    html,
    headers: { 'X-QD-Forwarded': eid },
    ...(fromAddr ? { reply_to: [fromAddr] } : {}),
  };
  const r = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json', 'Idempotency-Key': 'qd-fwd-' + eid },
    body: JSON.stringify(payload),
  });
  const ok = r.status >= 200 && r.status < 300;
  markSent(file, eid, ok ? 'sent' : 'failed');
  if (!ok) return json(res, 502, { error: 'send_failed' });
  let sid = '';
  try { sid = String((await r.json()).id || ''); } catch {}
  return json(res, 200, { ok: true, forwarded: true, resend_id: sid });
}

module.exports = { handle, verify, sign, addrs };
