/* End-to-end tests in headless Chromium (Track A, directive scenarios 1–15),
 * plus axe-core accessibility scans and screenshots for the case study.
 * The clock is frozen at Fri Oct 23, 2026, 2:00 pm Chicago time so results are deterministic.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PAGE = 'file://' + path.join(__dirname, '..', 'dist', 'museum.html');
const SHOTS = path.join(__dirname, '..', 'shots');
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const NOW = new Date('2026-10-23T19:00:00Z'); // 2 pm CDT, 9 pm Paris
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log('PASS', name); }
  catch (e) { results.push({ name, ok: false, err: e.message.split('\n')[0] }); console.log('FAIL', name, '-', e.message.split('\n')[0]); }
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }

async function fresh(browser, opts) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: (opts && opts.dark) ? 'dark' : 'light', locale: 'en-US' });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await ctx.clock.install({ time: NOW });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(PAGE + ((opts && opts.hash) || ''));
  return { ctx, page, errors };
}
async function typeQuery(page, q) {
  await page.fill('#q', '');
  await page.type('#q', q, { delay: 20 });
  await page.clock.runFor(300); // pass the 200 ms debounce
}
async function goCity(page, q) {
  await typeQuery(page, q);
  await page.click('#sugs .suggestion >> nth=0');
}
const cards = (page) => page.$$eval('.card', (els) => els.map((e) => ({
  name: e.querySelector('.m-name').textContent.trim(),
  status: e.querySelector('.status').textContent.trim(),
  notes: [...e.querySelectorAll('.note')].map((n) => n.textContent.trim()),
  caution: (e.querySelector('.caution') || {}).textContent || null,
  text: e.textContent.replace(/\s+/g, ' ')
})));
async function axe(page, label) {
  await page.addScriptTag({ content: AXE });
  const r = await page.evaluate(async () => {
    const out = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return out.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, help: v.help }));
  });
  return { label, violations: r };
}

(async () => {
  const browser = await chromium.launch();
  const a11y = [];

  // 1. Search for a museum by name
  await check('1 Search a museum by name', async () => {
    const { page, ctx, errors } = await fresh(browser);
    await page.screenshot({ path: path.join(SHOTS, '01-home.png') });
    await typeQuery(page, 'art inst');
    const first = await page.textContent('#sugs .suggestion >> nth=0');
    expect(first.includes('Art Institute of Chicago') && first.includes('Museum'), 'first suggestion is the museum, labeled Museum');
    await page.screenshot({ path: path.join(SHOTS, '02-suggestions.png') });
    await page.click('#sugs .suggestion >> nth=0');
    const cs = await cards(page);
    expect(cs.length === 1 && cs[0].name === 'Art Institute of Chicago', 'one card');
    expect(cs[0].status === 'Open Friday 11 am–5 pm', 'status for today: ' + cs[0].status);
    expect((await page.textContent('.listed')).includes('Showing 1 of 5'), 'offers the rest of the city');
    expect(!errors.length, 'no page errors: ' + errors.join('; '));
    await ctx.close();
  });

  // 2. Search for a city  + mandatory question (status lines alone answer it)
  let shared;
  await check('2 Search a city (all five Chicago museums, summary line)', async () => {
    shared = await fresh(browser);
    const { page } = shared;
    await goCity(page, 'chicago');
    expect((await page.textContent('#place')).trim() === 'Chicago, Illinois', 'place heading');
    const cs = await cards(page);
    expect(cs.length === 5, '5 cards, got ' + cs.length);
    const summary = (await page.textContent('.summary')).replace(/\s+/g, ' ').trim();
    expect(summary === '4 open · 1 unconfirmed on Friday, October 23', 'summary: ' + summary);
    await page.screenshot({ path: path.join(SHOTS, '03-chicago-today.png') });
  });

  // 4. Change the selected date
  await check('4 Change the selected date (Tue Oct 27)', async () => {
    const { page } = shared;
    await page.click('.day[data-date="2026-10-27"]');
    const summary = (await page.textContent('.summary span')).trim();
    expect(summary === '2 open · 2 closed · 1 unconfirmed', 'summary: ' + summary);
    const cs = await cards(page);
    const aic = cs.find((c) => c.name.startsWith('Art Institute'));
    expect(aic.status === 'Closed Tuesdays', 'AIC: ' + aic.status);
    expect((await page.getAttribute('.day[data-date="2026-10-27"]', 'aria-pressed')) === 'true', 'chip pressed');
    await page.screenshot({ path: path.join(SHOTS, '04-chicago-tuesday.png') });
    await page.screenshot({ path: path.join(SHOTS, '04b-chicago-tuesday-full.png'), fullPage: true });
  });

  // 9. Conditional admission (MCA Tuesday evening free for Illinois residents)
  await check('9 Conditional admission renders for the selected day', async () => {
    const { page } = shared;
    const mca = (await cards(page)).find((c) => c.name.startsWith('Museum of Contemporary'));
    expect(mca.text.includes('Free for Illinois residents 5–9 pm'), 'MCA Tuesday note');
    await page.click('.day[data-date="2026-10-28"]');
    const mca2 = (await cards(page)).find((c) => c.name.startsWith('Museum of Contemporary'));
    expect(!mca2.text.includes('Free for Illinois residents'), 'note gone on Wednesday');
  });

  // 8 + 10. Stale vs verified, missing exhibition
  await check('8 Verified and stale information look different', async () => {
    const { page } = shared;
    const cs = await cards(page);
    const smart = cs.find((c) => c.name === 'Smart Museum of Art');
    const dpam = cs.find((c) => c.name === 'DePaul Art Museum');
    expect(smart.status.startsWith('Usually open') && smart.caution && smart.caution.includes('may have changed'), 'Smart hedged');
    expect(dpam.status.startsWith('Open ') && !dpam.caution, 'DePaul definitive');
    expect(smart.text.includes('dated Summer 2025'), 'stale reason shown');
  });
  await check('10 Missing exhibition data reads calmly', async () => {
    const aic = (await cards(shared.page)).find((c) => c.name.startsWith('Art Institute'));
    expect(aic.text.includes('No exhibition information'), 'AIC exhibition line');
    const mca = (await cards(shared.page)).find((c) => c.name.startsWith('Museum of Contemporary'));
    expect(mca.text.includes('Kenzi Shiokava') && mca.text.includes('January 31, 2027'), 'MCA featured exhibition');
  });

  // 5 + 6. Week boundary, holiday exception
  await check('5 Navigate across a week boundary', async () => {
    const { page } = shared;
    expect(await page.isDisabled('.strip-nav.prev'), 'prev disabled on the first week');
    await page.click('.strip-nav.next');
    const first = await page.getAttribute('.day >> nth=0', 'data-date');
    expect(first === '2026-10-30', 'next window starts Oct 30, got ' + first);
    expect(!(await page.isDisabled('.strip-nav.prev')), 'prev enabled');
    await page.click('.strip-nav.prev');
    expect((await page.getAttribute('.day >> nth=0', 'data-date')) === '2026-10-23', 'back to today');
  });
  await check('6 Museum closed on a holiday (Thanksgiving)', async () => {
    const { page } = shared;
    for (let i = 0; i < 4; i++) await page.click('.strip-nav.next');
    await page.click('.day[data-date="2026-11-26"]');
    const aic = (await cards(page)).find((c) => c.name.startsWith('Art Institute'));
    expect(aic.status === 'Closed Thursday' && aic.notes.includes('Thanksgiving'), 'AIC: ' + aic.status + ' ' + aic.notes);
    const row = await page.$eval('#h-mus_art_institute_chicago', (h) => h.closest('.card').querySelector('.wrow[aria-current="date"] .wv').textContent);
    expect(row === 'Closed', 'week row overridden');
    await page.locator('#h-mus_art_institute_chicago').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, '06-thanksgiving.png') });
  });

  // 12. Return without losing context: reload restores place, date, scroll; Back from search returns to results
  await check('12 Return without losing context (reload + Back)', async () => {
    const { page } = shared;
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.reload();
    expect((await page.textContent('#place')).trim() === 'Chicago, Illinois', 'place restored');
    expect((await page.getAttribute('.day[aria-pressed="true"]', 'data-date')) === '2026-11-26', 'date restored');
    const y = await page.evaluate(() => window.scrollY);
    expect(y > 600, 'scroll restored, y=' + y);
    await page.click('.pill');
    expect(await page.isVisible('#home'), 'search opens');
    expect((await page.inputValue('#q')).length > 0, 'query kept');
    await page.goBack();
    expect(await page.isVisible('#results'), 'Back returns to results');
    expect((await page.getAttribute('.day[aria-pressed="true"]', 'data-date')) === '2026-11-26', 'date kept after Back');
    await shared.ctx.close();
  });

  // 3. Ambiguous city
  await check('3 Resolve an ambiguous city name (Paris)', async () => {
    const { page, ctx } = await fresh(browser);
    await typeQuery(page, 'Paris');
    const labels = await page.$$eval('#sugs .suggestion', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    expect(labels[0].includes('Paris, Île-de-France') || labels[1].includes('Paris, Île-de-France'), 'Paris, France offered');
    expect(labels.some((l) => l.includes('Paris, Texas')), 'Paris, Texas offered');
    expect(!(await page.getAttribute('#q', 'aria-activedescendant')), 'nothing preselected');
    await page.screenshot({ path: path.join(SHOTS, '05-ambiguous.png') });
    await page.click('#sugs .suggestion:has-text("Texas")');
    expect((await page.textContent('.empty strong')).includes('No museums listed in Paris, Texas'), 'empty city explained');
    await page.click('.empty .chip:has-text("Chicago")');
    expect((await cards(page)).length === 5, 'recovered to Chicago');
    await ctx.close();
  });

  // Louvre: typo tolerance + museum time zone + real exceptional closure + timed entry
  await check('Typo + museum time zone + exceptional closure (Louvre, Sat Oct 24)', async () => {
    const { page, ctx } = await fresh(browser);
    await typeQuery(page, 'Lovre');
    expect((await page.textContent('#sugs .suggestion >> nth=0')).includes('Musée du Louvre'), 'typo tolerated');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect((await page.getAttribute('.day >> nth=0', 'data-date')) === '2026-10-23', 'Paris today');
    await page.click('.day[data-date="2026-10-24"]');
    const [c] = await cards(page);
    expect(c.status === 'Closed Saturday' && c.notes.includes('Exceptional closure'), c.status);
    expect(c.text.includes('Reservation required for this date'), 'timed entry');
    expect(c.text.includes('€32'), 'euro pricing');
    await page.screenshot({ path: path.join(SHOTS, '07-louvre-closed.png') });
    await ctx.close();
  });

  // 7. Temporary closure (no live record has one; inject a test record in the page)
  await check('7 Temporary closure renders and blocks hours', async () => {
    const { page, ctx } = await fresh(browser);
    await page.evaluate(() => {
      const m = window.MUSEUM_DATA.museums.find((x) => x.id === 'mus_ram_wustum');
      m.hours.temporary_closure = { from: '2026-10-20', until: '2027-03-01', reason: 'TEST RECORD: injected by the test suite' };
    });
    await goCity(page, 'racine');
    const w = (await cards(page)).find((c) => c.name.startsWith('Wustum'));
    expect(w.status === 'Temporarily closed until March 1, 2027', w.status);
    await ctx.close();
  });

  // 11. Official website
  await check('11 Open the official museum website', async () => {
    const { page, ctx } = await fresh(browser);
    await ctx.route(/ramart\.org/, (r) => r.fulfill({ contentType: 'text/html', body: '<title>stub</title>stub' })); // sandbox has no outside network
    await goCity(page, 'racine');
    const link = page.locator('.site-link').first();
    expect((await link.getAttribute('target')) === '_blank', 'new tab');
    expect((await link.getAttribute('href')).startsWith('https://www.ramart.org'), 'official URL');
    const [popup] = await Promise.all([ctx.waitForEvent('page'), link.click()]);
    expect(popup.url().includes('ramart.org'), 'popup URL ' + popup.url());
    const ev = await page.evaluate(() => window.__museumEvents.map((e) => e.name));
    expect(ev.includes('official_site_opened'), 'event logged');
    await ctx.close();
  });

  // 13. Failed search + keyboard
  await check('13 Recover from a failed search; keyboard Escape', async () => {
    const { page, ctx } = await fresh(browser);
    await typeQuery(page, 'qzx');
    expect((await page.textContent('#search-msg')).includes('No museums or cities match'), 'no-match message');
    await page.screenshot({ path: path.join(SHOTS, '08-no-match.png') });
    await page.click('#search-msg .chip:has-text("Racine")');
    expect((await page.textContent('#place')).trim() === 'Racine, Wisconsin', 'recovered');
    await page.click('.pill');
    await typeQuery(page, 'chi');
    await page.keyboard.press('Escape');
    expect(await page.isHidden('#sugs'), 'Escape closes suggestions');
    await ctx.close();
  });

  // 14. Offline
  await check('14 Offline state hedges every status', async () => {
    const { page, ctx } = await fresh(browser);
    await goCity(page, 'chicago');
    await ctx.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    expect(await page.isVisible('.offline-banner'), 'banner');
    const cs = await cards(page);
    expect(cs.every((c) => !c.status.startsWith('Open ')), 'no definitive Open: ' + cs.map((c) => c.status).join(' | '));
    await page.screenshot({ path: path.join(SHOTS, '09-offline.png') });
    await ctx.close();
  });

  // 15. Larger text
  await check('15 Larger text (200%) reflows without horizontal scroll', async () => {
    const { page, ctx } = await fresh(browser);
    await goCity(page, 'racine');
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow <= 0, 'horizontal overflow ' + overflow + 'px');
    const cols = await page.$eval('.week-grid', (g) => getComputedStyle(g).gridAutoFlow);
    expect(cols === 'row', 'week reflows to one column, got ' + cols);
    await page.screenshot({ path: path.join(SHOTS, '10-large-text.png') });
    await ctx.close();
  });

  // Variant C test condition
  await check('Variant C test condition collapses supporting info', async () => {
    const { page, ctx } = await fresh(browser, { hash: '#variant-c' });
    await goCity(page, 'chicago');
    const details = await page.$$eval('details.more', (d) => d.length);
    expect(details === 5, 'one disclosure per card');
    expect(await page.isHidden('.card .week >> nth=0'), 'week hidden until opened');
    await page.screenshot({ path: path.join(SHOTS, '11-variant-c.png') });
    await page.click('details.more summary >> nth=0');
    expect(await page.isVisible('.card .week >> nth=0'), 'week shows on tap');
    await ctx.close();
  });

  // Accessibility scans (axe-core) and dark mode
  await check('Automated records: Minneapolis lists both; the unconfirmed reading is hedged', async () => {
    const s = await fresh(browser);
    await goCity(s.page, 'Minneapolis');
    const c = await cards(s.page);
    const mia = c.find((x) => x.name === 'Minneapolis Institute of Art');
    const walker = c.find((x) => x.name === 'Walker Art Center');
    expect(mia && walker, 'both Minneapolis museums listed: ' + c.map((x) => x.name).join(', '));
    expect(mia.status.startsWith('Usually open Friday'), 'Mia is held: ' + mia.status);
    expect(/Not yet confirmed/.test(mia.text), 'Mia footer says not yet confirmed');
    expect(walker.status.startsWith('Open Friday'), 'Walker open: ' + walker.status);
    expect(/Read automatically from the official site/.test(walker.text), 'automated provenance shown');
    expect(s.errors.length === 0, s.errors.join('; '));
    a11y.push(await axe(s.page, 'Results, Minneapolis (automated)'));
    await s.page.screenshot({ path: path.join(SHOTS, '20-minneapolis-automated.png'), fullPage: true });
    await s.ctx.close();
  });

  await check('Automated records: Detroit never claims free admission for everyone; no street is tidy', async () => {
    const s = await fresh(browser);
    await goCity(s.page, 'Detroit');
    const [dia] = await cards(s.page);
    expect(dia && dia.name === 'Detroit Institute of Arts', 'DIA listed');
    expect(!/Free admission/.test(dia.text), 'no "Free admission" claim');
    expect(/Admission not listed/.test(dia.text), 'admission not listed: ' + dia.text.slice(0, 200));
    expect(/Some second-floor galleries temporarily closed/.test(dia.text), 'partial closure shown');
    const meta = await s.page.$eval('.card .meta span', (e) => e.textContent.trim());
    expect(meta === 'Detroit', 'meta line is the city alone: ' + meta);
    await s.ctx.close();
  });

  await check('Automated records: search finds a museum by its short name in another state', async () => {
    const s = await fresh(browser);
    await typeQuery(s.page, 'SLAM');
    const first = await s.page.$eval('#sugs .suggestion', (e) => e.textContent.replace(/\s+/g, ' '));
    expect(/Saint Louis Art Museum/.test(first) && /St\. Louis, Missouri/.test(first), first);
    await s.ctx.close();
  });

  await check('Accessibility: axe-core scans (home, suggestions, results, dark)', async () => {
    let s = await fresh(browser);
    a11y.push(await axe(s.page, 'Home'));
    await typeQuery(s.page, 'paris');
    a11y.push(await axe(s.page, 'Suggestions'));
    await s.page.click('#sugs .suggestion >> nth=0');
    a11y.push(await axe(s.page, 'Results, Paris'));
    await s.ctx.close();
    s = await fresh(browser, { dark: true });
    await goCity(s.page, 'chicago');
    await s.page.click('.day[data-date="2026-10-27"]');
    a11y.push(await axe(s.page, 'Results, Chicago, dark'));
    await s.page.screenshot({ path: path.join(SHOTS, '12-dark.png') });
    await s.ctx.close();
    const total = a11y.reduce((n, r) => n + r.violations.length, 0);
    expect(total === 0, JSON.stringify(a11y.filter((r) => r.violations.length)));
  });

  // Keyboard-only path
  await check('Keyboard: Tab order reaches search, days, links, pill', async () => {
    const { page, ctx } = await fresh(browser);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement.id === 'q'), 'first stop is the search field');
    await page.keyboard.type('racine'); await page.clock.runFor(300);
    await page.keyboard.press('Enter');
    await page.clock.runFor(50); // let the frozen clock run the focus frame
    expect(await page.evaluate(() => document.activeElement.id === 'place'), 'focus moves to the results heading');
    const stops = [];
    for (let i = 0; i < 14; i++) { await page.keyboard.press('Tab'); stops.push(await page.evaluate(() => document.activeElement.className || document.activeElement.tagName)); }
    expect(stops.some((s) => s.includes('day')), 'day chips reachable');
    expect(stops.some((s) => s.includes('site-link')), 'official link reachable');
    await ctx.close();
  });

  await browser.close();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} passed`);
  fs.writeFileSync(path.join(__dirname, '..', 'shots', 'e2e-results.json'), JSON.stringify({ results, a11y }, null, 2));
  process.exit(pass === results.length ? 0 : 1);
})();
