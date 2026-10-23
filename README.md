# Muzeum

Which art museums are open on your day, what they cost, and what's on. Every US state, read daily from each museum's own website.

**To put it online, follow [DEPLOY.md](DEPLOY.md).**

## How it works

```
Wikidata (weekly) → visit pages (daily, robots.txt respected)
  → one fixed prompt reads each changed page → written rules check every reading
  → publish / hold ("Usually open") / drop → data/museums.json → static site on GitHub Pages
```

- **No per-museum code.** Every museum goes through the same prompt and rules. Reviewer decisions live in `pipeline/overrides.json`.
- **Honest by default.** A reading that fails a check, is getting old, or is shown offline says "Usually open", never "Open".
- **Safe to leave running.** Unchanged pages skip the model. A page that stops loading keeps its last reading while it ages. A run that would shrink the site sharply is stopped by a circuit breaker. Git history records every change.
- **Fast and private.** Static site with a strict Content Security Policy, self-hosted fonts, no cookies and no tracking. It works offline after one visit.

## Layout

| Path | What |
| --- | --- |
| `app/` | The site: `src/` (logic, app, styles, service worker), `public/` (icons, fonts), `build.js`, tests |
| `pipeline/` | The daily reader: `muzeum_pipeline/` modules, `prompts/`, `run.py`, tests, `manual.json` (hand-checked records), `overrides.json` |
| `pipeline/state/` | Written by the daily run: registry, last reading per museum, report, review queue, history |
| `data/museums.json` | What the site shows; replaced by each run |
| `.github/workflows/` | `ci.yml` tests everything, `update-data.yml` runs daily, `deploy.yml` publishes |

## Run locally

```
# pipeline (needs ANTHROPIC_API_KEY for a real run)
cd pipeline && pip install -r requirements.txt
python -m unittest discover -s tests -t .      # 49 tests, no network needed
python run.py --states RI --dry-run            # one small state, without changing the site data

# site
cd app && npm install && npx playwright install chromium
npm test                                      # unit, preview and public-site end-to-end tests
node build.js && npx serve dist               # or any static server
```

## Tests

- **Pipeline (49):** the rules, fake network layers (robots.txt, retries, Wikidata fallbacks, model retries), and whole daily runs on recorded data. The runs cover change detection, outages, the model-call cap, the circuit breaker, reviewer overrides and stable ids. A benchmark floor requires at least 85 of 88 fields to match the hand-checked answer key.
- **App:** 18 unit tests. The preview build has 22 end-to-end tests, including axe accessibility scans. The public site has 6 more: runtime data, strict CSP, offline through the service worker, data-failure recovery, and 2,000-museum search speed. A smoke test runs on the real build before every deploy.

The current `data/museums.json` is the October 23, 2026 test set: 19 museums in 7 states, plus Paris. The first daily run replaces it with every state.
