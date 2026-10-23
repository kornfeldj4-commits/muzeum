/* Muzeum app: state, rendering components, interaction, accessibility, analytics.
 * start(D, meta) is called by boot.js once the data has loaded.
 * meta: { fromCache: bool } — true when the data came from the offline copy.
 */
window.MuzeumApp = function start(D, meta) {
  const L = window.MuseumLogic;
  const CFG = window.MUZEUM_CONFIG || {};
  window.__muzeumData = D;   // for tests and debugging
  const INDEX = L.buildIndex(D);
  const cityById = Object.fromEntries(D.cities.map((c) => [c.id, c]));
  const museumById = Object.fromEntries(D.museums.map((m) => [m.id, m]));
  const LOCALE = (navigator.language || 'en-US');
  const HOUR12 = (() => {
    try { const hc = new Intl.DateTimeFormat(LOCALE, { hour: 'numeric' }).resolvedOptions().hourCycle; return hc === 'h11' || hc === 'h12'; } catch (e) { return true; }
  })();
  const hashFlags = new Set((location.hash || '').replace('#', '').split(/[.,]/).filter(Boolean));
  const FORCE_OFFLINE = hashFlags.has('offline');
  const FROM_CACHE = !!(meta && meta.fromCache);
  // Cities with the most museums, for suggestions when a search finds nothing.
  const FEATURED = (D.featured_city_ids || (() => {
    const n = {};
    D.museums.forEach((m) => { n[m.city_id] = (n[m.city_id] || 0) + 1; });
    return Object.keys(n).sort((a, b) => n[b] - n[a] || a.localeCompare(b)).slice(0, 6);
  })()).filter((id) => cityById[id]);
  const chipLabel = (id) => { const c = cityById[id]; return c.country === 'United States' ? `${c.name}, ${c.region}` : `${c.name}, ${c.country}`; };

  /* ---------------- Analytics (local only; no network, no query text) ---------------- */
  window.__museumEvents = [];
  function track(name, props) {
    const e = { name, at: Date.now(), ...(props || {}) };
    window.__museumEvents.push(e);
    if (window.console && console.debug) console.debug('[event]', name, props || {});
  }

  /* ---------------- State ---------------- */
  const store = {
    get() { try { return JSON.parse(sessionStorage.getItem('museum-state') || 'null'); } catch (e) { return null; } },
    set(v) { try { sessionStorage.setItem('museum-state', JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
    getScroll() { try { return Number(sessionStorage.getItem('museum-scroll') || 0); } catch (e) { return 0; } },
    setScroll(y) { try { sessionStorage.setItem('museum-scroll', String(y)); } catch (e) { /* storage unavailable */ } }
  };
  const state = {
    view: 'home', query: '', target: null, date: null,
    variant: hashFlags.has('variant-c') ? 'C' : 'B',
    offline: FORCE_OFFLINE || FROM_CACHE || (typeof navigator.onLine === 'boolean' && !navigator.onLine),
    suggestions: [], active: -1
  };
  function persist() { store.set({ view: state.view, query: state.query, target: state.target, date: state.date }); }

  /* ---------------- Helpers ---------------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const live = (msg) => { const el = $('#live'); el.textContent = ''; setTimeout(() => { el.textContent = msg; }, 60); };
  const ICON = {
    search: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M15.5 15.5 21 21" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    clear: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    chev: '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    prev: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    next: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    out: '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 16 17 7M9 7h8v8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    open: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7" fill="currentColor"/></svg>',
    closed: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 6l6 6M12 6l-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    unsure: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 1.5 17 16H1z" fill="currentColor"/><path d="M9 6.5v4.2" stroke="var(--bg)" stroke-width="2" stroke-linecap="round"/><circle cx="9" cy="13.2" r="1.1" fill="var(--bg)"/></svg>',
    unknown: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 3"/></svg>'
  };

  function targetZone(target) {
    if (!target) return 'America/Chicago';
    return target.type === 'city' ? cityById[target.id].time_zone : museumById[target.id].location.time_zone;
  }
  function todayFor(target) { return L.localDate(targetZone(target)); }
  function clampDate(date, today) {
    if (!date || date < today || L.daysBetween(today, date) > L.LOOKAHEAD_DAYS - 1) return today;
    return date;
  }

  /* ---------------- Search (SearchField, SearchSuggestionList, SearchSuggestion) ---------------- */
  let debounceTimer = null;
  let requestSeq = 0;

  function highlight(label, query) {
    const nq = L.norm(query);
    const nl = L.norm(label);
    const at = nl.startsWith(nq) ? 0 : nl.indexOf(' ' + nq) + 1;
    if (!nq || at <= -1 || (at === 0 && !nl.startsWith(nq))) return esc(label);
    // Map normalized index back to the original string (same length unless diacritics/punctuation); keep it simple and safe.
    if (L.norm(label.slice(at, at + nq.length)) !== nq) return esc(label);
    return esc(label.slice(0, at)) + '<mark>' + esc(label.slice(at, at + nq.length)) + '</mark>' + esc(label.slice(at + nq.length));
  }

  function renderSuggestions() {
    const input = $('#q');
    const list = $('#sugs');
    const msg = $('#search-msg');
    const q = state.query.trim();
    const nq = L.norm(q);
    $('#home').classList.toggle('is-active', q.length > 0 || document.activeElement === input);
    $('.clear-btn').hidden = q.length === 0;

    if (nq.length < 2) {
      list.hidden = true; msg.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
      return;
    }
    if (!state.suggestions.length) {
      list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
      if (nq.length >= 3) {
        msg.hidden = false;
        msg.innerHTML = `<strong>No museums or cities match “${esc(q)}”.</strong><p>Check the spelling, or try a city that has listings:</p>
          <div class="chips">${FEATURED.map((id) => `<button type="button" class="chip" data-city="${id}">${esc(chipLabel(id))}</button>`).join('')}</div>`;
        live(`No museums or cities match ${q}.`);
        track('no_match_shown', { query_length: nq.length });
      } else msg.hidden = true;
      return;
    }
    msg.hidden = true;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    list.innerHTML = state.suggestions.map((s, i) => `
      <li role="option" id="opt-${i}" class="suggestion" data-i="${i}" aria-selected="${i === state.active}">
        <span class="s-label">${highlight(s.label, q)}</span>
        <span class="s-sub">${esc(s.sub)}</span>
      </li>`).join('');
    if (state.active >= 0) input.setAttribute('aria-activedescendant', `opt-${state.active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function runSearch() {
    const seq = ++requestSeq;
    const results = L.search(state.query, INDEX, 6);
    if (seq !== requestSeq) return; // a newer keystroke superseded this one
    state.suggestions = results;
    state.active = -1;
    renderSuggestions();
    if (results.length) live(`${results.length} suggestion${results.length === 1 ? '' : 's'}. Use the arrow keys to choose.`);
  }

  function onInput(e) {
    state.query = e.target.value;
    if (L.norm(state.query).length === 1) track('search_started');
    clearTimeout(debounceTimer);
    if (L.norm(state.query).length < 2) { state.suggestions = []; renderSuggestions(); return; }
    debounceTimer = setTimeout(runSearch, 200);
    renderSuggestions(); // keep previous suggestions visible while typing
  }

  function choose(s) {
    if (!s) return;
    track('suggestion_selected', { type: s.type, position: state.suggestions.indexOf(s) + 1, query_length: L.norm(state.query).length });
    state.query = s.label;
    $('#q').value = s.label;
    openResults({ type: s.type, id: s.id }, true);
  }

  function onKeydown(e) {
    const n = state.suggestions.length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); state.active = (state.active + 1) % n; renderSuggestions(); scrollActive(); }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); state.active = (state.active - 1 + n) % n; renderSuggestions(); scrollActive(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(debounceTimer);
      if (L.norm(state.query).length >= 2 && !state.suggestions.length) { state.suggestions = L.search(state.query, INDEX, 6); }
      if (state.suggestions.length) choose(state.suggestions[Math.max(0, state.active)]);
      else renderSuggestions();
    } else if (e.key === 'Escape') {
      if (!$('#sugs').hidden) { $('#sugs').hidden = true; e.target.setAttribute('aria-expanded', 'false'); }
      else { state.query = ''; e.target.value = ''; state.suggestions = []; renderSuggestions(); }
    }
  }
  function scrollActive() { const el = document.getElementById(`opt-${state.active}`); if (el) el.scrollIntoView({ block: 'nearest' }); }

  /* ---------------- Results (DateStrip, MuseumCard and parts) ---------------- */
  function museumsFor(target) {
    if (!target) return [];
    if (target.type === 'museum') return [museumById[target.id]];
    return D.museums.filter((m) => m.city_id === target.id).sort((a, b) => a.name.display.localeCompare(b.name.display));
  }

  function renderStrip(today) {
    const sel = state.date;
    const offsetWeeks = Math.floor(L.daysBetween(today, sel) / 7);
    const start = L.addDays(today, offsetWeeks * 7);
    const days = Array.from({ length: 7 }, (_, i) => L.addDays(today, offsetWeeks * 7 + i));
    $('.days').innerHTML = days.map((d) => {
      const isToday = d === today;
      const label = `${L.fmtDayLabel(d)}${isToday ? ', today' : ''}`;
      return `<button type="button" class="day${isToday ? ' is-today' : ''}" data-date="${d}" aria-pressed="${d === sel}" aria-label="${esc(label)}">
        <span class="dw" aria-hidden="true">${L.DAY_SHORT[L.weekdayOf(d)]}</span><span class="dn" aria-hidden="true">${Number(d.slice(8))}</span></button>`;
    }).join('');
    $('.strip-nav.prev').disabled = start <= today;
    $('.strip-nav.next').disabled = L.daysBetween(today, L.addDays(start, 7)) > L.LOOKAHEAD_DAYS - 1;
  }

  function statusBlock(st) {
    return `<p class="status">${ICON[st.tone]}<span>${esc(st.label)}</span></p>
      ${st.notes.map((n) => `<p class="note">${esc(n)}</p>`).join('')}
      ${st.caution ? `<p class="caution">${esc(st.caution)}</p>` : ''}`;
  }

  function admissionBlock(rec, iso, id) {
    const a = L.admission(rec, iso, LOCALE);
    const hasMore = a.details.length > 1 || a.notes.length;
    return `<p class="adm">${esc(a.summary)}</p>
      ${a.dayNote ? `<p class="daynote">${esc(a.dayNote)}</p>` : ''}
      ${a.timed ? `<p class="timed${a.timed.required ? ' req' : ''}">${esc(a.timed.text)}</p>` : ''}
      ${hasMore ? `<details class="prices" id="prices-${id}"><summary>All prices ${ICON.chev}</summary><dl>
        ${a.details.map((d) => `<dt>${esc(d.label)}${d.eligibility ? `<span class="vh">, ${esc(d.eligibility)}</span>` : ''}</dt><dd>${esc(d.value)}</dd>`).join('')}
        ${a.notes.map((n) => `<p class="p-note">${esc(n)}</p>`).join('')}
      </dl></details>` : ''}`;
  }

  function exhibitionLine(rec, iso) {
    const ex = L.featuredExhibition(rec, iso);
    if (ex.kind === 'temporary') return `<p class="exh">Now on: <strong>${esc(ex.title)}</strong>, until ${esc(L.fmtLongDate(ex.end))}</p>`;
    if (ex.kind === 'permanent') return '<p class="exh">Permanent collection on view</p>';
    return '<p class="exh exh-none">No exhibition information</p>';
  }

  function weekBlock(rec, iso) {
    const rows = L.weekRows(rec, iso);
    const notes = rows.filter((r) => r.day.note).map((r) => `${r.short} ${Number(r.date.slice(8))}: ${r.day.note}`);
    const extra = rec.hours && rec.hours.note ? [rec.hours.note] : [];
    return `<section class="week" aria-label="Hours for the week of ${esc(L.fmtLongDate(rows[0].date, false))}">
      <h3>Week of ${esc(L.fmtShortDate(rows[0].date))}</h3>
      <div class="week-grid${rows.some((r) => L.rowValue(r.day, HOUR12).length > 11) ? ' one-col' : ''}">${rows.map((r) => `
        <div class="wrow${r.day.kind === 'open' ? '' : ' is-closed'}"${r.selected ? ' aria-current="date"' : ''}>
          <span class="wd">${r.short}<span class="vh"> ${esc(L.fmtLongDate(r.date, false))}${r.selected ? ', selected' : ''}</span></span>
          <span class="wv">${esc(L.rowValue(r.day, HOUR12))}</span></div>`).join('')}
      </div>
      ${notes.length || extra.length ? `<div class="week-notes">${[...notes, ...extra].map((n) => `<span>${esc(n)}</span>`).join('')}</div>` : ''}
    </section>`;
  }

  function freshnessLine(rec, st) {
    const p = rec.provenance;
    const auto = p.method === 'automated';
    const checked = auto ? `Read automatically from the official site ${L.fmtLongDate(p.verified_at)}` : `Checked ${L.fmtLongDate(p.verified_at)}`;
    if (p.stale_reason) return `${checked}. ${p.stale_reason}`;
    if (auto && p.conflict_flag) return `${checked}. Not yet confirmed.`;
    return auto ? checked : `${checked} against the official site`;
  }

  function reportLink(rec, iso, st) {
    if (!CFG.reportUrl) return '';
    const title = `Wrong info: ${rec.name.display}`;
    const body = `Museum: ${rec.name.display} (${rec.id})\nDate viewed: ${iso}\nMuzeum showed: ${st.label}\nWhat is wrong:\n\nOfficial page: ${rec.provenance.source_url || rec.official_url}`;
    const href = `${CFG.reportUrl}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&labels=data`;
    return `<a class="report-link" href="${esc(href)}" target="_blank" rel="noopener">Report a problem<span class="vh"> with ${esc(rec.name.display)}, opens in a new tab</span></a>`;
  }

  function renderCard(rec, iso, today, offline) {
    const st = L.dayStatus(rec, iso, { today, offline, hour12: HOUR12 });
    const id = rec.id;
    const supporting = `${weekBlock(rec, iso)}
      <div class="meta"><span>${rec.location.street ? esc(rec.location.street) + ', ' : ''}${esc(rec.location.city)}</span><span>${esc(L.accessLine(rec))}</span></div>`;
    const foot = `<footer class="card-foot"><span>${esc(freshnessLine(rec, st))}</span>
      <span class="foot-links"><a class="site-link" href="${esc(rec.official_url)}" target="_blank" rel="noopener" data-site="${id}" data-fresh="${st.freshness}">Official site ${ICON.out}<span class="vh"> for ${esc(rec.name.display)}, opens in a new tab</span></a>${reportLink(rec, iso, st)}</span></footer>`;
    const html = `<article class="card tone-${st.tone}" aria-labelledby="h-${id}">
      <h2 class="m-name" id="h-${id}">${esc(rec.name.display)}</h2>
      <div class="decision">${statusBlock(st)}</div>
      <div class="facts">${admissionBlock(rec, iso, id)}${exhibitionLine(rec, iso)}</div>
      ${state.variant === 'C'
        ? `<details class="more" id="more-${id}"><summary>Week, address, access ${ICON.chev}</summary>${supporting}</details>`
        : supporting}
      ${foot}
    </article>`;
    if (st.caution && (st.freshness === 'stale' || st.freshness === 'aging')) track('stale_notice_shown', { freshness: st.freshness });
    return { html, st };
  }

  function renderResults(opts) {
    const target = state.target;
    const today = todayFor(target);
    state.date = clampDate(state.date, today);
    const iso = state.date;
    const list = museumsFor(target);

    // Header
    let place, listed;
    if (target.type === 'city') {
      const c = cityById[target.id];
      place = `${c.name}, ${c.country === 'United States' ? c.region : c.country}`;
      listed = list.length ? `${list.length} museum${list.length === 1 ? '' : 's'} listed` : 'No museums listed';
    } else {
      const m = museumById[target.id];
      const c = cityById[m.city_id];
      place = `${c.name}, ${c.country === 'United States' ? c.region : c.country}`;
      const n = D.museums.filter((x) => x.city_id === c.id).length;
      listed = n > 1 ? `Showing 1 of ${n} museums listed. <button type="button" class="linkish" data-city="${c.id}">Show all</button>` : '1 museum listed';
    }
    $('#place').textContent = place;
    document.title = `${place} · Muzeum`;
    $('.listed').innerHTML = listed;
    renderStrip(today);

    // Cards
    const rendered = list.map((m) => renderCard(m, iso, L.localDate(m.location.time_zone), state.offline));
    const sum = L.summarize(rendered.map((r) => r.st));
    $('.summary').innerHTML = list.length ? `<span>${esc(sum.text)}</span> <span class="sel-date">on ${esc(L.fmtDayLabel(iso))}</span>` : '';
    $('.offline-banner').hidden = !state.offline;
    $('#cards').innerHTML = list.length
      ? rendered.map((r) => r.html).join('')
      : `<div class="empty"><strong>No museums listed in ${esc(place)} yet.</strong><p>Muzeum lists art museums that publish their hours on their own website. Try one of these:</p>
          <div class="chips">${FEATURED.map((id) => `<button type="button" class="chip" data-city="${id}">${esc(chipLabel(id))}</button>`).join('')}</div></div>`;
    $('.test-flag').textContent = [state.variant === 'C' ? 'Test condition: Variant C (compact cards)' : '', FORCE_OFFLINE ? 'Test condition: offline' : ''].filter(Boolean).join(' · ');
    $('.pill span').textContent = 'Search';
    $('.pill').setAttribute('aria-label', `New search. Current: ${place}`);

    track('results_viewed', { type: target.type, result_count: list.length, open_count: sum.counts.open });
    if (opts && opts.announce) live(`${place}. ${list.length ? `${sum.text} on ${L.fmtDayLabel(iso)}.` : 'No museums listed.'}`);
    persist();
  }

  function show(view) {
    state.view = view;
    $('#home').hidden = view !== 'home';
    $('#results').hidden = view !== 'results';
    document.title = view === 'results' && state.target ? `${$('#place').textContent} · Muzeum` : 'Muzeum';
  }

  function openResults(target, push) {
    const prevTarget = state.target;
    state.target = target;
    state.suggestions = []; state.active = -1;
    $('#sugs').hidden = true; $('#search-msg').hidden = true;
    $('#q').setAttribute('aria-expanded', 'false');
    $('#q').blur(); // dismiss the keyboard
    if (!prevTarget || targetZone(prevTarget) !== targetZone(target)) state.date = clampDate(state.date, todayFor(target));
    show('results');
    renderResults({ announce: true });
    window.scrollTo(0, 0);
    if (push) history.pushState({ view: 'results', target, date: state.date, query: state.query }, '');
    else history.replaceState({ view: 'results', target, date: state.date, query: state.query }, '');
    requestAnimationFrame(() => $('#place').focus({ preventScroll: true }));
  }

  function openSearch(push) {
    show('home');
    const input = $('#q');
    input.value = state.query;
    renderSuggestions();
    if (push) history.pushState({ view: 'home', target: state.target, date: state.date, query: state.query }, '');
    requestAnimationFrame(() => { input.focus(); input.select(); $('#home').classList.add('is-active'); });
    persist();
  }

  function selectDate(iso) {
    state.date = iso;
    renderResults();
    const today = todayFor(state.target);
    track('day_selected', { days_from_today: L.daysBetween(today, iso) });
    const sum = $('.summary span') ? $('.summary span').textContent : '';
    live(`Showing ${L.fmtDayLabel(iso)}. ${sum}.`);
    history.replaceState({ view: 'results', target: state.target, date: state.date, query: state.query }, '');
  }

  /* ---------------- Wiring ---------------- */
  function footer() {
    const el = $('.foot-stats');
    if (!el) return;
    const us = new Set(D.museums.filter((m) => m.location.country_code === 'US').map((m) => m.location.region));
    const abroad = [...new Set(D.museums.filter((m) => m.location.country_code !== 'US').map((m) => (cityById[m.city_id] || {}).country).filter(Boolean))];
    const n = D.museums.length;
    const where = [us.size ? `${us.size} US state${us.size === 1 ? '' : 's'}` : '', ...abroad].filter(Boolean);
    const list = where.length > 1 ? `${where.slice(0, -1).join(', ')} and ${where[where.length - 1]}` : where[0] || '';
    el.textContent = `${n.toLocaleString(LOCALE)} art museum${n === 1 ? '' : 's'} in ${list}. ` +
      `Hours come from each museum's official website${D.generated ? `, updated ${L.fmtLongDate(D.generated)}` : ''}.`;
    const about = $('.about-link');
    if (about && CFG.mode === 'artifact') about.hidden = true;
  }

  function init() {
    footer();
    const input = $('#q');
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKeydown);
    input.addEventListener('focus', () => $('#home').classList.add('is-active'));
    input.addEventListener('blur', () => { if (!state.query) $('#home').classList.remove('is-active'); });
    $('.clear-btn').addEventListener('click', () => { state.query = ''; input.value = ''; state.suggestions = []; renderSuggestions(); input.focus(); });
    $('#sugs').addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the field
    $('#sugs').addEventListener('click', (e) => { const li = e.target.closest('.suggestion'); if (li) choose(state.suggestions[Number(li.dataset.i)]); });

    document.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-city]');
      if (chip) { const c = cityById[chip.dataset.city]; state.query = `${c.name}, ${c.region}`; $('#q').value = state.query; openResults({ type: 'city', id: c.id }, true); return; }
      const day = e.target.closest('.day');
      if (day) { selectDate(day.dataset.date); return; }
      const site = e.target.closest('.site-link');
      if (site) { store.setScroll(window.scrollY); track('official_site_opened', { freshness: site.dataset.fresh }); }
    });
    $('.strip-nav.prev').addEventListener('click', () => {
      const today = todayFor(state.target); const d = L.addDays(state.date, -7); selectDate(d < today ? today : d);
    });
    $('.strip-nav.next').addEventListener('click', () => {
      const today = todayFor(state.target); const d = L.addDays(state.date, 7);
      selectDate(L.daysBetween(today, d) > L.LOOKAHEAD_DAYS - 1 ? L.addDays(today, L.LOOKAHEAD_DAYS - 1) : d);
    });
    $('.pill').addEventListener('click', () => openSearch(true));

    window.addEventListener('popstate', (e) => {
      const s = e.state;
      if (!s || s.view === 'home') { state.query = (s && s.query) || state.query; openSearch(false); return; }
      state.query = s.query || state.query; state.date = s.date || state.date; state.target = s.target;
      show('results'); renderResults();
    });
    window.addEventListener('online', () => {
      if (FORCE_OFFLINE) return;
      if (FROM_CACHE) {
        // Saved data is still on screen: offer a refresh rather than reloading under the person's thumb.
        const b = $('.offline-banner');
        b.innerHTML = 'You\'re back online. <button type="button" class="linkish" id="refresh-data">Refresh</button> to get today\'s hours.';
        $('#refresh-data').addEventListener('click', () => location.reload());
        return;
      }
      state.offline = false; if (state.view === 'results') renderResults();
    });
    window.addEventListener('offline', () => { state.offline = true; if (state.view === 'results') renderResults({ announce: true }); });
    const saveScroll = () => { if (state.view === 'results') store.setScroll(window.scrollY); };
    window.addEventListener('pagehide', saveScroll);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveScroll(); });

    // Restore after a reload or a return from the official site
    const saved = store.get();
    if (saved && saved.view === 'results' && saved.target && (cityById[saved.target.id] || museumById[saved.target.id])) {
      state.query = saved.query || ''; state.target = saved.target; state.date = saved.date; $('#q').value = state.query;
      show('results'); renderResults();
      history.replaceState({ view: 'results', target: state.target, date: state.date, query: state.query }, '');
      const y = store.getScroll(); if (y) requestAnimationFrame(() => window.scrollTo(0, y));
    } else {
      show('home');
      history.replaceState({ view: 'home', query: '' }, '');
    }
  }

  init();
};
