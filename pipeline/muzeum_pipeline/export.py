"""Turn normalized records into the app's data schema (Pass 3B) and write the
JSON file the site loads."""
from __future__ import annotations

import json
import re
from pathlib import Path

from . import states
from .holidays import WEEKDAYS

DAY_PLURAL = {"MON": "Mondays", "TUE": "Tuesdays", "WED": "Wednesdays", "THU": "Thursdays",
              "FRI": "Fridays", "SAT": "Saturdays", "SUN": "Sundays"}
SCHEMA_VERSION = 1


def city_id(city: str, state: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", city.lower()).strip("-") + "-" + state.lower()


def short_street(s: str | None) -> str | None:
    if not s:
        return None
    s = s.split(",")[0].strip()
    for long, short in (("Avenue", "Ave"), ("Street", "St"), ("Boulevard", "Blvd"), ("Drive", "Dr"),
                        ("Road", "Rd"), ("Parkway", "Pkwy")):
        s = re.sub(rf"\b{long}\b", short, s)
    return s


def resolve_city(n: dict, reg: dict) -> str:
    """The page's own address wins when it is in the same state; Wikidata's
    'located in' can be a county or a neighborhood."""
    page_city, page_state = n.get("address_city"), states.code_for(n.get("address_state"))
    if page_city and (page_state in (None, reg["state"])):
        return page_city.title() if page_city.isupper() else page_city
    return reg.get("city") or "Unknown"


def to_app(n: dict, issues: list[dict], verdict: str, verified_at: str) -> dict:
    reg = n["registry"]
    city = resolve_city(n, reg)
    weekly = []
    for d in WEEKDAYS:
        v = n["weekly"][d]
        if v is None:
            continue  # the app shows "Not listed"
        weekly.append({"day": d, "open": None, "close": None, "closed": True} if v == "closed"
                      else {"day": d, "open": v[0], "close": v[1], "closed": False})
    holds = [i["msg"] for i in issues if i["level"] == "hold"]
    notes = []
    if n["inferred_closed"]:
        notes.append("The official page does not list " + ", ".join(DAY_PLURAL[d] for d in n["inferred_closed"]) + ".")
    if any("holiday list labeled" in w for w in n["warnings"]):
        notes.append("Holiday closures are from last year's list on the official page.")
    return {
        "id": n["id"],
        "city_id": city_id(city, reg["state"]),
        "name": {"display": reg["name"], "original": reg["name"], "alternates": reg.get("alternates") or []},
        "location": {"street": short_street(n.get("street")), "city": city, "region": reg["state"],
                     "country_code": "US", "time_zone": reg["tz"]},
        "official_url": reg.get("home") or reg["url"],
        "admission": n["admission"],
        "hours": {"weekly": weekly, "exceptions": n["exceptions"],
                  "temporary_closure": n["temporary_closure"], "note": " ".join(notes) or None},
        "partial_closure_note": n["partial_closure_note"],
        "exhibitions": n["exhibitions"],
        "exhibitions_note": "Exhibitions listed without dates; not shown." if n["exhibitions_dropped"]["undated"] and not n["exhibitions"] else None,
        "access": {"step_free_entry": "unknown", "source_url": None},
        "provenance": {
            "source_url": reg["url"], "verified_at": verified_at, "method": "automated",
            "conflict_flag": verdict == "hold",
            "conflict_note": ("Automated reading not yet confirmed: " + "; ".join(holds)) if holds else None,
            "stale_reason": n["stale_reason"],
            "wikidata": reg.get("wikidata"),
        },
    }


def city_record(rec: dict) -> dict:
    loc = rec["location"]
    country = "United States" if loc["country_code"] == "US" else loc.get("country", loc["country_code"])
    region = states.name(loc["region"]) if loc["country_code"] == "US" else loc["region"]
    return {"id": rec["city_id"], "name": loc["city"], "region": region, "country": country, "time_zone": loc["time_zone"]}


def write_json(path: Path, museums: list[dict], cities: list[dict], generated: str, extra: dict | None = None):
    path.parent.mkdir(parents=True, exist_ok=True)
    body = {"schema": SCHEMA_VERSION, "generated": generated, **(extra or {}),
            "cities": sorted(cities, key=lambda c: c["id"]),
            "museums": sorted(museums, key=lambda m: m["id"])}
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(body, ensure_ascii=False, separators=(",", ":")))
    tmp.replace(path)   # never leave a half-written file for the site to load
