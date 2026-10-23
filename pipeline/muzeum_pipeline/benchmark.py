"""Score the automated reading against the hand-checked answer key, field by field."""
from __future__ import annotations

from .holidays import WEEKDAYS


def _key_weekly(rec):
    out = {d: None for d in WEEKDAYS}
    for w in rec["hours"]["weekly"]:
        out[w["day"]] = "closed" if w["closed"] else (w["open"], w["close"])
    return out


def _featured(exs, as_of):
    live = sorted((e for e in exs if (not e.get("start") or e["start"] <= as_of) and e.get("end") and e["end"] >= as_of),
                  key=lambda e: e["end"])
    return live[0]["title"] if live else None


def _primary(adm):
    if not adm or not adm.get("tiers"):
        return None
    if all(t.get("is_free") for t in adm["tiers"]):
        return 0
    p = next((t for t in adm["tiers"] if t.get("primary")), None)
    return p["amount"] if p else None


def _free_label(adm):
    return next((t["free_label"] for t in (adm or {}).get("tiers", []) if t.get("free_label")), None)


def score(key: dict, n: dict, as_of: str, horizon_end: str) -> dict:
    rows = []

    def row(field, expected, got, ok=None, note=""):
        rows.append({"field": field, "expected": expected, "got": got,
                     "ok": (expected == got) if ok is None else ok, "note": note})

    kw = _key_weekly(key)
    for d in WEEKDAYS:
        got = n["weekly"][d]
        note = "inferred: page does not list this day" if d in n["inferred_closed"] else ""
        row(f"hours {d}", kw[d], got, note=note)

    kex = {e["date"]: e for e in key["hours"]["exceptions"] if as_of <= e["date"] <= horizon_end}
    nex = {e["date"]: e for e in n["exceptions"]}
    for dt, e in sorted(kex.items()):
        g = nex.get(dt)
        exp = "closed" if e["closed"] else f"{e['open']}-{e['close']}"
        got = None if not g else "closed" if g["closed"] else f"{g['open']}-{g['close']}"
        row(f"exception {dt}", exp, got)
    extra = sorted(set(nex) - set(kex))

    row("adult price", _primary(key["admission"]), _primary(n["admission"]))
    row("free label", _free_label(key["admission"]), _free_label(n["admission"]))
    row("day notes", sorted(x["day"] for x in key["admission"].get("day_notes", [])),
        sorted(x["day"] for x in (n["admission"] or {}).get("day_notes", [])))
    row("featured exhibition", _featured(key["exhibitions"], as_of), _featured(n["exhibitions"], as_of))
    row("stale verdict", bool(key["provenance"].get("stale_reason")), bool(n["stale_reason"]))
    row("partial closure", bool(key.get("partial_closure_note")), bool(n["partial_closure_note"]))
    return {"id": key["id"], "rows": rows, "extra_exceptions": extra}


def load_key(path=None) -> list[dict]:
    import json
    from pathlib import Path
    p = Path(path) if path else Path(__file__).resolve().parent.parent / "benchmark" / "answer_key.json"
    try:
        return json.loads(p.read_text())
    except FileNotFoundError:
        return []


def match_key(key: list[dict], museum: dict) -> dict | None:
    """The answer-key record for a discovered museum: same website domain and a shared name word."""
    import re
    from .discover import domain

    def words(*names):
        return {w for n in names if n for w in re.findall(r"[a-z]{3,}", n.lower())} - {"the", "and", "art", "museum", "arts"}
    d = domain(museum.get("home") or museum.get("url"))
    for k in key:
        if domain(k["official_url"]) == d and words(museum["name"]) & words(k["name"]["display"], k["name"]["original"], *k["name"].get("alternates", [])):
            return k
    return None
