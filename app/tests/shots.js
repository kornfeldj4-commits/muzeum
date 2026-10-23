// Case-study screenshots with the real Public Sans (served locally in place of Google Fonts).
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const PAGE = 'file://' + path.join(__dirname, '..', 'dist', 'museum.html');
const OUT = path.join(__dirname, '..', 'shots', 'case');
fs.mkdirSync(OUT, { recursive: true });
const fontDir = path.join(__dirname, '..', 'node_modules', '@fontsource', 'public-sans', 'files');
const css = [400, 600, 700, 800].map((w) => `@font-face{font-family:'Public Sans';font-weight:${w};font-style:normal;src:url(data:font/woff2;base64,${fs.readFileSync(path.join(fontDir, `public-sans-latin-${w}-normal.woff2`)).toString('base64')}) format('woff2');}`).join('\n');

async function shot(browser, name, steps, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: opts.h || 844 }, deviceScaleFactor: 2, colorScheme: opts.dark ? 'dark' : 'light', locale: 'en-US' });
  await ctx.route(/fonts\.googleapis\.com/, (r) => r.fulfill({ contentType: 'text/css', body: css }));
  await ctx.route(/fonts\.gstatic\.com/, (r) => r.abort());
  await ctx.clock.install({ time: new Date('2026-10-23T19:00:00Z') });
  const page = await ctx.newPage();
  await page.goto(PAGE + (opts.hash || ''));
  await page.evaluate(() => document.fonts.ready);
  await steps(page);
  await page.clock.runFor(100);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.screenshot({ path: path.join(OUT, name + '.png') });
  await ctx.close();
}
const city = async (page, q, pick) => { await page.type('#q', q, { delay: 10 }); await page.clock.runFor(300); await page.click(pick ? `#sugs .suggestion:has-text("${pick}")` : '#sugs .suggestion >> nth=0'); };

(async () => {
  const b = await chromium.launch();
  await shot(b, 'a-home', async () => {});
  await shot(b, 'b-suggest', async (p) => { await p.type('#q', 'Paris', { delay: 10 }); await p.clock.runFor(300); await p.focus('#q'); });
  await shot(b, 'c-chicago-sat', async (p) => { await city(p, 'chicago'); await p.click('.day[data-date="2026-10-24"]'); });
  await shot(b, 'd-chicago-tue', async (p) => { await city(p, 'chicago'); await p.click('.day[data-date="2026-10-27"]'); await p.evaluate(() => document.querySelector('#h-mus_smart_museum').closest('.card').scrollIntoView({ block: 'center' })); });
  await shot(b, 'e-louvre', async (p) => { await city(p, 'Lovre'); await p.click('.day[data-date="2026-10-24"]'); });
  await shot(b, 'f-racine-sat', async (p) => { await city(p, 'racine'); await p.click('.day[data-date="2026-10-24"]'); });
  await shot(b, 'g-offline', async (p) => { await city(p, 'chicago'); await p.context().setOffline(true); await p.evaluate(() => window.dispatchEvent(new Event('offline'))); });
  await shot(b, 'h-variant-c', async (p) => { await city(p, 'chicago'); await p.click('.day[data-date="2026-10-24"]'); }, { hash: '#variant-c' });
  await shot(b, 'i-dark', async (p) => { await city(p, 'chicago'); await p.click('.day[data-date="2026-10-27"]'); }, { dark: true });
  await shot(b, 'j-large', async (p) => { await city(p, 'racine'); await p.addStyleTag({ content: 'html{font-size:175%!important}' }); });
  await b.close();

  // Compose sheets of three phones with a thin frame
  const compose = async (names, out) => {
    const w = 390, h = 844, pad = 24;
    const bufs = await Promise.all(names.map((n) => sharp(path.join(OUT, n + '.png')).resize(w, h).png().toBuffer()));
    const framed = await Promise.all(bufs.map((buf) => sharp({ create: { width: w + 4, height: h + 4, channels: 4, background: '#c9ccd1' } }).composite([{ input: buf, left: 2, top: 2 }]).png().toBuffer()));
    await sharp({ create: { width: pad + names.length * (w + 4 + pad), height: h + 4 + pad * 2, channels: 4, background: '#f1f2f4' } })
      .composite(framed.map((f, i) => ({ input: f, left: pad + i * (w + 4 + pad), top: pad }))).png().toFile(path.join(OUT, out));
  };
  await compose(['a-home', 'b-suggest', 'c-chicago-sat'], 'sheet-search.png');
  await compose(['d-chicago-tue', 'e-louvre', 'f-racine-sat'], 'sheet-states.png');
  await compose(['g-offline', 'h-variant-c', 'i-dark'], 'sheet-conditions.png');
  console.log('done');
})();
