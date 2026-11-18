'use strict';
// Edge testing page body (HTML, escaped, no scripts). The host wraps it in its admin layout. Works at the admin's
// 980px breakpoint: the side-by-side comparison stacks into one column on small screens.
const { runLabel } = require('./store');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => '$' + (Number(n) || 0).toFixed(2);
const usd3 = (n) => '$' + (Number(n) || 0).toFixed(3);
const DISP = { sent: 'Sent', would_send: 'Would send', held: 'Held', no_reply: 'No reply', spam: 'Sorted to Spam', archive: 'Sorted to Archive', error: 'Error', skipped_cost_cap: 'Skipped: cost cap' };
const chip = (cls, text, title) => `<span class="ec ${esc(cls)}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
const dispChip = (r) => chip(r.disposition === 'sent' || r.disposition === 'would_send' ? 'ok' : r.disposition === 'error' || r.disposition === 'skipped_cost_cap' ? 'bad' : 'warn', DISP[r.disposition] || r.disposition);
const verdictChip = (r) => r.checker_verdict ? chip(r.checker_verdict === 'pass' ? 'ok' : r.checker_verdict === 'fail' ? 'bad' : 'warn', 'Checker ' + r.checker_verdict) : '';
const pfChip = (r) => r.pass_fail ? chip(r.pass_fail === 'pass' ? 'ok' : r.pass_fail === 'fail' ? 'bad' : 'warn', 'Baseline ' + r.pass_fail, r.pass_fail_notes) : '';
const gradeChip = (g) => g ? chip(g.grade === 'better' ? 'ok' : g.grade === 'worse' ? 'bad' : 'mid', 'Agent: ' + g.grade, g.reason) : '';
const reviewChip = (v) => v ? chip(v.verdict === 'pass' ? 'ok' : 'bad', 'Human ' + v.verdict, v.note) : chip('mid', 'Not reviewed');

const EDGE_CSS = `.et-sub{color:var(--muted);margin:0 0 14px}.et-panel{border:1px solid var(--line);background:var(--panel2);border-radius:16px;padding:14px 16px;margin:0 0 16px}
.et-panel p{margin:6px 0}.et-panel button:disabled{opacity:.45;cursor:not-allowed;filter:grayscale(.6)}.et-bar{height:10px;border-radius:6px;background:var(--line);overflow:hidden;margin:8px 0}.et-bar i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2))}
.ec{display:inline-block;font-size:12px;line-height:1;padding:5px 8px;border-radius:999px;border:1px solid var(--line);margin:0 6px 6px 0;white-space:nowrap}.ec.ok{color:#1a7f37;border-color:#1a7f3766;background:#1a7f3714}.ec.bad{color:#d1242f;border-color:#d1242f66;background:#d1242f14}.ec.warn{color:#9a6700;border-color:#9a670066;background:#9a670014}.ec.mid{color:var(--muted)}.ec.tag{font-weight:600;color:var(--text)}
.et-card{border:1px solid var(--line);border-radius:16px;padding:14px 16px;margin:0 0 14px;background:var(--panel2)}.et-card h3{margin:0 0 4px;font-size:16px}.et-card h3 a{color:var(--text);text-decoration:none}
.et-q,.et-a{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:14px;line-height:1.45;margin:6px 0 10px;padding:10px 12px;border-radius:12px;border:1px solid var(--line)}.et-q{background:var(--panel)}.et-a{background:transparent}
.et-clamp{max-height:9.5em;overflow:hidden;position:relative}.et-lbl{font-size:12px;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);margin:10px 0 2px}
.et-runs{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 12px}.et-runs a{font-size:13px;padding:7px 11px;border-radius:12px;border:1px solid var(--line);text-decoration:none;color:var(--text);background:var(--panel)}.et-runs a.on{border-color:var(--accent);font-weight:650}
.et-sbs{display:grid;grid-template-columns:1fr 1fr;gap:14px}.et-sbs>div{min-width:0}.et-sbs h4{margin:0 0 4px;font-size:14px}
.et-filter{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}.et-filter a{font-size:13px;padding:6px 11px;border-radius:999px;border:1px solid var(--line);text-decoration:none;color:var(--text)}.et-filter a.on{border-color:var(--accent);font-weight:650}
.et-form textarea{width:100%;box-sizing:border-box;min-height:70px;padding:8px 10px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--text);font:inherit}.et-form label{display:inline-block;margin:0 14px 6px 0}
.et-msg{padding:9px 12px;border-radius:12px;border:1px solid var(--line);margin:0 0 12px}.et-msg.bad{border-color:#d1242f88}.et-foot{color:var(--muted);font-size:12px;margin-top:18px}
@media (max-width:980px){.et-sbs{grid-template-columns:1fr}.et-card,.et-panel{padding:12px}.et-q,.et-a{font-size:13.5px}}`;

function runPanel({ base, csrf, est, running, latest, cap }) {
  if (running) {
    const pct = running.total ? Math.round(100 * running.done / running.total) : 0;
    return `<section class="et-panel" aria-live="polite"><p><b>Rerun in progress: ${esc(runLabel(running))}</b> ${chip('warn', 'Dry run · nothing is sent')}</p>
<div class="et-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${running.total}" aria-valuenow="${running.done}"><i style="width:${pct}%"></i></div>
<p>${running.done} of ${running.total} tests done${running.current ? ` · now: ${esc(running.current)}` : ''}</p>
<p><small>Model cost so far ${usd3(running.cost_usd)} of about ${usd(running.est_cost_usd)} estimated. This page refreshes every 5 seconds.</small></p>
<form method="post" action="${esc(base)}/run"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit" disabled>Rerun edge testing</button></form></section>`;
  }
  const over = est.total > cap.remaining + 1e-9;
  return `<section class="et-panel"><form method="post" action="${esc(base)}/run"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit"${over || !est.tests ? ' disabled' : ''}>Rerun edge testing</button></form>
<p><small><b>Dry run:</b> every test goes through the real sorter, writer and checker. Nothing is emailed, no customer thread is touched, and orders are never looked up or changed.</small></p>
<p><small>Estimated model cost ${usd(est.total)} for ${est.tests} test${est.tests === 1 ? '' : 's'} (${usd3(est.per_test)} each, ${esc(est.basis)}; includes the agent grade). Edge-run cap ${usd(cap.cap)} per day (New York time); ${usd3(cap.spent)} used today.</small></p>
${over ? `<p class="et-msg bad">The estimate is over what is left of today's edge-run cap (${usd3(cap.remaining)}). Try again tomorrow.</p>` : ''}
${latest ? `<p><small>Latest run: ${esc(runLabel(latest))}${latest.kind === 'import' ? ' (imported baseline)' : ''}${latest.status && latest.status !== 'done' ? ' · ' + esc(latest.status) : ''}</small></p>` : ''}</section>`;
}

function listPage(m) {
  const { base, csrf, site, version, prompt, tests, rows, est, running, latest, cap, filter, msg } = m;
  const F = [['all', 'All'], ['fail', 'Checker or baseline fail'], ['worse', 'Agent: worse'], ['review', 'Needs human review']];
  const cards = rows.map(({ t, cur, curRun, grade, review }) => `<article class="et-card"><h3><a href="${esc(base)}?test=${encodeURIComponent(t.id)}">${esc(t.subject)}</a></h3>
<div class="et-lbl">Email</div><div class="et-q et-clamp">${esc(t.question)}</div>
${cur ? `<div class="et-lbl">Newest reply</div><div>${chip('tag', runLabel(curRun, cur))}${dispChip(cur)}${verdictChip(cur)}${pfChip(cur)}${gradeChip(grade)}${reviewChip(review)}</div><div class="et-a et-clamp">${esc(cur.reply || cur.hold_reason || '(no reply text)')}</div>` : '<p><small>No runs yet.</small></p>'}
<a href="${esc(base)}?test=${encodeURIComponent(t.id)}">Compare runs side by side →</a></article>`).join('');
  return `<h1>Edge testing</h1><p class="et-sub">${esc(site)} · product version <b>${esc(version)}</b> · prompts ${esc(prompt)} · ${tests} saved test${tests === 1 ? '' : 's'}</p>
${msg ? `<p class="et-msg${msg.bad ? ' bad' : ''}">${esc(msg.text)}</p>` : ''}
${runPanel({ base, csrf, est, running, latest, cap })}
<nav class="et-filter" aria-label="Filter">${F.map(([k, l]) => `<a class="${filter === k ? 'on' : ''}" href="${esc(base)}${k === 'all' ? '' : '?f=' + k}">${esc(l)}</a>`).join('')}</nav>
${cards || '<p>No tests match.</p>'}
<details class="et-panel"><summary><b>Add a test email</b></summary><form class="et-form" method="post" action="${esc(base)}/tests"><input type="hidden" name="csrf" value="${esc(csrf)}">
<p><label>Subject<br><input name="subject" maxlength="400" required></label></p><p><label style="display:block">Email text<br><textarea name="question" maxlength="12000" required></textarea></label></p>
<p><label style="display:block">Expected behavior<br><textarea name="expected" maxlength="4000"></textarea></label></p><p><small>Use made-up details only. Emails, phone numbers, street addresses, tracking and order numbers (other than test order #1173) are removed when saved.</small></p><button type="submit">Save test</button></form></details>
<details class="et-panel"><summary><b>Import tests (JSON)</b></summary><form class="et-form" method="post" action="${esc(base)}/import"><input type="hidden" name="csrf" value="${esc(csrf)}"><p><small>Edge-test library records (one object or an array). Records for the other site are skipped; importing the same records twice changes nothing.</small></p><textarea name="json" required></textarea><p><button type="submit">Import</button></p></form></details>
<p class="et-foot">Product version ${esc(version)} · times are shown in New York time</p>`;
}

function detailPage(m) {
  const { base, csrf, version, t, hist, cur, curRun, vs, vsRun, grade, review, msg, gradeEst } = m;
  const runsNav = hist.map(({ run }) => `<a class="${vsRun && run.id === vsRun.id ? 'on' : ''}" href="${esc(base)}?test=${encodeURIComponent(t.id)}&amp;vs=${encodeURIComponent(run.id)}"${run.id === (curRun && curRun.id) ? ' aria-label="current run"' : ''}>${esc(runLabel(run))}${run.id === (curRun && curRun.id) ? ' · newest' : ''}${run.is_baseline ? ' · baseline' : ''}</a>`).join('');
  const side = (r, run, title) => `<div><h4>${esc(title)}</h4><div>${chip('tag', runLabel(run, r))}${dispChip(r)}${verdictChip(r)}${pfChip(r)}</div><div class="et-a">${esc(r.reply || r.hold_reason || '(no reply text)')}</div>${r.checker_notes ? `<p><small>Checker: ${esc(r.checker_notes.slice(0, 500))}</small></p>` : ''}${r.hold_reason && r.reply ? `<p><small>Held: ${esc(r.hold_reason)}</small></p>` : ''}</div>`;
  const gradeBox = vs && cur && vsRun.id !== curRun.id ? (grade ? `<p>${gradeChip(grade)} <b>${esc(grade.grade[0].toUpperCase() + grade.grade.slice(1))}</b> than ${esc(runLabel(vsRun))}: ${esc(grade.reason)}</p><p><small>Graded by ${esc(grade.model || 'the model')} · ${usd3(grade.cost_usd)}</small></p>`
    : `<form method="post" action="${esc(base)}/grade"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="test" value="${esc(t.id)}"><input type="hidden" name="a" value="${esc(vsRun.id)}"><input type="hidden" name="b" value="${esc(curRun.id)}"><button type="submit" class="grey">Grade with agent (about ${usd3(gradeEst)})</button></form>`) : '<p><small>Pick an earlier run to compare.</small></p>';
  return `<p><a href="${esc(base)}">← All edge tests</a></p><h1>${esc(t.subject)}</h1><p class="et-sub">${esc(t.site)}${t.intent ? ' · ' + esc(t.intent) : ''}</p>
${msg ? `<p class="et-msg${msg.bad ? ' bad' : ''}">${esc(msg.text)}</p>` : ''}
<div class="et-lbl">Email</div><div class="et-q">${esc(t.question)}</div>
${t.expected ? `<div class="et-lbl">Expected behavior</div><p>${esc(t.expected)}</p>` : ''}
${cur ? `<div class="et-lbl">Newest reply</div><div>${chip('tag', runLabel(curRun, cur))}${dispChip(cur)}${verdictChip(cur)}${pfChip(cur)}</div><div class="et-a">${esc(cur.reply || cur.hold_reason || '(no reply text)')}</div>` : '<p>No runs yet.</p>'}
<div class="et-lbl">Versions and runs</div><nav class="et-runs" aria-label="Runs">${runsNav}</nav>
${vs && cur && vsRun.id !== curRun.id ? `<section class="et-sbs" aria-label="Side by side">${side(vs, vsRun, 'Earlier: ' + runLabel(vsRun, vs))}${side(cur, curRun, 'Current: ' + runLabel(curRun, cur))}</section>` : ''}
<section class="et-panel"><div class="et-lbl">Agent grade (current vs selected run)</div>${gradeBox}</section>
${cur ? `<section class="et-panel"><div class="et-lbl">Human review of ${esc(runLabel(curRun))}</div>${review ? `<p>${reviewChip(review)} ${esc(review.note)} <small>(${esc(review.at)})</small></p>` : ''}
<form class="et-form" method="post" action="${esc(base)}/review"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="test" value="${esc(t.id)}"><input type="hidden" name="run" value="${esc(curRun.id)}">
<label><input type="radio" name="verdict" value="pass"${review && review.verdict === 'pass' ? ' checked' : ''} required> Pass</label><label><input type="radio" name="verdict" value="fail"${review && review.verdict === 'fail' ? ' checked' : ''}> Fail</label>
<p><textarea name="note" maxlength="1000" placeholder="Note (optional)">${esc(review ? review.note : '')}</textarea></p><button type="submit">Save review</button></form></section>` : ''}
<p class="et-foot">Product version ${esc(version)}</p>`;
}
// Stand-alone admin page in the Mailbox look (for a host without a shared admin layout). Same CSS the Mailbox ships.
function standalone(title, body, { css = '', brand = 'Admin', links = [], logout = null, csrf = '', version = '' } = {}) {
  const so = logout ? `<form method="post" action="${esc(logout)}" style="margin:0"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit" class="so">Sign out</button></form>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>${css}${EDGE_CSS}
.et-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 18px;margin:14px auto 0;max-width:1240px;border-radius:20px}.et-top nav{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}.et-top nav a{font-size:13px;padding:8px 12px;border-radius:12px;border:1px solid var(--line);text-decoration:none;color:var(--text);background:var(--panel2)}.et-top nav a.on{border-color:var(--accent);font-weight:650}.so{font:inherit;font-size:13px;padding:8px 12px;border-radius:12px;border:1px solid var(--line);background:var(--panel2);color:var(--text);cursor:pointer}
.et-main{max-width:1240px;margin:14px auto 30px;padding:20px 22px;border-radius:20px;box-sizing:border-box}.et-main button{font:inherit;font-size:14px;padding:8px 14px;border:0;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#07101f;font-weight:600;cursor:pointer}.et-main button:disabled{opacity:.5;cursor:default}.et-main button.grey{background:var(--panel2);color:var(--text);border:1px solid var(--line);font-weight:500}.et-main input{padding:7px 10px;border-radius:10px;border:1px solid var(--line);background:var(--panel2);color:var(--text);max-width:100%}.et-main h1{margin:0 0 8px;font-size:24px}
@media (max-width:980px){.et-top{margin:8px 8px 0;padding:10px 12px}.et-top nav{margin-left:0;overflow-x:auto;flex-wrap:nowrap;width:100%}.et-top nav a{white-space:nowrap}.et-main{margin:8px;padding:14px}}</style></head><body>
<header class="et-top glass"><b>${esc(brand)}</b><nav aria-label="Admin">${links.map(l => `<a href="${esc(l.href)}"${l.on ? ' class="on" aria-current="page"' : ''}>${esc(l.label)}</a>`).join('')}</nav>${so}</header>
<main class="et-main glass">${body}</main></body></html>`;
}
module.exports = { listPage, detailPage, standalone, EDGE_CSS, esc };
