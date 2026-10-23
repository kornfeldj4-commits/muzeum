const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/logic.js');
const DATA = require('./fixtures/museums.json');

const byId = (id) => DATA.museums.find((m) => m.id === id);
const AIC = byId('mus_art_institute_chicago');
const MCA = byId('mus_mca_chicago');
const SMART = byId('mus_smart_museum');
const RAM = byId('mus_ram_downtown');
const LOUVRE = byId('mus_louvre');
const ctx = (today, extra) => ({ today, offline: false, hour12: true, ...extra });

test('dates: weekday, Monday-of-week and week boundary', () => {
  assert.equal(L.weekdayOf('2026-10-24'), 6); // Saturday
  assert.equal(L.mondayOf('2026-10-25'), '2026-10-19');
  assert.equal(L.addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(L.addDays('2026-12-31', 1), '2027-01-01');
});

test('time zone: museum-local "today" differs across zones (AC3)', () => {
  const fridayNightChicago = new Date('2026-10-24T01:00:00Z'); // Fri 20:00 in Chicago, Sat 03:00 in Paris
  assert.equal(L.localDate('America/Chicago', fridayNightChicago), '2026-10-23');
  assert.equal(L.localDate('Europe/Paris', fridayNightChicago), '2026-10-24');
});

test('weekly hours: open Saturday, closed Tuesday', () => {
  const sat = L.dayStatus(AIC, '2026-10-24', ctx('2026-10-23'));
  assert.equal(sat.tone, 'open');
  assert.equal(sat.label, 'Open Saturday 11 am–5 pm');
  const tue = L.dayStatus(AIC, '2026-10-27', ctx('2026-10-23'));
  assert.equal(tue.tone, 'closed');
  assert.equal(tue.label, 'Closed Tuesdays');
});

test('AC1: dated exception beats the weekly schedule (Thanksgiving)', () => {
  const s = L.dayStatus(AIC, '2026-11-26', ctx('2026-11-20'));
  assert.equal(s.tone, 'closed');
  assert.equal(s.label, 'Closed Thursday');
  assert.deepEqual(s.notes, ['Thanksgiving']);
  const row = L.weekRows(AIC, '2026-11-26').find((r) => r.selected);
  assert.equal(L.rowValue(row.day, true), 'Closed');
});

test('real exception: Louvre exceptionally closed Saturday Oct 24, 2026', () => {
  const s = L.dayStatus(LOUVRE, '2026-10-24', ctx('2026-10-23', { hour12: false }));
  assert.equal(s.tone, 'closed');
  assert.equal(s.label, 'Closed Saturday');
  assert.deepEqual(s.notes, ['Exceptional closure']);
  const sun = L.dayStatus(LOUVRE, '2026-10-25', ctx('2026-10-23', { hour12: false }));
  assert.equal(sun.label, 'Open Sunday 09:00–18:00');
});

test('special hours exception renders as open with a note', () => {
  const nmma = byId('mus_national_museum_mexican_art');
  const s = L.dayStatus(nmma, '2026-12-24', ctx('2026-10-23')); // planning ahead with fresh data
  assert.equal(s.label, 'Open Thursday 10 am–2 pm');
  assert.deepEqual(s.notes, ['Christmas Eve hours']);
  const later = L.dayStatus(nmma, '2026-12-24', ctx('2026-12-20')); // same date, data now 58 days old
  assert.equal(later.label, 'Usually open Thursday 10 am–2 pm');
});

test('AC4: temporary closure overrides everything', () => {
  const rec = { ...MCA, hours: { ...MCA.hours, temporary_closure: { from: '2026-11-01', until: '2027-03-01', reason: 'Renovation' } } };
  const s = L.dayStatus(rec, '2026-11-07', ctx('2026-10-23'));
  assert.equal(s.tone, 'closed');
  assert.equal(s.label, 'Temporarily closed until March 1, 2027');
  assert.ok(s.notes.includes('Renovation'));
  assert.equal(L.dayStatus(rec, '2026-10-31', ctx('2026-10-23')).tone, 'open');
});

test('freshness thresholds: verified ≤14 days, aging ≤45, stale after', () => {
  assert.equal(L.freshness(MCA, '2026-11-06'), 'verified');
  assert.equal(L.freshness(MCA, '2026-11-07'), 'aging');
  assert.equal(L.freshness(MCA, '2026-12-07'), 'aging');
  assert.equal(L.freshness(MCA, '2026-12-08'), 'stale');
});

test('AC2: stale data never claims "Open"', () => {
  const s = L.dayStatus(SMART, '2026-10-24', ctx('2026-10-23'));
  assert.equal(s.freshness, 'stale');
  assert.equal(s.tone, 'unsure');
  assert.equal(s.label, 'Usually open Saturday 10 am–4:30 pm');
  assert.match(s.caution, /may have changed/);
  const old = L.dayStatus(MCA, '2026-12-19', ctx('2026-12-19'));
  assert.equal(old.tone, 'unsure');
  assert.ok(old.label.startsWith('Usually open'));
});

test('aging data still answers but tells the user to confirm', () => {
  const s = L.dayStatus(MCA, '2026-11-14', ctx('2026-11-14'));
  assert.equal(s.tone, 'open');
  assert.match(s.caution, /Checked October 23, 2026/);
});

test('AC5: offline makes every status hedge', () => {
  const s = L.dayStatus(AIC, '2026-10-24', ctx('2026-10-23', { offline: true }));
  assert.equal(s.tone, 'unsure');
  assert.ok(s.label.startsWith('Usually open'));
});

test('unknown hours never show Open', () => {
  const rec = { ...AIC, hours: { weekly: [], exceptions: [] } };
  const s = L.dayStatus(rec, '2026-10-24', ctx('2026-10-23'));
  assert.equal(s.tone, 'unknown');
  assert.equal(s.label, 'Hours unavailable');
});

test('partial closure adds a note but never flips Open', () => {
  const s = L.dayStatus(RAM, '2026-10-24', ctx('2026-10-23'));
  assert.equal(s.tone, 'open');
  assert.deepEqual(s.notes, ['Second-floor galleries closed for changeover']);
});

test('admission: primary price, free tier, all-free, day-specific note, timed entry', () => {
  assert.equal(L.admission(AIC, '2026-10-24').summary, 'Adult $32 · Under 14 free');
  assert.equal(L.admission(byId('mus_smart_museum'), '2026-10-24').summary, 'Free admission');
  assert.equal(L.admission(MCA, '2026-10-27').dayNote, 'Free for Illinois residents 5–9 pm');
  assert.equal(L.admission(MCA, '2026-10-28').dayNote, null);
  assert.equal(L.admission(LOUVRE, '2026-10-25').timed.required, true);
  assert.equal(L.admission(LOUVRE, '2026-11-02').timed.required, false);
  assert.match(L.admission(LOUVRE, '2026-10-25').summary, /^Adult €32 · Under 18 free$/);
});

test('featured exhibition: open on the selected date, closing soonest', () => {
  assert.equal(L.featuredExhibition(MCA, '2026-10-24').title, 'Kenzi Shiokava');
  assert.equal(L.featuredExhibition(MCA, '2027-02-01').title, 'Slow Dance');
  assert.equal(L.featuredExhibition(AIC, '2026-10-24').kind, 'none');
  assert.equal(L.featuredExhibition(RAM, '2027-01-11').title, 'RAM Showcase: African Adornment');
});

test('search: museum by name, typo tolerance, ambiguous city, ranking, no match', () => {
  const idx = L.buildIndex(DATA);
  assert.equal(L.search('art inst', idx)[0].id, 'mus_art_institute_chicago');
  assert.equal(L.search('Lovre', idx)[0].id, 'mus_louvre');          // one-letter error, 5 chars
  assert.equal(L.search('Lov', idx).length, 0);                       // no typo tolerance under 4 chars
  const paris = L.search('Paris', idx);
  assert.deepEqual(paris.slice(0, 2).map((r) => r.id).sort(), ['paris-fr', 'paris-tx']); // both cities, neither auto-picked
  const chicago = L.search('chicago', idx);
  assert.equal(chicago[0].id, 'chicago-il');                           // exact city first
  assert.ok(chicago.some((r) => r.id === 'mus_art_institute_chicago'));
  assert.equal(L.search('qzx', idx).length, 0);
  assert.equal(L.search('musee du', idx)[0].id, 'mus_louvre');        // diacritics ignored
  assert.ok(L.search('a', idx).length === 0);                         // nothing before 2 characters
  assert.ok(L.search('mu', idx).length <= 6);
});

test('summary line counts unconfirmed separately', () => {
  const chicago = DATA.museums.filter((m) => m.city_id === 'chicago-il');
  const statuses = chicago.map((m) => L.dayStatus(m, '2026-10-27', ctx('2026-10-23')));
  assert.equal(L.summarize(statuses).text, '2 open · 2 closed · 1 unconfirmed');
});

test('every record has an official source and a verification date', () => {
  DATA.museums.forEach((m) => {
    assert.ok(m.official_url.startsWith('https://'), m.id);
    assert.ok(m.provenance.source_url.startsWith('https://'), m.id);
    assert.equal(m.provenance.verified_at, '2026-10-23', m.id);
    assert.equal(m.hours.weekly.length, 7, m.id);
  });
});
