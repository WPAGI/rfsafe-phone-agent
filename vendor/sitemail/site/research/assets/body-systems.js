/* Body-system browse + lookup helpers. Works in the browser and in Node tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.rfaBodySystems = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const AI_MIN = 0.8;
  const DATA_CATALOG = '/research/data/body-systems-v1.json';
  const DATA_TAGS = '/research/data/body-system-tags-v1.json';
  const DATA_SUMMARIES = '/research/data/body-system-summaries-v1.json';
  const DATA_COUNTS = '/research/data/body-system-effect-counts-v1.json';

  const BODY_MAP = [
    { re: /\b(eyes?|vision|visual|retina\w*|ocular|cornea\w*|cataract\w*|macula\w*)\b/i, systems: ['sensory-ocular'], organs: ['eye'] },
    { re: /\b(ears?|hearing|tinnitus|cochle\w*|auditor(?:y|ies)|vestibular|inner ear|middle ear)\b/i, systems: ['sensory-auditory'], organs: ['ear'] },
    { re: /\b(brain tumou?rs?|brain cancers?|gliomas?|glioblastoma\w*|meningiomas?)\b/i, systems: ['nervous'], organs: ['brain'] },
    { re: /\b(liver|hepat\w*)\b/i, systems: ['digestive'], organs: ['liver'] },
    { re: /\b(immune|immunity|immunological|inflammat\w*|autoimmun\w*|lymphocytes?)\b/i, systems: ['immune'], organs: [] },
    { re: /\b(heart|cardiac|cardiovascular|myocard\w*|atrial)\b/i, systems: ['cardiovascular'], organs: ['heart'] }
  ];

  function isRetracted(rec) {
    if (!rec) return false;
    if (rec.retracted === true || rec.status === 'retracted') return true;
    const flags = rec.flags;
    return Array.isArray(flags) && flags.map(String).some((f) => f.toLowerCase() === 'retracted');
  }

  function mapQuery(query) {
    const text = String(query || '');
    const systems = [];
    const organs = [];
    const seenS = Object.create(null);
    const seenO = Object.create(null);
    for (let i = 0; i < BODY_MAP.length; i++) {
      const rule = BODY_MAP[i];
      if (!rule.re.test(text)) continue;
      for (let j = 0; j < rule.systems.length; j++) {
        const s = rule.systems[j];
        if (!seenS[s]) { seenS[s] = true; systems.push(s); }
      }
      for (let k = 0; k < rule.organs.length; k++) {
        const o = rule.organs[k];
        if (!seenO[o]) { seenO[o] = true; organs.push(o); }
      }
    }
    return { systems: systems, organs: organs };
  }

  function paperIdFromPath(pathname) {
    const m = String(pathname || '').match(/\/research\/papers\/0*([0-9]+)/i);
    return m ? Number(m[1]) : null;
  }

  function filterRecords(records, tagsById, opts) {
    const system = opts && opts.system;
    const organ = opts && opts.organ;
    if (!system && !organ) return records;
    return (records || []).filter(function (rec) {
      const tag = tagsById[String(rec.paper_id)];
      if (!tag) return false;
      if (system && (tag.s || []).indexOf(system) === -1) return false;
      if (organ && (tag.o || []).indexOf(organ) === -1) return false;
      return true;
    });
  }

  function optionalJson(r) {
    if (!r || !r.ok) return null;
    return r.json().catch(function () { return null; });
  }

  function fromPayload(catalog, tagsDoc, extras) {
    extras = extras || {};
    const summariesDoc = extras.summaries || {};
    return {
      catalog: catalog || {},
      tags: (tagsDoc && tagsDoc.tags) || {},
      aiMin: (catalog && catalog.ai_min_confidence) || (tagsDoc && tagsDoc.ai_min_confidence) || AI_MIN,
      summaries: (summariesDoc && summariesDoc.systems) || {},
      effectCounts: extras.effectCounts || null
    };
  }

  function readOptional(fs, file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
  }

  function loadFromDir(fs, path, dir) {
    const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'body-systems-v1.json'), 'utf8'));
    const tagsName = path.basename(catalog.tags_file || 'body-system-tags-v1.json');
    const tagsDoc = JSON.parse(fs.readFileSync(path.join(dir, tagsName), 'utf8'));
    const summaries = readOptional(fs, path.join(dir, 'body-system-summaries-v1.json'));
    const effectCounts = readOptional(fs, path.join(dir, 'body-system-effect-counts-v1.json'));
    return fromPayload(catalog, tagsDoc, { summaries: summaries, effectCounts: effectCounts });
  }

  let cached = null;
  function load(fetchImpl) {
    const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!f) return Promise.reject(new Error('no fetch'));
    const soft = function (url) {
      return f(url).then(optionalJson).catch(function () { return null; });
    };
    return Promise.all([
      f(DATA_CATALOG).then(function (r) { return r.json(); }),
      f(DATA_TAGS).then(function (r) { return r.json(); }),
      soft(DATA_SUMMARIES),
      soft(DATA_COUNTS)
    ]).then(function (pair) {
      cached = fromPayload(pair[0], pair[1], { summaries: pair[2], effectCounts: pair[3] });
      return cached;
    });
  }
  function loaded() { return cached; }

  function currentFilter(search) {
    const qs = new URLSearchParams(search || (typeof location !== 'undefined' ? location.search : ''));
    return {
      system: qs.get('system') || '',
      organ: qs.get('organ') || ''
    };
  }

  function filterUrl(next) {
    const url = new URL(typeof location !== 'undefined' ? location.href : 'https://rfsafe.app/research');
    if (next.system) url.searchParams.set('system', next.system);
    else url.searchParams.delete('system');
    if (next.organ) url.searchParams.set('organ', next.organ);
    else url.searchParams.delete('organ');
    return url.pathname + url.search + url.hash;
  }

  function paperIdFromHref(href) {
    const m = String(href || '').match(/\/research\/papers\/0*([0-9]+)/i);
    return m ? m[1] : null;
  }

  function catalogCount(data, filter) {
    const catalog = (data && data.catalog) || {};
    const counts = catalog.counts || { systems: {}, organs: {} };
    if (filter && filter.organ) return Number(counts.organs[filter.organ] || 0);
    if (filter && filter.system) return Number(counts.systems[filter.system] || 0);
    return Number(catalog.index_count || 0);
  }


  function organLabel(data, systemId, organId) {
    const systems = (data && data.catalog && data.catalog.systems) || [];
    for (let i = 0; i < systems.length; i++) {
      if (systems[i].id !== systemId) continue;
      const organs = systems[i].organs || [];
      for (let j = 0; j < organs.length; j++) {
        if (organs[j].id === organId) return organs[j].label || organId;
      }
    }
    return organId;
  }

  function systemTitle(data, systemId) {
    const entry = data && data.summaries && data.summaries[systemId];
    if (entry && entry.title) return String(entry.title);
    const titles = data && data.effectCounts && data.effectCounts.titles;
    if (titles && titles[systemId] && titles[systemId].title) return titles[systemId].title;
    const systems = (data && data.catalog && data.catalog.systems) || [];
    for (let i = 0; i < systems.length; i++) {
      if (systems[i].id === systemId) return systems[i].label;
    }
    return systemId;
  }

  function effectBreakdown(data, filter) {
    const countsDoc = data && data.effectCounts;
    if (!countsDoc || !countsDoc.systems || !filter || !filter.system) return null;
    const sys = countsDoc.systems[filter.system];
    if (!sys) return null;
    if (filter.organ && sys.organs && sys.organs[filter.organ]) return sys.organs[filter.organ];
    return sys;
  }

  const FILTERS_OPEN_KEY = 'rfa-research-filters-open';

  function storageFor(doc) {
    try {
      if (typeof sessionStorage !== 'undefined') return sessionStorage;
      const win = doc && (doc.defaultView || doc.parentWindow);
      return win && win.sessionStorage;
    } catch (e) { return null; }
  }

  function filtersOpenPref(doc) {
    try {
      const store = storageFor(doc);
      return !!(store && store.getItem(FILTERS_OPEN_KEY) === '1');
    } catch (e) { return false; }
  }

  function setFiltersOpenPref(doc, open) {
    try {
      const store = storageFor(doc);
      if (store) store.setItem(FILTERS_OPEN_KEY, open ? '1' : '0');
    } catch (e) {}
  }

  function bindFiltersToggle(doc) {
    const toggle = doc.querySelector('[data-research-filters-toggle]');
    if (!toggle || toggle.getAttribute('data-bound') === '1') return;
    toggle.setAttribute('data-bound', '1');
    toggle.addEventListener('click', function () {
      const top = doc.querySelector('[data-research-top]');
      const open = !!(top && top.hidden);
      if (top) top.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      setFiltersOpenPref(doc, open);
    });
  }

  function updateSummaryPanel(doc, data, filter) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.querySelector) return { shown: false };
    const top = doc.querySelector('[data-research-top]');
    const bar = doc.querySelector('[data-research-filters-bar]');
    const toggle = doc.querySelector('[data-research-filters-toggle]');
    const panel = doc.querySelector('[data-body-system-summary]');
    if (!panel) return { shown: false };
    bindFiltersToggle(doc);
    const hasSystem = !!(filter && filter.system);
    if (!hasSystem) {
      if (bar) bar.hidden = true;
      if (top) top.hidden = false;
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
      panel.hidden = true;
      panel.innerHTML = '';
      return { shown: false };
    }
    const filtersOpen = filtersOpenPref(doc);
    if (bar) bar.hidden = false;
    if (top) top.hidden = !filtersOpen;
    if (toggle) toggle.setAttribute('aria-expanded', filtersOpen ? 'true' : 'false');
    const title = systemTitle(data, filter.system);
    const entry = (data && data.summaries && data.summaries[filter.system]) || {};
    const blurb = (entry.site_blurb && String(entry.site_blurb).trim()) || '';
    const breakdown = effectBreakdown(data, filter);
    const effects = (data && data.effectCounts && data.effectCounts.effects) || [
      { id: 'harm', label: 'Harm' },
      { id: 'benefit', label: 'Benefit' },
      { id: 'mixed', label: 'Mixed' },
      { id: 'unclear', label: 'Unclear' },
      { id: 'no_effect', label: 'No effect' },
      { id: 'unknown', label: 'Unknown' }
    ];

    panel.hidden = false;
    panel.innerHTML = '';
    const kicker = doc.createElement('p');
    kicker.className = 'section-kicker';
    kicker.textContent = 'Body system';
    const h = doc.createElement('h1');
    h.textContent = title;
    panel.appendChild(kicker);
    panel.appendChild(h);
    if (filter.organ) {
      const note = doc.createElement('p');
      note.className = 'body-system-summary-organ';
      note.textContent = 'Showing studies tagged ' + organLabel(data, filter.system, filter.organ) + '.';
      panel.appendChild(note);
    }
    if (blurb) {
      const p = doc.createElement('p');
      p.className = 'body-system-summary-blurb';
      p.textContent = blurb;
      panel.appendChild(p);
    }
    if (breakdown) {
      const list = doc.createElement('ul');
      list.className = 'body-system-summary-counts';
      function countItem(cls, n, label) {
        const li = doc.createElement('li');
        li.className = cls;
        const b = doc.createElement('b');
        b.textContent = String(n);
        const span = doc.createElement('span');
        span.textContent = label;
        li.appendChild(b);
        li.appendChild(span);
        return li;
      }
      list.appendChild(countItem('is-total', breakdown.total || 0, 'studies'));
      const by = breakdown.by_effect || {};
      for (let i = 0; i < effects.length; i++) {
        const n = Number(by[effects[i].id] || 0);
        if (!n) continue;
        list.appendChild(countItem('is-' + effects[i].id, n, effects[i].label));
      }
      panel.appendChild(list);
    }
    return { shown: true, title: title, hasBlurb: !!blurb, total: breakdown && breakdown.total };
  }

  // Apply a body-system filter to whatever cards are already on the page (the
  // prerendered first 40, or a later render) and update the count from the
  // tag catalog. This must not wait for the 7 MB research index — a click
  // that only pushState'd the URL used to leave "6476 papers" on screen until
  // that download finished, which looked like the filter was broken.
  function applyVisibleFilter(doc, data, filter) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.querySelector) return { applied: false };
    const results = doc.querySelector('[data-catalog-results]');
    const countEl = doc.querySelector('[data-result-count]');
    filter = filter || currentFilter();
    const tags = (data && data.tags) || {};
    const hasFilter = !!(filter && (filter.system || filter.organ));
    let visibleCards = 0;
    if (results) {
      const cards = results.querySelectorAll('.stream-card');
      for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        if (!hasFilter) {
          card.hidden = false;
          visibleCards++;
          continue;
        }
        const link = card.querySelector ? (card.querySelector('a[href*="/research/papers/"]') || card.querySelector('a.stream-main') || card.querySelector('a[href]')) : null;
        const id = paperIdFromHref(link && link.getAttribute && link.getAttribute('href'));
        const tag = id ? tags[String(id)] : null;
        const ok = !!(tag
          && (!filter.system || (tag.s || []).indexOf(filter.system) !== -1)
          && (!filter.organ || (tag.o || []).indexOf(filter.organ) !== -1));
        card.hidden = !ok;
        if (ok) visibleCards++;
      }
      const pendingSel = results.querySelector && results.querySelector('.body-systems-pending');
      if (hasFilter && visibleCards === 0 && typeof document !== 'undefined' && results.appendChild) {
        let pending = pendingSel;
        if (!pending) {
          pending = document.createElement('p');
          pending.className = 'body-systems-pending empty-state';
          results.appendChild(pending);
        }
        pending.textContent = 'Loading matching papers…';
        pending.hidden = false;
      } else if (pendingSel) {
        pendingSel.hidden = true;
      }
    }
    const total = hasFilter ? catalogCount(data, filter) : catalogCount(data, {});
    if (countEl && total) countEl.textContent = total + (total === 1 ? ' paper' : ' papers');
    if (typeof window !== 'undefined' && typeof window.rfaStartCatalog === 'function') {
      try { window.rfaStartCatalog(); } catch (e) {}
    }
    updateSummaryPanel(doc, data, filter);
    return { applied: true, visibleCards: visibleCards, total: total };
  }

  function tagFor(data, paperId) {
    if (!data || paperId == null) return null;
    return data.tags[String(paperId)] || null;
  }

  function render(data, opts) {
    opts = opts || {};
    const filter = opts.filter || { system: '', organ: '' };
    const currentTag = opts.currentTag || null;
    const currentSystems = (currentTag && currentTag.s) || [];
    const currentOrgans = (currentTag && currentTag.o) || [];
    const counts = (data.catalog && data.catalog.counts) || { systems: {}, organs: {} };
    const systems = (data.catalog && data.catalog.systems) || [];
    const onStudy = !!opts.onStudy;

    const nav = document.createElement('nav');
    nav.className = 'body-systems' + (opts.startOpen ? ' is-open' : '');
    nav.setAttribute('aria-label', 'Body systems');

    const head = document.createElement('div');
    head.className = 'body-systems-head';
    const h2 = document.createElement('h2');
    h2.textContent = 'Body systems';
    const hint = document.createElement('span');
    hint.className = 'body-systems-count';
    hint.textContent = opts.startOpen ? '' : 'Show';
    head.appendChild(h2);
    if (!opts.startOpen) head.appendChild(hint);
    head.addEventListener('click', function () {
      nav.classList.toggle('is-open');
      if (hint) hint.textContent = nav.classList.contains('is-open') ? 'Hide' : 'Show';
    });
    nav.appendChild(head);

    const note = document.createElement('p');
    note.className = 'body-systems-note';
    note.textContent = onStudy
      ? 'This study\'s systems are marked. Browse the full directory by body system.'
      : 'Browse by organ system. Counts include rules tags plus AI tags at 80% confidence or higher.';
    nav.appendChild(note);

    if (filter.system || filter.organ) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'body-systems-organ';
      clear.textContent = 'Clear body-system filter';
      clear.addEventListener('click', function () {
        applyFilter({ system: '', organ: '' });
      });
      nav.appendChild(clear);
    }

    const list = document.createElement('ul');
    list.className = 'body-systems-list';

    for (let i = 0; i < systems.length; i++) {
      const sys = systems[i];
      const li = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'body-systems-row';

      const sysBtn = document.createElement('button');
      sysBtn.type = 'button';
      sysBtn.className = 'body-systems-sys';
      if (filter.system === sys.id && !filter.organ) sysBtn.classList.add('is-active');
      if (currentSystems.indexOf(sys.id) !== -1) sysBtn.classList.add('is-current');
      sysBtn.setAttribute('data-system', sys.id);
      const label = document.createElement('span');
      label.textContent = sys.label;
      const count = document.createElement('span');
      count.className = 'body-systems-count';
      count.textContent = String(counts.systems[sys.id] || 0);
      sysBtn.appendChild(label);
      sysBtn.appendChild(count);
      sysBtn.addEventListener('click', function () {
        applyFilter({ system: sys.id, organ: '' });
      });

      const organs = sys.organs || [];
      const hasOrgans = organs.some(function (o) { return (counts.organs[o.id] || 0) > 0; });
      const expandDefault = filter.system === sys.id || organs.some(function (o) {
        return currentOrgans.indexOf(o.id) !== -1;
      });
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'body-systems-toggle';
      toggle.textContent = expandDefault ? '\u25BE' : '\u25B8';
      toggle.setAttribute('aria-label', 'Show organs');
      toggle.hidden = !hasOrgans;
      const organsUl = document.createElement('ul');
      organsUl.className = 'body-systems-organs';
      organsUl.hidden = !expandDefault;
      toggle.setAttribute('aria-expanded', expandDefault ? 'true' : 'false');
      toggle.addEventListener('click', function () {
        const open = organsUl.hidden;
        organsUl.hidden = !open;
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.textContent = open ? '\u25BE' : '\u25B8';
      });

      for (let j = 0; j < organs.length; j++) {
        const organ = organs[j];
        const n = counts.organs[organ.id] || 0;
        if (!n && currentOrgans.indexOf(organ.id) === -1) continue;
        const oli = document.createElement('li');
        const ob = document.createElement('button');
        ob.type = 'button';
        ob.className = 'body-systems-organ';
        if (filter.organ === organ.id) ob.classList.add('is-active');
        if (currentOrgans.indexOf(organ.id) !== -1) ob.classList.add('is-current');
        ob.setAttribute('data-system', sys.id);
        ob.setAttribute('data-organ', organ.id);
        const ol = document.createElement('span');
        ol.textContent = organ.label;
        const oc = document.createElement('span');
        oc.className = 'body-systems-count';
        oc.textContent = String(n);
        ob.appendChild(ol);
        ob.appendChild(oc);
        ob.addEventListener('click', function () {
          applyFilter({ system: sys.id, organ: organ.id });
        });
        oli.appendChild(ob);
        organsUl.appendChild(oli);
      }

      row.appendChild(sysBtn);
      row.appendChild(toggle);
      li.appendChild(row);
      li.appendChild(organsUl);
      list.appendChild(li);
    }
    nav.appendChild(list);
    return nav;

    function applyFilter(next) {
      if (opts.onFilter) {
        opts.onFilter(next);
        return;
      }
      if (onStudy) {
        const url = '/research' + filterUrl(next).replace(/^[^?]*/, '');
        window.location.href = url === '/research' ? '/research' : url;
        return;
      }
      if (typeof history !== 'undefined' && history.pushState) {
        history.pushState({}, '', filterUrl(next));
        applyVisibleFilter(document, (typeof loaded === 'function' && loaded()) || data, next);
        window.dispatchEvent(new CustomEvent('rfa-body-systems-change', { detail: next }));
      }
    }
  }

  function mount(root, data, opts) {
    if (!root) return;
    root.innerHTML = '';
    const startOpen = opts && opts.startOpen;
    root.appendChild(render(data, Object.assign({ startOpen: !!startOpen }, opts || {})));
  }

  return {
    AI_MIN: AI_MIN,
    BODY_MAP: BODY_MAP,
    isRetracted: isRetracted,
    mapQuery: mapQuery,
    paperIdFromPath: paperIdFromPath,
    filterRecords: filterRecords,
    fromPayload: fromPayload,
    loadFromDir: loadFromDir,
    load: load,
    currentFilter: currentFilter,
    filterUrl: filterUrl,
    tagFor: tagFor,
    render: render,
    mount: mount,
    loaded: loaded,
    paperIdFromHref: paperIdFromHref,
    catalogCount: catalogCount,
    applyVisibleFilter: applyVisibleFilter,
    updateSummaryPanel: updateSummaryPanel,
    systemTitle: systemTitle,
    effectBreakdown: effectBreakdown,
    organLabel: organLabel,
    filtersOpenPref: filtersOpenPref,
    setFiltersOpenPref: setFiltersOpenPref,
    FILTERS_OPEN_KEY: FILTERS_OPEN_KEY
  };
});

(function (api) {
  if (typeof document === 'undefined' || !api) return;
  const start = function () {
    const study = document.querySelector('[data-body-systems][data-paper-id], aside.body-systems-rail');
    const slots = document.querySelectorAll('[data-body-systems-desktop], [data-body-systems-mobile]');
    if (!study && !slots.length) return;
    api.load().then(function (data) {
      function remount() {
        const filter = api.currentFilter();
        for (let i = 0; i < slots.length; i++) {
          const el = slots[i];
          api.mount(el, data, { filter: filter, startOpen: el.hasAttribute('data-body-systems-desktop') });
        }
        if (study) {
          const paperId = Number(study.getAttribute('data-paper-id')) || api.paperIdFromPath(location.pathname);
          const wide = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(min-width: 1100px)').matches;
          api.mount(study, data, { onStudy: true, currentTag: api.tagFor(data, paperId), startOpen: !!wide });
        }
        api.applyVisibleFilter(document, data, filter);
      }
      remount();
      window.addEventListener('rfa-body-systems-change', remount);
      window.addEventListener('popstate', remount);
    }).catch(function () {});
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(typeof window !== 'undefined' ? window.rfaBodySystems : null);
