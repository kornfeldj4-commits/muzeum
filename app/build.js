// Muzeum build.
//   node build.js              -> dist/ : the public site (GitHub Pages), loads data/museums.json
//   node build.js --artifact   -> dist/museum.html : one self-contained preview page with data inlined
//   --data <file>              -> which museums.json to use (default ../data/museums.json)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const ARTIFACT = args.includes('--artifact');
const dataArg = args.indexOf('--data');
const DATA = path.resolve(dataArg >= 0 ? args[dataArg + 1] : path.join(__dirname, '..', 'data', 'museums.json'));
const SRC = (p) => fs.readFileSync(path.join(__dirname, 'src', p), 'utf8');
const DIST = path.join(__dirname, 'dist');
const siteCfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'site.config.json'), 'utf8')); } catch (e) { return {}; } })();
const repo = process.env.GITHUB_REPOSITORY || siteCfg.repo || '';
const reportUrl = siteCfg.reportUrl || (repo ? `https://github.com/${repo}/issues/new` : '');

const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
if (!Array.isArray(data.museums) || !data.museums.length) throw new Error('no museums in ' + DATA);

const template = SRC('index.template.html');
const css = SRC('styles.css');
const js = (cfg) => `window.MUZEUM_CONFIG=${JSON.stringify(cfg)};\n${SRC('logic.js')}\n${SRC('app.js')}\n${SRC('boot.js')}`;
const FONT_LINKS = /<link rel="preconnect"[^>]*>\s*<link rel="preconnect"[^>]*>\s*<link rel="stylesheet" href="https:\/\/fonts\.googleapis[^>]*>\s*/;

fs.mkdirSync(DIST, { recursive: true });

if (ARTIFACT) {
  const html = template
    .replace('/*__STYLES__*/', () => css)
    .replace('/*__DATA__*/', () => `window.MUSEUM_DATA=${JSON.stringify(data)};`)
    .replace('/*__LOGIC__*/', () => `window.MUZEUM_CONFIG=${JSON.stringify({ mode: 'artifact', reportUrl })};\n${SRC('logic.js')}`)
    .replace('/*__APP__*/', () => `${SRC('app.js')}\n${SRC('boot.js')}`);
  fs.writeFileSync(path.join(DIST, 'museum.html'), html);
  console.log('built dist/museum.html', (html.length / 1024).toFixed(1) + ' KB,', data.museums.length, 'museums');
  process.exit(0);
}

// ---------------- public site ----------------
for (const f of fs.readdirSync(DIST)) fs.rmSync(path.join(DIST, f), { recursive: true, force: true });
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
const pub = path.join(__dirname, 'public');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
walk(pub).forEach((f) => copy(f, path.join(DIST, path.relative(pub, f))));
copy(DATA, path.join(DIST, 'data', 'museums.json'));

const fontCss = [400, 600, 700, 800].map((w) =>
  `@font-face{font-family:'Public Sans';font-style:normal;font-weight:${w};font-display:swap;src:url(../fonts/public-sans-${w}.woff2) format('woff2')}`).join('\n');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);
const cssOut = `${fontCss}\n${css}\n${aboutCss()}`;
const jsOut = js({ mode: 'pages', sw: true, reportUrl, dataUrl: 'data/museums.json' });
const cssName = `assets/muzeum.${hash(cssOut)}.css`;
const jsName = `assets/muzeum.${hash(jsOut)}.js`;
fs.mkdirSync(path.join(DIST, 'assets'), { recursive: true });
fs.writeFileSync(path.join(DIST, cssName), cssOut);
fs.writeFileSync(path.join(DIST, jsName), jsOut);

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";
const head = (title, desc) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>${title}</title>
<meta name="description" content="${desc}">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f1012" media="(prefers-color-scheme: dark)">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="website">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<link rel="manifest" href="manifest.webmanifest">
<link rel="stylesheet" href="${cssName}">
</head>
<body>
`;
const DESC = "Which art museums are open on your day, what they cost, and what's on.";
const body = template
  .replace(/<title>[\s\S]*?<\/title>\s*/, '')
  .replace(/<script>document\.documentElement\.lang[^<]*<\/script>\s*/, '')
  .replace(/<meta name="claude:viewport-fit-sides"[^>]*>\s*/, '')
  .replace(/<meta name="description"[^>]*>\s*/, '')
  .replace(FONT_LINKS, '')
  .replace(/<style>\s*\/\*__STYLES__\*\/\s*<\/style>\s*/, '')
  .replace(/<script>\s*\/\*__DATA__\*\/\s*<\/script>\s*/, '')
  .replace(/<script>\s*\/\*__LOGIC__\*\/\s*<\/script>\s*/, '')
  .replace(/<script>\s*\/\*__APP__\*\/\s*<\/script>\s*/, `<script src="${jsName}" defer></script>\n`);
if (/__[A-Z]+__|<script>/.test(body)) throw new Error('template placeholder or inline script left in index.html');
fs.writeFileSync(path.join(DIST, 'index.html'), head('Muzeum', DESC) + body + '</body>\n</html>\n');

const about = SRC('about.template.html')
  .replace('<!--REPORT-->', reportUrl ? ` (or <a href="${reportUrl}">open a report</a>)` : '')
  .replace('<span id="updated">recently</span>', `<span id="updated">${new Date(data.generated + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}</span>`);
fs.writeFileSync(path.join(DIST, 'about.html'), head('About the data · Muzeum', 'Where Muzeum gets museum hours, how they are checked, and how to report a mistake.') + about + '</body>\n</html>\n');
fs.writeFileSync(path.join(DIST, '404.html'), head('Not found · Muzeum', DESC) + '<main class="about wrap"><h1>Page not found</h1><p><a href="./">Go to Muzeum</a></p></main></body>\n</html>\n');

fs.writeFileSync(path.join(DIST, 'manifest.webmanifest'), JSON.stringify({
  name: 'Muzeum', short_name: 'Muzeum', description: DESC, start_url: './', scope: './', display: 'standalone',
  background_color: '#ffffff', theme_color: '#111111',
  icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }, { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' }]
}, null, 1));
fs.writeFileSync(path.join(DIST, 'robots.txt'), 'User-agent: *\nAllow: /\n');
fs.writeFileSync(path.join(DIST, '.nojekyll'), '');

const shell = ['./', 'index.html', 'about.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', cssName, jsName,
  'fonts/public-sans-400.woff2', 'fonts/public-sans-600.woff2', 'fonts/public-sans-700.woff2', 'fonts/public-sans-800.woff2'];
fs.writeFileSync(path.join(DIST, 'sw.js'), SRC('sw.js').replace('__BUILD__', hash(cssOut + jsOut)).replace('__SHELL__', JSON.stringify(shell)));
console.log(`built dist/ (${data.museums.length} museums, data ${data.generated}${reportUrl ? ', reports to ' + reportUrl : ''})`);

function aboutCss() {
  return `.about{max-width:40rem;padding-block:2rem 4rem}.about h1{font-size:2rem;margin:.5rem 0 1rem}.about h2{font-size:1.15rem;margin:2rem 0 .5rem}
.about .lead{font-size:1.1rem}.about li{margin:.4rem 0}.about .legend dt{font-weight:700;margin-top:.6rem}.about .legend dd{margin:0}.about .legend{margin-bottom:1.25rem}
.about .quiet{color:var(--fg-quiet);font-size:.9rem;margin-top:2rem}.back-link{text-decoration:none;font-weight:600}
.foot-links{display:flex;gap:1rem;flex-wrap:wrap;align-items:center}.report-link{font-size:.9rem;color:var(--fg-quiet)}
.about-link{white-space:nowrap}`;
}
