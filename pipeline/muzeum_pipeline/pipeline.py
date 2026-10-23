"""The daily run, end to end, built to run unattended.

State lives in pipeline/state/ and is committed back to the repository by the
scheduled job, so git history is the audit trail of every change to every museum.

  registry.json      museums found per state (discovery re-runs weekly)
  pages/<id>.json    last page hash, last extraction, last good check date
  report.json        this run: every museum, its verdict and the reasons
  review.md          held museums for a person to confirm (see overrides.json)
  history.jsonl      one line per run: counts, model tokens
"""
from __future__ import annotations

import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path

from . import benchmark, config, crosscheck, discover, export, jsonld, states
from . import normalize as N
from . import validate as V

HOURS_WORDS = re.compile(r"\b(hours|open|closed|a\.?m\.?|p\.?m\.?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", re.I)


# ------------------------------------------------------------------ state io
def _read(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _write(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1, ensure_ascii=False, sort_keys=True, default=list))
    tmp.replace(path)


class State:
    def __init__(self, root: Path):
        self.root = root
        self.registry = _read(root / "registry.json", {"states": {}, "museums": {}})

    def page(self, mid: str) -> dict:
        return _read(self.root / "pages" / f"{mid}.json", {})

    def save_page(self, mid: str, rec: dict):
        _write(self.root / "pages" / f"{mid}.json", rec)

    def save_registry(self):
        _write(self.root / "registry.json", self.registry)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ------------------------------------------------------------------ steps
def refresh_registry(st: State, wanted: list[str], today: date, force: bool, session=None):
    reg = st.registry
    stale = [c for c in wanted
             if force or not reg["states"].get(c)
             or date.fromisoformat(reg["states"][c]["updated"]) <= today - timedelta(days=config.REGISTRY_MAX_AGE_DAYS)]
    for code in stale:
        found = discover.discover_state(code, session)
        if found is None:
            log(f"discovery {code}: Wikidata did not answer, keeping last list")
            continue
        previous = {mid: m for mid, m in reg["museums"].items() if m.get("state") == code}
        found = discover.assign_ids(found, reg["museums"])
        keep = {m["id"] for m in found}
        for mid in previous:
            if mid not in keep:
                reg["museums"].pop(mid, None)       # no longer in Wikidata (closed, merged, retyped)
        for m in found:
            reg["museums"][m["id"]] = {**reg["museums"].get(m["id"], {}), **m}
        reg["states"][code] = {"updated": today.isoformat(), "count": len(found)}
        log(f"discovery {code}: {len(found)} museums")
        time.sleep(1)   # be gentle with the public endpoint
    st.save_registry()


def fetch_all(museums: list[dict], fetcher, finder) -> dict[str, dict]:
    def one(m):
        if not m.get("url"):
            m["url"] = finder(m["home"]) or m["home"]
        return m["id"], fetcher(m["url"])
    out = {}
    with ThreadPoolExecutor(max_workers=config.WORKERS) as pool:
        for mid, page in pool.map(one, museums):
            out[mid] = page
    return out


def plan_extractions(museums, pages, st: State, limit: int):
    """Which pages need the model: new or changed text, most useful first."""
    known, new = [], []
    for m in museums:
        page = pages.get(m["id"]) or {}
        if not page.get("hash"):
            continue
        prev = st.page(m["id"])
        if prev.get("hash") == page["hash"] and prev.get("raw"):
            continue
        if not HOURS_WORDS.search(page["text"]):
            continue
        (known if prev.get("raw") else new).append(m)
    queue = known + new
    return queue[:limit], queue[limit:]


# ------------------------------------------------------------------ overrides and manual
def load_overrides() -> dict:
    o = _read(config.OVERRIDES, {})
    return {k: v for k, v in o.items() if not k.startswith("_")}


def apply_override(rec: dict, ov: dict, page_hash: str | None, verdict: str) -> tuple[dict | None, str]:
    if ov.get("exclude"):
        return None, "excluded"
    if ov.get("confirm_hash") and ov["confirm_hash"] == page_hash and verdict == "hold":
        rec["provenance"]["conflict_flag"] = False
        rec["provenance"]["conflict_note"] = None
        rec["provenance"]["confirmed"] = ov.get("note") or "confirmed by a reviewer"
        verdict = "publish"
    for path, value in (ov.get("set") or {}).items():
        node = rec
        keys = path.split(".")
        for k in keys[:-1]:
            node = node.setdefault(k, {})
        node[keys[-1]] = value
    return rec, verdict


def merge_manual(auto: list[dict], today: date) -> tuple[list[dict], list[dict], list[str]]:
    """A hand-checked record replaces the automated one for the same museum
    (same website domain + overlapping name) while it is fresh."""
    manual = _read(config.MANUAL, {"cities": [], "museums": []})
    out = {m["id"]: m for m in auto}
    by_dom = {}
    for m in auto:
        by_dom.setdefault(discover.domain(m["official_url"]), []).append(m)
    notes = []
    for h in manual["museums"]:
        twin = next((a for a in by_dom.get(discover.domain(h["official_url"]), []) if _same_name(a, h)), None)
        age = (today - date.fromisoformat(h["provenance"]["verified_at"])).days
        if twin and age > config.MANUAL_WINS_DAYS and not twin["provenance"]["conflict_flag"]:
            notes.append(f"{h['id']}: automated reading replaces the {age}-day-old hand check")
            continue
        if twin:
            out.pop(twin["id"], None)
        out[h["id"]] = h
    return list(out.values()), manual["cities"], notes


def _same_name(a: dict, b: dict) -> bool:
    def words(m):
        names = [m["name"]["display"], m["name"].get("original", "")] + list(m["name"].get("alternates") or [])
        return {w for n in names for w in re.findall(r"[a-z]{3,}", n.lower())} - {"the", "and", "art", "museum", "arts", "of"}
    return bool(words(a) & words(b))


# ------------------------------------------------------------------ run
def run(*, today: date, wanted_states: list[str], extractor=None, fetcher=None, finder=None,
        session=None, force_discovery=False, allow_shrink=False, dry_run=False) -> dict:
    from . import fetch as F
    fetcher = fetcher or F.fetch
    finder = finder or F.find_visit_page
    st = State(config.STATE_DIR)

    refresh_registry(st, wanted_states, today, force_discovery, session)
    museums = [m for m in st.registry["museums"].values() if m["state"] in wanted_states]
    overrides = load_overrides()
    for m in museums:   # a reviewer can point a museum at a better page
        if (overrides.get(m["id"]) or {}).get("url"):
            m["url"] = overrides[m["id"]]["url"]
    museums = [m for m in museums if not (overrides.get(m["id"]) or {}).get("exclude")]
    log(f"{len(museums)} museums in {len(wanted_states)} states")

    pages = fetch_all(museums, fetcher, finder)
    st.save_registry()   # visit pages found this run
    todo, deferred = plan_extractions(museums, pages, st, config.MAX_EXTRACTIONS)
    log(f"model calls this run: {len(todo)} (deferred to next run: {len(deferred)})")

    usage = {"input_tokens": 0, "output_tokens": 0, "calls": 0, "errors": 0}
    if extractor is None:
        from .extract import extract as extractor

    def do_extract(m):
        try:
            raw, u = extractor(pages[m["id"]]["text"], m)
            return m["id"], raw, u, None
        except Exception as e:   # one bad page never stops the run
            return m["id"], None, {}, f"{e.__class__.__name__}: {str(e)[:120]}"

    with ThreadPoolExecutor(max_workers=4) as pool:
        for mid, raw, u, err in pool.map(do_extract, todo):
            usage["calls"] += 1
            usage["input_tokens"] += u.get("input_tokens", 0)
            usage["output_tokens"] += u.get("output_tokens", 0)
            prev = st.page(mid)
            if err:
                usage["errors"] += 1
                prev["last_error"] = err
            else:
                page = pages[mid]
                prev.update({"hash": page["hash"], "raw": raw, "raw_at": today.isoformat(),
                             "checked_at": today.isoformat(), "url": page["final_url"],
                             "jsonld": jsonld.opening_hours(page["html"]), "last_error": None})
            st.save_page(mid, prev)

    # pages that did not change since their last reading: the reading is confirmed again today
    extracted = {m["id"] for m in todo}
    for m in museums:
        page, prev = pages.get(m["id"]) or {}, st.page(m["id"])
        if m["id"] not in extracted and page.get("hash") and page["hash"] == prev.get("hash"):
            prev["checked_at"] = today.isoformat()
            prev["last_status"] = 200
            st.save_page(m["id"], prev)
        elif m["id"] not in extracted and prev:
            prev["last_status"] = page.get("status")
            st.save_page(m["id"], prev)

    results, publish = [], []
    key = benchmark.load_key()
    bench = []
    for m in museums:
        prev = st.page(m["id"])
        page = pages.get(m["id"]) or {}
        base = {"id": m["id"], "name": m["name"], "state": m["state"], "url": m.get("url")}
        if not prev.get("raw"):
            results.append({**base, "verdict": "pending" if page.get("hash") else "drop",
                            "issues": [{"level": "error", "code": "no_reading", "msg": str(page.get("status") or "not read yet")}]})
            continue
        checked = date.fromisoformat(prev["checked_at"])
        n = N.normalize(prev["raw"], m, today)
        issues = V.validate(n)
        issues += crosscheck.compare(n["weekly"], _tuples(prev.get("jsonld")), "jsonld")
        if (today - checked).days > config.CARRY_DAYS:
            issues.append({"level": "error", "code": "too_old", "msg": f"last good reading {checked}"})
        elif page.get("hash") and page["hash"] != prev.get("hash"):
            issues.append({"level": "info", "code": "changed_unread", "msg": "page changed; re-reading next run"})
        elif not page.get("hash"):
            issues.append({"level": "info", "code": "fetch_failed", "msg": f"page did not load today ({page.get('status')}); showing the reading from {checked}"})
        verdict = V.verdict(issues)
        rec = export.to_app(n, issues, verdict, prev["checked_at"]) if verdict != "drop" else None
        if rec and m["id"] in overrides:
            rec, verdict = apply_override(rec, overrides[m["id"]], prev.get("hash"), verdict)
            if rec is None:
                verdict = "drop"
        results.append({**base, "verdict": verdict, "checked_at": prev["checked_at"], "page_hash": prev.get("hash"),
                        "issues": issues})
        if rec:
            publish.append(rec)
        k = benchmark.match_key(key, m)
        if k:
            bench.append(benchmark.score(k, n, today.isoformat(), (today + timedelta(days=N.HORIZON_DAYS)).isoformat()))

    merged, manual_cities, manual_notes = merge_manual(publish, today)
    cities = {c["id"]: c for c in manual_cities}
    for r in merged:
        if r["provenance"].get("method") == "automated":
            cities.setdefault(r["city_id"], export.city_record(r))
    used = {r["city_id"] for r in merged}
    cities = [c for c in cities.values() if c["id"] in used or c["id"] in {x["id"] for x in manual_cities}]

    counts = {v: sum(r["verdict"] == v for r in results) for v in ("publish", "hold", "drop", "pending")}
    summary = {"date": today.isoformat(), "states": len(wanted_states), "museums": len(museums),
               "published": len(merged), **counts, **usage, "deferred": len(deferred)}

    # circuit breaker: a broken run must never replace a good site
    previous = _read(config.DATA_OUT, {}).get("museums") or []
    breaker = None
    if previous and len(merged) < config.BREAKER_RATIO * len(previous) and not allow_shrink:
        breaker = f"would publish {len(merged)} museums, down from {len(previous)}; site left unchanged"

    report = {"summary": summary, "breaker": breaker, "manual": manual_notes,
              "results": sorted(results, key=lambda r: (r["state"], r["name"])), "benchmark": bench}
    _write(st.root / "report.json", report)
    (st.root / "review.md").write_text(review_markdown(results, today))
    with (st.root / "history.jsonl").open("a") as f:
        f.write(json.dumps({**summary, "breaker": bool(breaker)}) + "\n")
    if not dry_run and not breaker:
        export.write_json(config.DATA_OUT, merged, cities, today.isoformat(),
                          {"states": len(wanted_states), "attribution": "Museum list: Wikidata (CC0). Hours: each museum's official website."})
    log("summary", json.dumps(summary))
    if breaker:
        log("CIRCUIT BREAKER:", breaker)
    return report


def review_markdown(results: list[dict], today: date) -> str:
    held = [r for r in results if r["verdict"] == "hold"]
    lines = [f"# Review queue — {today.isoformat()}", "",
             f"{len(held)} museums are shown as \"Usually open\" until someone checks them.",
             "To confirm one, open its page, check the hours, and add its line to `pipeline/overrides.json`.",
             "A confirmation lapses on its own when the page changes.", "",
             "| Museum | State | Why it is held | Confirm with |", "| --- | --- | --- | --- |"]
    shown = sorted(held, key=lambda r: (r["state"], r["name"]))[:200]   # an issue body holds about 65,000 characters
    for r in shown:
        why = "; ".join(i["msg"] for i in r["issues"] if i["level"] == "hold")
        confirm = f'`"{r["id"]}": {{"confirm_hash": "{r.get("page_hash")}"}}`'
        lines.append(f"| [{r['name']}]({r['url']}) | {r['state']} | {why} | {confirm} |")
    if len(held) > len(shown):
        lines += ["", f"…and {len(held) - len(shown)} more in `pipeline/state/report.json`."]
    return "\n".join(lines) + "\n"


def _tuples(w):
    return {d: (tuple(v) if isinstance(v, list) else v) for d, v in w.items()} if w else None


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="Muzeum daily data run")
    ap.add_argument("--states", nargs="*", default=["ALL"], help="postal codes, or ALL")
    ap.add_argument("--as-of", default=date.today().isoformat())
    ap.add_argument("--rediscover", action="store_true", help="re-run Wikidata discovery now")
    ap.add_argument("--allow-shrink", action="store_true", help="publish even if far fewer museums than last time")
    ap.add_argument("--dry-run", action="store_true", help="do everything except write the site data")
    a = ap.parse_args(argv)
    wanted = states.ALL if a.states in (["ALL"], ["all"]) else [s.upper() for s in a.states]
    bad = [s for s in wanted if s not in states.STATES]
    if bad:
        sys.exit(f"unknown states: {bad}")
    report = run(today=date.fromisoformat(a.as_of), wanted_states=wanted, force_discovery=a.rediscover,
                 allow_shrink=a.allow_shrink, dry_run=a.dry_run)
    return 2 if report["breaker"] else 0
