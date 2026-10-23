/* Smoke test of the REAL build in dist/ (whatever data it holds), run just before deploying:
 * the page loads its data with no errors, the footer count matches the data, and a search works. */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const DIST = path.join(__dirname, '..', 'dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0]; if (p.endsWith('/')) p += 'index.html';
  const f = path.join(DIST, p);
  if (!f.startsWith(DIST) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
(async () => {
  const data = JSON.parse(fs.readFileSync(path.join(DIST, 'data', 'museums.json'), 'utf8'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  let ok = true;
  try {
    await page.goto(base);
    await page.waitForSelector('.foot-stats:not(:empty)', { timeout: 15000 });
    const foot = await page.textContent('.foot-stats');
    const n = data.museums.length.toLocaleString('en-US');
    if (!foot.startsWith(n + ' art museum')) throw new Error(`footer says "${foot}", data has ${n}`);
    // search the city with the most museums and expect that many cards
    const counts = {};
    data.museums.forEach((m) => { counts[m.city_id] = (counts[m.city_id] || 0) + 1; });
    const [cityId, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const city = data.cities.find((c) => c.id === cityId);
    await page.fill('#q', city.name);
    await page.waitForSelector('#sugs .suggestion');
    await page.click(`#sugs .suggestion:has-text("${city.name}, ${city.region}")`);
    await page.waitForSelector('.card');
    const cards = (await page.$$('.card')).length;
    if (cards !== count) throw new Error(`${city.name}: ${cards} cards, expected ${count}`);
    if (problems.length) throw new Error(problems.join(' | '));
    console.log(`smoke ok: ${n} museums, ${city.name} shows ${cards}`);
  } catch (e) { ok = false; console.error('SMOKE FAILED:', e.message); }
  await browser.close(); server.close();
  process.exit(ok ? 0 : 1);
})();
