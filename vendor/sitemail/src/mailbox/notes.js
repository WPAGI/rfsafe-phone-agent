'use strict';
// Checker notes, newest run first. Shared by the server (tests) and the owner page (inlined into the client script),
// so it is written in plain ES5. Times are shown in ET.
function notesView(notes, timeline) {
  var list = (notes || []).filter(function (n) { return n && n.verdict; }).slice().sort(function (a, b) { return (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0); });
  var tl = (timeline || []).slice();
  var hm = function (iso) { var t = Date.parse(iso); if (!t) return ''; return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(t)) + ' ET'; };
  var at = function (x) { return Date.parse(x && x.at) || 0; };
  var runStart = function (n) { var s = null; tl.forEach(function (x) { if (x.step === 'pipeline' && x.status === 'started' && at(x) <= at(n)) s = x; }); return s ? s.at : n.at; };
  var outcome = function (n, nextAt) {
    var o = ''; tl.forEach(function (x) { if (x.step === 'auto_send' && at(x) >= at(n) && (!nextAt || at(x) < nextAt)) o = x.status === 'sent' ? 'sent ' + hm(x.at) : x.status === 'held' ? 'held' : o; });
    return o || n.would || '';
  };
  var title = function (n, o) { return 'Checker note: ' + String(n.verdict || 'unsure').toUpperCase() + (o ? ' · ' + o : ''); };
  if (!list.length) return { latest: null, earlier: [] };
  var views = list.map(function (n, i) { var next = list[i + 1]; var o = outcome(n, next ? Date.parse(runStart(next)) || at(next) : 0); var v = {}; for (var k in n) v[k] = n[k]; v.run_at = runStart(n); v.outcome = o; v.title = title(n, o); return v; });
  var latest = views[views.length - 1];
  var earlier = views.slice(0, -1).reverse().map(function (v) { v.replaced = 'Earlier run, replaced by the ' + hm(latest.run_at) + ' run'; return v; });
  return { latest: latest, earlier: earlier };
}
module.exports = { notesView };
