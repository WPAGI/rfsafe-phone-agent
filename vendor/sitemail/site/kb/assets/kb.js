/* RF Safe public knowledge base (/kb): theme switch and instant search over a compact index.
   Search keys: "/" focuses search, Up/Down move through results, Enter opens one, Escape closes the list. */
(function () {
  'use strict';
  var doc = document, root = doc.documentElement;
  // ---- theme (same storage key as /research) ----
  function setTheme(t) {
    root.dataset.theme = t;
    try { localStorage.setItem('rfs-theme', t); } catch (e) {}
    var bs = doc.querySelectorAll('[data-theme-choice]');
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-pressed', String(bs[i].getAttribute('data-theme-choice') === t));
  }
  setTheme(root.dataset.theme || 'dark');
  doc.addEventListener('click', function (ev) { var b = ev.target.closest && ev.target.closest('[data-theme-choice]'); if (b) setTheme(b.getAttribute('data-theme-choice')); });

  // ---- search ----
  var STOP = {}; 'a an and are as at be but by can could do does for from had has have how i if in into is it its may me more most my no not of on or our out so than that the their them then there these they this to too up was we were what when where which who why will with would you your yes'.split(' ').forEach(function (w) { STOP[w] = 1; });
  function words(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter(function (w) { return w.length > 1 && !STOP[w]; }); }
  var index = null, loading = null;
  function load() {
    if (index) return Promise.resolve(index);
    if (!loading) loading = fetch('/kb/api/v1/search-index.json', { credentials: 'omit' }).then(function (r) { if (!r.ok) throw new Error('index ' + r.status); return r.json(); }).then(function (j) {
      index = (j.docs || []).map(function (d) { return { d: d, T: ' ' + words(d.t + ' ' + d.s).join(' ') + ' ', B: ' ' + d.w + ' ' }; }); return index;
    }).catch(function (e) { loading = null; throw e; });
    return loading;
  }
  function run(q) {
    var terms = words(q).slice(0, 12); if (!terms.length) return [];
    var out = [];
    for (var i = 0; i < index.length; i++) {
      var x = index[i], score = 0, ok = true;
      for (var j = 0; j < terms.length; j++) { var w = ' ' + terms[j]; var inT = x.T.indexOf(w) >= 0, inB = x.B.indexOf(w) >= 0; if (!inT && !inB) { ok = false; break; } score += inT ? 5 : 1; }
      if (ok) out.push({ d: x.d, s: score + (x.d.k === 'Topic' ? 2 : 0) });
    }
    out.sort(function (a, b) { return b.s - a.s || (a.d.t < b.d.t ? -1 : 1); });
    return out.slice(0, 12);
  }
  function hl(text, terms) {
    var span = doc.createElement('span'); var s = String(text || '');
    if (!terms.length) { span.textContent = s; return span; }
    var re = new RegExp('\\b(' + terms.map(function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')', 'gi');
    var last = 0, m;
    while ((m = re.exec(s))) { span.appendChild(doc.createTextNode(s.slice(last, m.index))); var mk = doc.createElement('mark'); mk.textContent = m[0]; span.appendChild(mk); last = m.index + m[0].length; if (m[0].length === 0) re.lastIndex++; }
    span.appendChild(doc.createTextNode(s.slice(last)));
    return span;
  }
  function wire(form) {
    var input = form.querySelector('[data-kb-search]'), list = form.querySelector('.kb-results'), status = form.querySelector('[data-kb-status]');
    if (!input || !list) return;
    var active = -1, items = [], timer = null, seq = 0;
    function close() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; }
    function select(i) {
      var lis = list.querySelectorAll('li[role="option"]'); if (!lis.length) return;
      active = (i + lis.length) % lis.length;
      for (var k = 0; k < lis.length; k++) lis[k].setAttribute('aria-selected', String(k === active));
      input.setAttribute('aria-activedescendant', lis[active].id); lis[active].scrollIntoView({ block: 'nearest' });
    }
    function render(q) {
      var my = ++seq;
      load().then(function () {
        if (my !== seq) return;
        var terms = words(q); items = run(q); list.textContent = ''; active = -1;
        if (!q.trim()) { close(); status.textContent = ''; return; }
        if (!items.length) {
          var li = doc.createElement('li'); li.className = 'r-empty'; li.textContent = 'No matches. Press Enter to search all text, or try other words.'; list.appendChild(li);
        }
        items.forEach(function (r, i) {
          var li = doc.createElement('li'); li.setAttribute('role', 'option'); li.id = list.id + '-o' + i; li.setAttribute('aria-selected', 'false');
          var a = doc.createElement('a'); a.href = r.d.u; a.tabIndex = -1;
          var t = hl(r.d.t, terms); t.className = 'r-t'; a.appendChild(t);
          var s = doc.createElement('span'); s.className = 'r-s'; s.textContent = r.d.k + (r.d.s ? ' · ' + r.d.s : ''); a.appendChild(s);
          if (r.d.x) { var x = hl(r.d.x, terms); x.className = 'r-x'; a.appendChild(x); }
          li.appendChild(a); list.appendChild(li);
        });
        list.hidden = false; input.setAttribute('aria-expanded', 'true');
        status.textContent = items.length ? items.length + (items.length === 1 ? ' result' : ' results') + '. Use the up and down arrows to choose.' : 'No matches.';
      }).catch(function () { status.textContent = 'Search is not available right now. Press Enter to search.'; });
    }
    input.addEventListener('focus', function () { load().catch(function () {}); });
    input.addEventListener('input', function () { clearTimeout(timer); var q = input.value; timer = setTimeout(function () { render(q); }, 60); });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); if (list.hidden && input.value.trim()) render(input.value); else select(active + 1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); select(active - 1); }
      else if (ev.key === 'Escape') { if (!list.hidden) { ev.preventDefault(); close(); } }
      else if (ev.key === 'Enter' && active >= 0 && items[active]) { ev.preventDefault(); location.href = items[active].d.u; }
    });
    list.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
    list.addEventListener('click', function (ev) { var a = ev.target.closest('a'); if (a) location.href = a.href; });
    input.addEventListener('blur', function () { setTimeout(close, 120); });
  }
  var forms = doc.querySelectorAll('[data-kb-search-form]');
  for (var i = 0; i < forms.length; i++) wire(forms[i]);
  doc.addEventListener('keydown', function (ev) {
    if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    var t = ev.target; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    var inp = doc.querySelector('.kb-search-big [data-kb-search]') || doc.querySelector('[data-kb-search]');
    if (inp) { ev.preventDefault(); inp.focus(); inp.select(); }
  });
})();
