/* End-to-end tests of the PUBLIC SITE build (dist/), served over http like GitHub Pages:
 * data loads at runtime, the CSP holds, the service worker makes it work offline,
 * failures are handled, the about page is accessible, and search stays fast at 2,000 museums.
 * Run: node build.js && node tests/site.e2e.js
 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
// Build the site from the fixed test data, with a known repository for the report link.
const REPO = 'example/muzeum';
require('child_process').execFileSync('node', ['build.js', '--data', path.join(__dirname, 'fixtures', 'museums.json')],
  { cwd: path.join(__dirname, '..'), env: { ...process.env, GITHUB_REPOSITORY: REPO }, stdio: 'inherit' });
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const NOW = new Date('2026-10-23T19:00:00Z');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };

let dataOverride = null;   // tests can swap the museums.json served
let failData = false;
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  if (p === '/data/museums.json' && failData) { res.writeHead(500); return res.end('boom'); }
  if (p === '/data/museums.json' && dataOverride) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(dataOverride); }
  const f = path.join(DIST, p);
  if (!f.startsWith(DIST) || !fs.existsSync(f)) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(path.join(DIST, '404.html'))); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log('PASS', name); }
  catch (e) { results.push({ name, ok: false, err: e.message.split('\n')[0] }); console.log('FAIL', name, '-', e.message.split('\n')[0]); }
}
const expect = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const ctxFor = async (opts) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US', serviceWorkers: 'allow', ...(opts || {}) });
    const page = await ctx.newPage();
    await page.clock.setFixedTime(NOW);
    const problems = [];
    page.on('pageerror', (e) => problems.push('error: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
    return { ctx, page, problems };
  };
  const search = async (page, q) => {
    await page.fill('#q', q);
    await page.waitForSelector('#sugs .suggestion');
    await page.click('#sugs .suggestion >> nth=0');
    await page.waitForSelector('.card');
  };

  await check('Site loads data at runtime with a strict CSP and no errors', async () => {
    const { ctx, page, problems } = await ctxFor();
    await page.goto(BASE);
    await page.waitForFunction(() => /art museums? in/.test((document.querySelector('.foot-stats') || {}).textContent || ''));
    const foot = await page.textContent('.foot-stats');
    expect(/19 art museums in 7 US states and France/.test(foot), foot);
    await search(page, 'Chicago');
    expect((await page.$$('.card')).length === 5, 'five Chicago cards');
    expect(problems.length === 0, problems.join(' | '));
    await ctx.close();
  });

  await check('Report a problem link is prefilled for the museum and day', async () => {
    const { ctx, page } = await ctxFor();
    await page.goto(BASE);
    await search(page, 'Walker');
    const href = await page.getAttribute('.report-link', 'href');
    expect(href.startsWith(`https://github.com/${REPO}/issues/new?`), href);
    const u = new URL(href);
    expect(u.searchParams.get('title') === 'Wrong info: Walker Art Center', u.searchParams.get('title'));
    expect(/Date viewed: 2026-10-23/.test(u.searchParams.get('body')), u.searchParams.get('body'));
    await ctx.close();
  });

  await check('Works offline after one visit, marked as saved data', async () => {
    const { ctx, page, problems } = await ctxFor();
    await page.goto(BASE);
    await page.waitForFunction(async () => { const r = await navigator.serviceWorker.ready; return !!r.active; });
    await page.reload();   // now controlled by the service worker, data saved
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.waitForSelector('.foot-stats:not(:empty)');
    await ctx.setOffline(true);
    await page.reload();
    await search(page, 'Cleveland');
    const status = await page.textContent('.card .status');
    expect(/^Usually open/.test(status.trim()), 'hedged offline: ' + status);
    expect(await page.isVisible('.offline-banner'), 'offline banner');
    const keys = await page.evaluate(async () => { const out = []; for (const n of await caches.keys()) { const c = await caches.open(n); out.push(n + ':' + (await c.keys()).map((r) => new URL(r.url).pathname).join(',')); } return out.join(' | '); });
    await page.goto(BASE + 'about.html');
    const h1 = await page.textContent('h1').catch((e) => 'ERR ' + e.message.slice(0, 80));
    expect(/About the data/.test(h1), 'about page offline: ' + h1 + ' url=' + page.url() + ' title=' + (await page.title()));
    expect(problems.filter((p) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(p)).length === 0, problems.join(' | '));
    await ctx.close();
  });

  await check('A failed data load says so and offers a retry', async () => {
    failData = true;
    const { ctx, page } = await ctxFor();
    await page.goto(BASE);
    await page.waitForSelector('#retry');
    expect(/couldn't load the museum list/.test(await page.textContent('#search-msg')), 'message');
    expect(await page.isDisabled('#q'), 'search disabled');
    failData = false;
    await page.click('#retry');
    await page.waitForSelector('.foot-stats:not(:empty)');
    expect(!(await page.isDisabled('#q')), 'recovered');
    await ctx.close();
  });

  await check('About page and 404 are accessible (axe)', async () => {
    const { ctx, page } = await ctxFor({ bypassCSP: true });   // only so the test can inject axe
    for (const url of ['about.html', 'no-such-page']) {
      await page.goto(BASE + url);
      await page.addScriptTag({ content: AXE });
      const v = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } })).violations.map((x) => x.id));
      expect(v.length === 0, url + ': ' + v.join(', '));
    }
    await ctx.close();
  });

  await check('Search stays fast with 2,000 museums in 600 cities', async () => {
    const base = JSON.parse(fs.readFileSync(path.join(DIST, 'data', 'museums.json'), 'utf8'));
    const words = ['Oak', 'River', 'Lake', 'Hill', 'Pine', 'Cedar', 'Maple', 'Stone', 'Union', 'Bridge', 'Harbor', 'Mill'];
    const states = ['AL', 'AZ', 'CA', 'CO', 'FL', 'GA', 'NY', 'TX', 'WA', 'PA', 'NC', 'VA'];
    const cities = [], museums = [];
    for (let i = 0; i < 600; i++) {
      const st = states[i % states.length];
      const name = `${words[i % 12]}${words[(i * 7) % 12].toLowerCase()} ${i}`;
      cities.push({ id: `c${i}-${st.toLowerCase()}`, name, region: st, country: 'United States', time_zone: 'America/New_York' });
    }
    for (let i = 0; i < 2000; i++) {
      const t = base.museums[i % base.museums.length];
      const c = cities[i % 600];
      museums.push({ ...t, id: `syn_${i}`, city_id: c.id, name: { display: `${words[(i * 5) % 12]} Art Museum ${i}`, original: '', alternates: [] },
        location: { ...t.location, city: c.name, region: c.region, country_code: 'US' } });
    }
    dataOverride = JSON.stringify({ ...base, cities: [...base.cities, ...cities], museums: [...base.museums, ...museums] });
    const { ctx, page } = await ctxFor();
    await page.goto(BASE);
    await page.waitForSelector('.foot-stats:not(:empty)');
    const ms = await page.evaluate(() => {
      const L = window.MuseumLogic;
      const D = window.__muzeumData;
      const idx = L.buildIndex(D);
      const qs = ['ced', 'cedar', 'harb', 'harbor art', 'riverlake 1', 'chicgo', 'walker', 'mill art museum 19'];
      const t0 = performance.now();
      for (let k = 0; k < 5; k++) qs.forEach((q) => L.search(q, idx, 6));
      return (performance.now() - t0) / (qs.length * 5);
    });
    expect(ms < 40, `average search took ${ms.toFixed(1)} ms`);
    await search(page, 'Chicago');
    expect((await page.$$('.card')).length === 5, 'real data still found among synthetic');
    dataOverride = null;
    await ctx.close();
    console.log(`   average search over 2,600 entries: ${ms.toFixed(1)} ms`);
  });

  await browser.close();
  server.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
