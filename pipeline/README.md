# Muzeum pipeline

Reads opening hours, holiday closures, admission and current exhibitions from each art museum's own visit page, with one fixed prompt for every museum and written rules after it.

| Module | Job |
| --- | --- |
| `discover.py` | Wikidata query per state (with a simpler fallback query, retries, stable ids, aliases, time zone from coordinates) |
| `fetch.py` | robots.txt, named user agent, 2 s spacing per site across threads, retries, headless fallback, page-text hash |
| `extract.py` | `prompts/extract.v3.txt` to Claude; JSON shape check and one retry |
| `normalize.py` + `holidays.py` | Holiday names, recurring days and early closes become dates; prices, free tiers, exhibitions |
| `validate.py` + `crosscheck.py` | publish / hold / drop, with reasons |
| `export.py` | The app's data schema, written atomically |
| `pipeline.py` | The daily run: state, change detection, model cap, carry-forward, overrides, hand-checked merge, circuit breaker, review queue |
| `benchmark.py` | Scores readings against `benchmark/answer_key.json` |

Settings come from environment variables; see `config.py`. Run `python run.py --help` for the options.

`runs/2026-10-23/` holds the recorded 17-museum test that the whole-run tests and the benchmark floor replay.
