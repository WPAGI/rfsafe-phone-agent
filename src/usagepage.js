'use strict';
// HTML for /admin/usage. Server-rendered inline SVG (no chart library); one tiny nonce script for "x min ago".
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numf = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const COLORS = { twilio: '#e5484d', xai_voice: '#3b82f6', xai_text: '#8b5cf6', resend: '#10b981', render: '#f59e0b', shopify: '#14b8a6' };
const KIND = { exact: ['Exact', 'From the provider\'s billing API'], estimated: ['Estimated', 'App records x published price'], plan: ['Plan', 'Fixed plan price'] };
const badge = (k) => KIND[k] ? `<span class="b b-${k}" title="${esc(KIND[k][1])}">${KIND[k][0]}</span>` : '';
const fmt = (f) => f.unit === 'usd' ? usd(f.value) : f.unit === 'text' ? esc(f.value) : f.unit === '%' ? numf(f.value) + '%' : numf(f.value) + ' <small>' + esc(f.unit) + '</small>';

function spark(daily, color) {
  const v = (daily || []).map((x) => x.count != null ? x.count : x.cost); if (v.length < 2 || !v.some((x) => x > 0)) return '<svg class="sp" viewBox="0 0 120 32" aria-hidden="true"><line x1="0" y1="30" x2="120" y2="30" stroke="currentColor" stroke-opacity=".25" stroke-dasharray="3 3"/></svg>';
  const mx = Math.max(...v); const pts = v.map((x, i) => `${((i / (v.length - 1)) * 120).toFixed(1)},${(30 - (x / mx) * 26).toFixed(1)}`);
  return `<svg class="sp" viewBox="0 0 120 32" aria-hidden="true"><polyline points="0,32 ${pts.join(' ')} 120,32" fill="${color}" fill-opacity=".15" stroke="none"/><polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
function chart(snap) {
  const svcs = snap.services.filter((s) => s.status !== 'error' && (s.daily || []).some((d) => d.cost > 0));
  const days = snap.days; const tot = days.map((d) => svcs.reduce((a, s) => a + ((s.daily.find((x) => x.day === d) || {}).cost || 0), 0));
  const mx = Math.max(0.01, ...tot); const W = 720, H = 220, L = 44, B = 24, bw = (W - L) / days.length;
  const nice = (() => { const e = Math.pow(10, Math.floor(Math.log10(mx))); return [1, 2, 2.5, 5, 10].map((m) => m * e).find((x) => x >= mx) || mx; })();
  let g = ''; for (let i = 0; i <= 4; i++) { const y = (H - B) - ((H - B - 8) * i) / 4; g += `<line x1="${L}" x2="${W}" y1="${y}" y2="${y}" class="gl"/><text x="${L - 6}" y="${y + 4}" text-anchor="end" class="ax">${usd((nice * i) / 4).replace('.00', '')}</text>`; }
  let bars = '';
  days.forEach((d, i) => { let y = H - B; const parts = []; for (const s of svcs) { const c = (s.daily.find((x) => x.day === d) || {}).cost || 0; if (!c) continue; const h = (c / nice) * (H - B - 8); y -= h; parts.push(`${s.name} ${usd(c)}`); bars += `<rect x="${(L + i * bw + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${COLORS[s.id] || '#888'}" rx="1.5"/>`; }
    bars += `<rect x="${(L + i * bw).toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${H - B}" fill="transparent"><title>${esc(d)}: ${usd(tot[i])}${parts.length ? ' (' + esc(parts.join(', ')) + ')' : ''}</title></rect>`;
    if (i % 5 === 0 || i === days.length - 1) bars += `<text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="ax">${esc(d.slice(5).replace('-', '/'))}</text>`; });
  const legend = svcs.map((s) => `<span><i style="background:${COLORS[s.id] || '#888'}"></i>${esc(s.name)}</span>`).join('');
  return `<figure class="card ch"><figcaption><h2>Daily spend, last 30 days</h2><div class="lg">${legend || '<span>No metered daily spend yet</span>'}</div></figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Stacked daily spend by service, last 30 days, UTC">${g}${bars}</svg><p class="mut">Days are UTC. Plan-priced services (hosting, email plan) are monthly and not shown per day.</p></figure>`;
}
function card(s) {
  const c = COLORS[s.id] || '#888';
  const head = `<div class="ch1"><span class="dot" style="background:${c}"></span><div><h3>${esc(s.name)}</h3><small class="mut">${esc(s.what)}</small></div>${s.kind ? badge(s.kind) : ''}</div>`;
  if (s.status === 'error') return `<article class="card svc err">${head}<p class="st st-err" role="alert">Unavailable: ${esc(s.error)}</p><p class="mut">Other services are unaffected. Retries after the cache expires.</p><p class="upd mut">Checked <time datetime="${esc(s.updated)}">${esc(s.updated)}</time></p></article>`;
  const nc = s.status === 'not_connected' ? `<p class="st st-nc">Not connected — needs <code>${s.needs.map(esc).join('</code>, <code>')}</code></p>` : '';
  const main = s.status === 'not_connected' && !s.figures.length ? '' : `<div class="big">${usd(s.mtd)}<small class="mut"> this month</small></div>${s.last_unknown ? '' : `<div class="mut sm">Last month ${usd(s.last)}</div>`}${spark(s.daily, c)}`;
  return `<article class="card svc">${head}${nc}${main}${s.note ? `<p class="mut sm">${esc(s.note)}</p>` : ''}<p class="upd mut">Updated <time datetime="${esc(s.updated)}">${esc(s.updated)}</time></p></article>`;
}
function table(snap) {
  const rows = []; for (const s of snap.services) { if (s.status === 'error') { rows.push(`<tr><td data-l="Service">${esc(s.name)}</td><td data-l="Item">—</td><td data-l="Value"><span class="st-err">Unavailable</span></td><td data-l="Type">—</td></tr>`); continue; }
    for (const f of s.figures) rows.push(`<tr><td data-l="Service"><span class="dot" style="background:${COLORS[s.id] || '#888'}"></span>${esc(s.name)}</td><td data-l="Item">${esc(f.label)}${f.note ? ` <small class="mut">(${esc(f.note)})</small>` : ''}</td><td data-l="Value" class="num">${fmt(f)}</td><td data-l="Type">${badge(f.kind)}</td></tr>`);
    if (s.status === 'not_connected' && !s.figures.length) rows.push(`<tr><td data-l="Service">${esc(s.name)}</td><td data-l="Item">Not connected</td><td data-l="Value"><code>${s.needs.map(esc).join(', ')}</code></td><td data-l="Type">—</td></tr>`); }
  return `<section class="card"><h2>Breakdown</h2><table class="bt"><thead><tr><th>Service</th><th>Item</th><th class="num">Value</th><th>Type</th></tr></thead><tbody>${rows.join('')}</tbody></table></section>`;
}
const CSS = `:root{--bg:#f6f7f9;--fg:#15171a;--mut:#596070;--card:#fff;--bd:#e3e6eb;--acc:#0a8f4a;--up:#b42318;--down:#067647;--gl:#e9ecf0;--e:#075985;--eb:#e0f2fe;--s:#854d0e;--sb:#fef3c7;--p:#5b21b6;--pb:#ede9fe;--err:#b42318;--errb:#fef0ef;--nc:#6b4a00;--ncb:#fff7e0}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--fg:#e8eaed;--mut:#9aa3af;--card:#161b22;--bd:#2a313b;--acc:#3fd17f;--up:#ff8a80;--down:#6ee7a8;--gl:#242a33;--e:#7dd3fc;--eb:#0c2a3d;--s:#fcd34d;--sb:#3a2a05;--p:#c4b5fd;--pb:#2a1f4a;--err:#ff8a80;--errb:#3a1414;--nc:#fcd34d;--ncb:#332700}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}a{color:var(--acc)}code{font-size:.9em;background:var(--gl);padding:1px 5px;border-radius:4px;word-break:break-all}
.wrap{max-width:1200px;margin:0 auto;padding:16px}nav{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;font-size:14px;margin-bottom:14px}nav b{font-size:16px;margin-right:auto}
.hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:12px}.kpi{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:16px}.kpi .v{font-size:32px;font-weight:700;letter-spacing:-.02em}.kpi .l{color:var(--mut);font-size:13px}.up{color:var(--up)}.down{color:var(--down)}
.bar{height:6px;border-radius:3px;background:var(--gl);overflow:hidden;margin-top:8px}.bar i{display:block;height:100%;background:var(--acc)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin:12px 0}.card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:16px;margin:0 0 12px}
.ch1{display:flex;gap:10px;align-items:flex-start}.ch1 h3{margin:0;font-size:16px}.ch1 .b{margin-left:auto}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin:6px 6px 0 0;flex:none}
.big{font-size:26px;font-weight:700;margin-top:10px}.sm{font-size:13px}.mut{color:var(--mut)}.upd{font-size:12px;margin:8px 0 0}.sp{width:100%;height:36px;margin-top:6px;color:var(--mut)}
.b{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;padding:2px 8px;border-radius:999px;white-space:nowrap}.b-exact{color:var(--e);background:var(--eb)}.b-estimated{color:var(--s);background:var(--sb)}.b-plan{color:var(--p);background:var(--pb)}
.st{font-size:14px;padding:8px 10px;border-radius:8px;margin:10px 0 0}.st-err{color:var(--err);background:var(--errb)}.st-nc{color:var(--nc);background:var(--ncb)}.svc.err{border-color:var(--err)}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0 0 10px}.ch svg{width:100%;height:auto;display:block}.gl{stroke:var(--gl)}.ax{fill:var(--mut);font-size:11px}.lg{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:13px;margin-bottom:8px}.lg i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px}figure{margin:0}
.bt{width:100%;border-collapse:collapse;font-size:14px}.bt th,.bt td{padding:8px 10px;border-bottom:1px solid var(--bd);text-align:left;vertical-align:top}.bt th{color:var(--mut);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.legend{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:13px}
@media (max-width:640px){.wrap{padding:10px}.kpi .v{font-size:26px}.bt thead{display:none}.bt,.bt tbody,.bt tr,.bt td{display:block;width:100%}.bt tr{border:1px solid var(--bd);border-radius:10px;padding:6px 10px;margin-bottom:8px}.bt td{border:0;padding:4px 0;display:flex;justify-content:space-between;gap:12px;text-align:right}.bt td::before{content:attr(data-l);color:var(--mut);font-size:12px;text-align:left}.num{text-align:right}}`;

function page({ snap, nonce }) {
  const pct = snap.last > 0 ? Math.round((snap.delta / snap.last) * 100) : null; const cls = snap.delta > 0 ? 'up' : snap.delta < 0 ? 'down' : '';
  const proj = snap.day_of_month ? (snap.services.filter((s) => s.status !== 'error').reduce((a, s) => a + (s.kind === 'plan' ? s.mtd : (s.mtd / snap.day_of_month) * snap.days_in_month), 0)) : 0;
  const errs = snap.services.filter((s) => s.status === 'error').length; const ncs = snap.services.filter((s) => s.status === 'not_connected').length;
  const body = `<div class="wrap"><nav aria-label="Admin"><b>CallBots admin</b><a href="/admin">Dashboard</a><a href="/admin/messages?type=sms">Texts</a><a href="/admin/messages?type=email">Emails</a><a href="/admin/subscribers">Subscribers</a><a href="/admin/outbound">Outbound</a><a href="/admin/usage" aria-current="page"><b>Usage &amp; costs</b></a></nav>
<h1>Usage &amp; costs</h1>${snap.updated_et ? `<p class="sm"><b>Updated at ${esc(snap.updated_et)}</b> · daily snapshot</p>` : ''}<p class="mut sm">${esc(snap.month)} (UTC) · ${snap.source === 'snapshot' ? 'from the latest daily snapshot' : `refreshed at most every ${snap.ttl_minutes} min`} · generated <time datetime="${esc(snap.generated)}">${esc(snap.generated)}</time>${errs ? ` · <span class="up">${errs} service${errs > 1 ? 's' : ''} unavailable (excluded from totals)</span>` : ''}${ncs ? ` · ${ncs} not connected` : ''}</p>
<section class="hero" aria-label="Totals"><div class="kpi"><div class="l">Month to date</div><div class="v">${usd(snap.mtd)}</div><div class="bar" title="Day ${snap.day_of_month} of ${snap.days_in_month}"><i style="width:${Math.round((snap.day_of_month / snap.days_in_month) * 100)}%"></i></div><div class="l">Day ${snap.day_of_month} of ${snap.days_in_month}</div></div>
${snap.no_last ? '' : `<div class="kpi"><div class="l">Last month</div><div class="v">${usd(snap.last)}</div></div>
<div class="kpi"><div class="l">Change vs last month</div><div class="v ${cls}">${snap.delta > 0 ? '+' : ''}${usd(snap.delta)}</div><div class="l">${pct == null ? 'no spend last month' : (pct > 0 ? '+' : '') + pct + '% (month to date vs full last month)'}</div></div>`}
<div class="kpi"><div class="l">Projected this month</div><div class="v">${usd(proj)}</div><div class="l">Metered pace + fixed plans</div></div></section>
<div class="legend card" aria-label="Figure types">${badge('exact')} from the provider's billing API ${badge('estimated')} app records × published price ${badge('plan')} fixed plan price</div>
<section class="grid" aria-label="Services">${snap.services.map(card).join('')}</section>${chart(snap)}${table(snap)}
<p class="mut sm">Prices checked ${esc(snap.pricing.checked)}: <a href="${esc(snap.pricing.xai)}" rel="noreferrer">xAI</a> · <a href="${esc(snap.pricing.render)}" rel="noreferrer">Render</a> · <a href="${esc(snap.pricing.resend)}" rel="noreferrer">Resend</a>. Keys stay on the server. <a href="/admin/usage.json">JSON</a></p></div>
<script nonce="${esc(nonce)}">(function(){var n=Date.now();document.querySelectorAll('time[datetime]').forEach(function(t){var d=Date.parse(t.getAttribute('datetime'));if(!d)return;var m=Math.round((n-d)/60000);t.title=new Date(d).toLocaleString();t.textContent=m<1?'just now':m<60?m+' min ago':new Date(d).toLocaleString()})})();</script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>Usage &amp; costs · CallBots admin</title><style>${CSS}</style></head><body>${body}</body></html>`;
}
module.exports = { page, usd };
