'use strict';
// Owner briefing settings (tenant.owner_briefing). OFF unless enabled === true.
const E164 = /^\+[1-9]\d{7,14}$/;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const KEYS = ['enabled', 'owner_numbers', 'daily_call', 'daily_time', 'timezone', 'daily_numbers', 'copy_sms', 'copy_email', 'emergency_alerts', 'alert_numbers', 'alert_max_per_day', 'alert_min_gap_minutes', 'quiet_hours', 'quiet_hours_allow', 'error_threshold', 'error_window_minutes', 'on_demand', 'transfer_fallback', 'transfer_bridge_uri', 'voice', 'twilio_voice', 'grok_sip_domain'];
const ALERT_KINDS = ['safety', 'legal', 'angry', 'urgent_callback', 'system_errors'];
const DEFAULTS = {
  enabled: false, daily_call: true, daily_time: '18:00', timezone: 'America/New_York', copy_sms: false, copy_email: false,
  emergency_alerts: true, alert_max_per_day: 3, alert_min_gap_minutes: 30, quiet_hours: { start: '21:00', end: '08:00' }, quiet_hours_allow: ['safety'],
  error_threshold: 5, error_window_minutes: 15, on_demand: true, transfer_fallback: true, voice: 'grok', twilio_voice: 'Polly.Joanna', grok_sip_domain: 'sip.voice.x.ai',
};

function settings(tenant) { const s = (tenant && tenant.owner_briefing) || {}; return { ...DEFAULTS, ...s, quiet_hours: { ...DEFAULTS.quiet_hours, ...(s.quiet_hours || {}) } }; }
// 'grok' (default): bridge the answered call into Grok Voice over SIP. 'twilio': Twilio text-to-speech.
// A legacy Twilio voice name in `voice` (e.g. Polly.Joanna) means twilio mode with that voice.
function voiceMode(tenant) { const v = settings(tenant).voice; return v === 'twilio' || (v !== 'grok' && v) ? 'twilio' : 'grok'; }
function twilioVoice(tenant) { const s = settings(tenant); return s.voice !== 'grok' && s.voice !== 'twilio' && s.voice ? s.voice : s.twilio_voice; }
function enabled(tenant) { return !!(tenant && tenant.owner_briefing && tenant.owner_briefing.enabled === true); }

// Owner numbers: explicit list, else known_callers whose role mentions admin/owner.
function ownerNumbers(tenant) {
  const s = settings(tenant);
  if (Array.isArray(s.owner_numbers) && s.owner_numbers.length) return s.owner_numbers.filter((n) => E164.test(n));
  return Object.entries(tenant.known_callers || {}).filter(([n, v]) => E164.test(n) && v && /admin|owner/i.test(String(v.role || ''))).map(([n]) => n);
}
function isOwner(tenant, number) { return !!number && ownerNumbers(tenant).includes(number); }
function ownerName(tenant, number) { const k = (tenant.known_callers || {})[number]; return k && k.name ? k.name : 'there'; }
function listOr(list, fallback) { return Array.isArray(list) && list.length ? list : fallback; }
function dailyNumbers(tenant) { const own = ownerNumbers(tenant); return listOr(settings(tenant).daily_numbers, own).filter((n) => own.includes(n)); }
function alertNumbers(tenant) { const own = ownerNumbers(tenant); return listOr(settings(tenant).alert_numbers, own).filter((n) => own.includes(n)); }

function validate(v) {
  const errs = [];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return ['owner_briefing must be an object'];
  const bad = Object.keys(v).filter((k) => !KEYS.includes(k)); if (bad.length) errs.push('owner_briefing: unknown field(s) ' + bad.join(', ') + ' (the PIN is set with POST /admin/tenants/<id>/owner-pin)');
  for (const k of ['enabled', 'daily_call', 'copy_sms', 'copy_email', 'emergency_alerts', 'on_demand', 'transfer_fallback']) if (k in v && typeof v[k] !== 'boolean') errs.push(`owner_briefing.${k} must be boolean`);
  for (const k of ['owner_numbers', 'daily_numbers', 'alert_numbers']) if (k in v && !(Array.isArray(v[k]) && v[k].length <= 5 && v[k].every((n) => E164.test(n)))) errs.push(`owner_briefing.${k} must be up to 5 E.164 numbers`);
  if ('daily_time' in v && !HM.test(v.daily_time)) errs.push('owner_briefing.daily_time must be HH:MM (24h)');
  if ('timezone' in v) { try { new Intl.DateTimeFormat('en-US', { timeZone: v.timezone }); } catch { errs.push('owner_briefing.timezone must be an IANA zone'); } }
  if ('quiet_hours' in v && !(v.quiet_hours && HM.test(v.quiet_hours.start) && HM.test(v.quiet_hours.end))) errs.push('owner_briefing.quiet_hours needs start and end (HH:MM)');
  if ('quiet_hours_allow' in v && !(Array.isArray(v.quiet_hours_allow) && v.quiet_hours_allow.every((k) => ALERT_KINDS.includes(k)))) errs.push('owner_briefing.quiet_hours_allow must list kinds from ' + ALERT_KINDS.join(', '));
  for (const [k, lo, hi] of [['alert_max_per_day', 0, 20], ['alert_min_gap_minutes', 5, 1440], ['error_threshold', 2, 100], ['error_window_minutes', 1, 240]]) if (k in v && !(Number.isInteger(v[k]) && v[k] >= lo && v[k] <= hi)) errs.push(`owner_briefing.${k} must be an integer ${lo}-${hi}`);
  if ('transfer_bridge_uri' in v && v.transfer_bridge_uri !== null && !/^(tel:\+[1-9]\d{7,14}|sip:[^\s]+)$/.test(String(v.transfer_bridge_uri))) errs.push('owner_briefing.transfer_bridge_uri must be tel:+E164 or sip:');
  if ('voice' in v && !/^[A-Za-z][A-Za-z0-9.-]{1,40}$/.test(String(v.voice))) errs.push("owner_briefing.voice must be 'grok', 'twilio', or a Twilio voice name");
  if ('twilio_voice' in v && !/^[A-Za-z][A-Za-z0-9.-]{1,40}$/.test(String(v.twilio_voice))) errs.push('owner_briefing.twilio_voice must be a Twilio voice name');
  if ('grok_sip_domain' in v && !/^[a-z0-9.-]{3,80}$/i.test(String(v.grok_sip_domain))) errs.push('owner_briefing.grok_sip_domain must be a hostname');
  return errs;
}

// Local wall clock in a zone: { date: 'YYYY-MM-DD', hm: 'HH:MM' }
function localParts(now, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}
function inQuietHours(tenant, now) {
  const s = settings(tenant); const { hm } = localParts(now, s.timezone); const { start, end } = s.quiet_hours;
  if (start === end) return false;
  return start < end ? hm >= start && hm < end : hm >= start || hm < end;
}

module.exports = { settings, voiceMode, twilioVoice, enabled, ownerNumbers, isOwner, ownerName, dailyNumbers, alertNumbers, validate, localParts, inQuietHours, DEFAULTS, ALERT_KINDS, E164 };
