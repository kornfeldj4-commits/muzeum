/* Muzeum boot: load the museum data, then start the app.
 * - Inline builds (preview, tests) carry window.MUSEUM_DATA and start at once.
 * - The public site fetches data/museums.json; the service worker keeps the last
 *   copy so the app still opens offline, clearly marked as saved data.
 */
(function () {
  const CFG = window.MUZEUM_CONFIG || {};
  const ready = (fn) => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', fn) : fn());
  const valid = (d) => d && Array.isArray(d.museums) && Array.isArray(d.cities) && d.museums.length > 0;

  function fail(msg) {
    ready(() => {
      const box = document.getElementById('search-msg');
      const input = document.getElementById('q');
      if (input) input.disabled = true;
      box.hidden = false;
      box.innerHTML = `<strong>${msg}</strong><p>Check your connection, then try again.</p><div class="chips"><button type="button" class="chip" id="retry">Try again</button></div>`;
      document.getElementById('retry').addEventListener('click', () => location.reload());
    });
  }

  if (window.MUSEUM_DATA) { ready(() => window.MuzeumApp(window.MUSEUM_DATA, {})); return; }

  if (CFG.sw && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
  fetch(CFG.dataUrl || 'data/museums.json', { cache: 'no-cache' })
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const fromCache = r.headers.get('x-muzeum-cache') === '1';
      return r.json().then((d) => {
        if (!valid(d)) throw new Error('bad data');
        ready(() => window.MuzeumApp(d, { fromCache }));
      });
    })
    .catch(() => fail("Muzeum couldn't load the museum list."));
})();
