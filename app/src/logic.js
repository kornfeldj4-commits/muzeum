/* Museum core logic: dates, availability resolution, freshness, admission, exhibitions, search.
 * Pure functions only. No DOM. Shared by the app and the Node test suite.
 * Implements Pass 3B: closure > exception > weekly hours, then a freshness check.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MuseumLogic = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const DAY_KEYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const FRESH_DAYS = 14;   // verified
  const AGING_DAYS = 45;   // aging until this, stale after
  const LOOKAHEAD_DAYS = 56; // day strip reaches 8 weeks ahead

  /* ---------- Dates (ISO YYYY-MM-DD, calendar dates with no time zone) ---------- */
  function localDate(timeZone, now) {
    // en-CA formats as YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now || new Date());
  }
  function toUTC(iso) { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); }
  function addDays(iso, n) { return new Date(toUTC(iso) + n * 864e5).toISOString().slice(0, 10); }
  function weekdayOf(iso) { return new Date(toUTC(iso)).getUTCDay(); }
  function daysBetween(a, b) { return Math.round((toUTC(b) - toUTC(a)) / 864e5); }
  function mondayOf(iso) { return addDays(iso, -((weekdayOf(iso) + 6) % 7)); }
  function parts(iso) { const [y, m, d] = iso.split('-').map(Number); return { y, m, d }; }
  function fmtShortDate(iso) { const { m, d } = parts(iso); return `${MONTHS[m - 1]} ${d}`; }
  function fmtLongDate(iso, withYear) {
    const { y, m, d } = parts(iso);
    return withYear === false ? `${MONTHS_LONG[m - 1]} ${d}` : `${MONTHS_LONG[m - 1]} ${d}, ${y}`;
  }
  function fmtDayLabel(iso) { return `${DAY_NAMES[weekdayOf(iso)]}, ${fmtLongDate(iso, false)}`; }

  /* ---------- Times ---------- */
  function fmtTime(hhmm, hour12) {
    const [h, m] = hhmm.split(':').map(Number);
    if (!hour12) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const suffix = h < 12 ? 'am' : 'pm';
    const h12 = h % 12 || 12;
    return m ? `${h12}:${String(m).padStart(2, '0')} ${suffix}` : `${h12} ${suffix}`;
  }
  function fmtRange(open, close, hour12) {
    if (!hour12) return `${fmtTime(open, false)}–${fmtTime(close, false)}`;
    const a = fmtTime(open, true), b = fmtTime(close, true);
    const sa = a.slice(-2), sb = b.slice(-2);
    return sa === sb ? `${a.slice(0, -3)}–${b}` : `${a}–${b}`;
  }

  /* ---------- Availability (Pass 3B resolution order) ---------- */
  function resolveDay(rec, iso) {
    const h = rec.hours;
    if (!h) return { kind: 'unknown' };
    const tc = h.temporary_closure;
    if (tc && tc.from && iso >= tc.from && (!tc.until || iso <= tc.until)) {
      return { kind: 'temp_closed', until: tc.until || null, reason: tc.reason || null, source: 'closure' };
    }
    const ex = (h.exceptions || []).find((e) => e.date === iso);
    if (ex) {
      return ex.closed
        ? { kind: 'closed', note: ex.note || null, source: 'exception' }
        : { kind: 'open', open: ex.open, close: ex.close, note: ex.note || null, source: 'exception' };
    }
    const w = (h.weekly || []).find((x) => x.day === DAY_KEYS[weekdayOf(iso)]);
    if (!w) return { kind: 'unknown' };
    return w.closed ? { kind: 'closed', source: 'weekly' } : { kind: 'open', open: w.open, close: w.close, source: 'weekly' };
  }

  function freshness(rec, today) {
    const p = rec.provenance || {};
    if (!rec.hours || !rec.hours.weekly || !rec.hours.weekly.length) return 'unknown';
    if (p.stale_reason || p.conflict_flag) return 'stale';
    if (!p.verified_at) return 'unknown';
    const age = daysBetween(p.verified_at, today);
    if (age <= FRESH_DAYS) return 'verified';
    if (age <= AGING_DAYS) return 'aging';
    return 'stale';
  }

  /* ctx: { today: ISO in the museum's time zone, offline: bool, hour12: bool } */
  function dayStatus(rec, iso, ctx) {
    const day = resolveDay(rec, iso);
    const fresh = freshness(rec, ctx.today);
    const effective = ctx.offline && fresh !== 'unknown' ? 'offline' : fresh;
    const definitive = effective === 'verified' || effective === 'aging';
    const wd = DAY_NAMES[weekdayOf(iso)];
    let tone, label;

    if (day.kind === 'temp_closed') {
      tone = 'closed';
      label = day.until ? `Temporarily closed until ${fmtLongDate(day.until)}` : 'Temporarily closed';
    } else if (day.kind === 'unknown' || effective === 'unknown') {
      tone = 'unknown';
      label = 'Hours unavailable';
    } else if (day.kind === 'closed') {
      const when = day.source === 'weekly' ? `${wd}s` : wd;
      tone = definitive ? 'closed' : 'unsure';
      label = `${definitive ? 'Closed' : 'Usually closed'} ${when}`;
    } else {
      tone = definitive ? 'open' : 'unsure';
      label = `${definitive ? 'Open' : 'Usually open'} ${wd} ${fmtRange(day.open, day.close, ctx.hour12)}`;
    }

    const notes = [];
    if (day.note) notes.push(day.note);
    if (day.reason) notes.push(day.reason);
    if (rec.partial_closure_note && day.kind === 'open') notes.push(rec.partial_closure_note);

    let caution = null;
    if (effective === 'aging') caution = `Checked ${fmtLongDate(rec.provenance.verified_at)}. Confirm on the official site.`;
    else if (effective === 'stale') {
      const p = rec.provenance || {};
      caution = p.method === 'automated' && p.conflict_flag && !p.stale_reason
        ? 'These hours were read automatically and not yet confirmed. Check the official site.'
        : 'Hours may have changed. Confirm on the official site.';
    }
    // Offline: the results header carries one banner, so cards don't repeat it.

    return { tone, label, notes, caution, freshness: effective, day };
  }

  /* A Monday-first week around the selected date, with exceptions applied (AC1). */
  function weekRows(rec, iso) {
    const start = mondayOf(iso);
    return Array.from({ length: 7 }, (_, i) => {
      const date = addDays(start, i);
      return { date, short: DAY_SHORT[weekdayOf(date)], selected: date === iso, day: resolveDay(rec, date) };
    });
  }
  function rowValue(day, hour12) {
    if (day.kind === 'open') return fmtRange(day.open, day.close, hour12);
    if (day.kind === 'closed' || day.kind === 'temp_closed') return 'Closed';
    return 'Not listed';
  }

  /* ---------- Admission ---------- */
  function money(amount, currency, locale) {
    return new Intl.NumberFormat(locale || 'en-US', { style: 'currency', currency, minimumFractionDigits: amount % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(amount);
  }
  function admission(rec, iso, locale) {
    const a = rec.admission;
    if (!a || !a.tiers || !a.tiers.length) return { summary: 'Admission not listed', details: [], notes: (a && a.notes) || [], dayNote: null, timed: null, allFree: false };
    const allFree = a.tiers.every((t) => t.is_free);
    let summary;
    if (allFree) summary = 'Free admission';
    else {
      const primary = a.tiers.find((t) => t.primary) || a.tiers.find((t) => !t.is_free);
      const freeTier = a.tiers.find((t) => t.is_free && t.free_label);
      summary = `${primary.short_label || primary.label} ${money(primary.amount, a.currency, locale)}`;
      if (freeTier) summary += ` · ${freeTier.free_label}`;
    }
    const details = a.tiers.map((t) => ({ label: t.label, value: t.is_free ? 'Free' : money(t.amount, a.currency, locale), eligibility: t.eligibility || null }));
    const dn = (a.day_notes || []).find((n) => n.day === DAY_KEYS[weekdayOf(iso)]);
    let timed = null;
    if (a.timed_entry) {
      const t = a.timed_entry;
      if (iso >= t.required_from && iso <= t.required_until) timed = { required: true, text: 'Reservation required for this date' };
      else if (t.otherwise === 'recommended') timed = { required: false, text: 'Time-slot booking recommended' };
    }
    return { summary, details, notes: a.notes || [], dayNote: dn ? dn.text : null, timed, allFree };
  }

  /* ---------- Exhibitions: open on the selected date, closing soonest ---------- */
  function featuredExhibition(rec, iso) {
    const open = (rec.exhibitions || [])
      .filter((e) => (!e.start || e.start <= iso) && e.end && e.end >= iso)
      .sort((x, y) => (x.end < y.end ? -1 : x.end > y.end ? 1 : 0));
    if (open.length) return { kind: 'temporary', title: open[0].title, end: open[0].end, others: open.length - 1 };
    if (rec.permanent_collection) return { kind: 'permanent' };
    return { kind: 'none' };
  }

  /* ---------- Access ---------- */
  function accessLine(rec) {
    const a = rec.access || {};
    if (a.step_free_entry === 'yes') return a.detail || 'Step-free access';
    if (a.step_free_entry === 'partial') return a.detail || 'Partial step-free access';
    if (a.step_free_entry === 'no') return 'No step-free entrance listed';
    return 'Access information not listed';
  }

  /* ---------- Search ---------- */
  function norm(s) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  function buildIndex(data) {
    const cityById = Object.fromEntries(data.cities.map((c) => [c.id, c]));
    const entries = [];
    data.cities.forEach((c) => entries.push({
      type: 'city', id: c.id, label: `${c.name}, ${c.region}`,
      sub: c.country === 'United States' ? 'City · United States' : `City · ${c.country}`,
      keys: [c.name, `${c.name} ${c.region}`], cityName: c.name
    }));
    data.museums.forEach((m) => {
      const c = cityById[m.city_id];
      entries.push({
        type: 'museum', id: m.id, label: m.name.display,
        sub: `Museum · ${c.name}, ${c.country === 'United States' ? c.region : c.country}`,
        keys: [m.name.display, m.name.original, ...(m.name.alternates || [])]
      });
    });
    return entries;
  }
  /* Edit distance of at most 1 (one insert, delete or substitution), in linear time. */
  function within1(a, b) {
    if (a === b) return true;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < la && j < lb) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (la > lb) i++; else if (lb > la) j++; else { i++; j++; }
    }
    return edits + (la - i) + (lb - j) <= 1;
  }
  // Normalized keys and their word tails, computed once per index entry.
  function prepared(e) {
    if (!e._n) {
      e._n = e.keys.filter(Boolean).map((k) => {
        const nk = norm(k);
        const words = nk.split(' ');
        return { nk, tails: words.map((_, i) => words.slice(i).join(' ')) };
      });
      e._city = e.cityName ? norm(e.cityName) : null;
    }
    return e._n;
  }
  function matchRank(nq, nk, tails) {
    if (nk.startsWith(nq)) return 0;
    if ((' ' + nk).includes(' ' + nq)) return 1;
    if (nq.length >= 4) {
      const ts = tails || nk.split(' ').map((_, i, w) => w.slice(i).join(' '));
      for (let i = 0; i < ts.length; i++) {
        const tail = ts[i];
        for (let len = nq.length - 1; len <= nq.length + 1; len++) {
          if (len > 0 && len <= tail.length && within1(tail.slice(0, len), nq)) return 2;
        }
      }
    }
    return Infinity;
  }
  function search(query, index, limit) {
    const nq = norm(query || '');
    if (nq.length < 2) return [];
    const scored = [];
    for (const e of index) {
      let rank = Infinity;
      for (const k of prepared(e)) { const r = matchRank(nq, k.nk, k.tails); if (r < rank) rank = r; if (rank === 0) break; }
      if (rank === Infinity) continue;
      if (e.type === 'city' && e._city === nq) rank = -1; // exact city name wins (3B ranking rule)
      scored.push({ e, rank });
    }
    scored.sort((a, b) => a.rank - b.rank || a.e.label.localeCompare(b.e.label));
    return scored.slice(0, limit || 6).map((s) => { const { _n, _city, ...rest } = s.e; return { ...rest, rank: s.rank }; });
  }

  /* ---------- Results ---------- */
  function summarize(statuses) {
    const c = { open: 0, closed: 0, unsure: 0, unknown: 0 };
    statuses.forEach((s) => { c[s.tone] += 1; });
    const parts = [];
    if (c.open) parts.push(`${c.open} open`);
    if (c.closed) parts.push(`${c.closed} closed`);
    if (c.unsure + c.unknown) parts.push(`${c.unsure + c.unknown} unconfirmed`);
    return { counts: c, text: parts.join(' · ') };
  }

  return {
    DAY_KEYS, DAY_NAMES, DAY_SHORT, LOOKAHEAD_DAYS,
    localDate, addDays, weekdayOf, daysBetween, mondayOf, fmtShortDate, fmtLongDate, fmtDayLabel,
    fmtTime, fmtRange, resolveDay, freshness, dayStatus, weekRows, rowValue,
    money, admission, featuredExhibition, accessLine, norm, lev, within1, buildIndex, search, summarize
  };
});
