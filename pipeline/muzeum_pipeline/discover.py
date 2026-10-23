"""Find art museums in each US state from Wikidata (open data, CC0).

One query per state. Large states can time out on the full query, so a
simpler query is tried next, and if both fail the state keeps last week's list."""
from __future__ import annotations

import re
import time

import requests

from . import states
from .fetch import USER_AGENT

SPARQL = "https://query.wikidata.org/sparql"

# Art museums (Q207694) and subclasses anywhere inside the state, with an official website.
FULL = """
SELECT DISTINCT ?m ?mLabel ?site ?cityLabel ?coord ?alt WHERE {
  ?state wdt:P300 "%(iso)s" .
  ?m wdt:P31/wdt:P279* wd:Q207694 ; wdt:P131+ ?state ; wdt:P856 ?site .
  OPTIONAL { ?m wdt:P131 ?city . }
  OPTIONAL { ?m wdt:P625 ?coord . }
  OPTIONAL { ?m skos:altLabel ?alt . FILTER(LANG(?alt) = "en") }
  FILTER NOT EXISTS { ?m wdt:P576 ?dissolved . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}"""

# Fallback: only items typed directly as art museum.
SIMPLE = """
SELECT DISTINCT ?m ?mLabel ?site ?cityLabel ?coord ?alt WHERE {
  ?state wdt:P300 "%(iso)s" .
  ?m wdt:P31 wd:Q207694 ; wdt:P131+ ?state ; wdt:P856 ?site .
  OPTIONAL { ?m wdt:P131 ?city . }
  OPTIONAL { ?m wdt:P625 ?coord . }
  OPTIONAL { ?m skos:altLabel ?alt . FILTER(LANG(?alt) = "en") }
  FILTER NOT EXISTS { ?m wdt:P576 ?dissolved . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}"""


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")[:60]


def domain(url: str | None) -> str:
    if not url:
        return ""
    return re.sub(r"^https?://(www\.)?", "", url.lower()).split("/")[0]


def _query(q: str, iso: str, session=None) -> list[dict]:
    s = session or requests
    r = s.get(SPARQL, params={"query": q % {"iso": iso}, "format": "json"},
              headers={"User-Agent": USER_AGENT, "Accept": "application/sparql-results+json"}, timeout=90)
    r.raise_for_status()
    return r.json()["results"]["bindings"]


def discover_state(code: str, session=None) -> list[dict] | None:
    """-> museums for one state, or None when Wikidata could not answer."""
    iso = f"US-{code}"
    rows = None
    for q in (FULL, SIMPLE):
        for attempt in range(2):
            try:
                rows = _query(q, iso, session)
                break
            except (requests.RequestException, ValueError, KeyError):
                time.sleep(5 * (attempt + 1))
        if rows is not None:
            break
    if rows is None:
        return None
    by_qid: dict[str, dict] = {}
    for b in rows:
        qid = b["m"]["value"].rsplit("/", 1)[-1]
        name = b.get("mLabel", {}).get("value", "")
        if not name or re.fullmatch(r"Q\d+", name):
            continue
        site = b["site"]["value"]
        alt = b.get("alt", {}).get("value")
        m = by_qid.get(qid)
        if m:   # several websites, cities or aliases: keep the shortest site, first city, every short alias
            if len(site) < len(m["home"]):
                m["home"] = site
            if alt and len(alt) <= 40 and alt not in m["alternates"] and len(m["alternates"]) < 6:
                m["alternates"].append(alt)
            continue
        coord = b.get("coord", {}).get("value")
        by_qid[qid] = {
            "wikidata": qid, "name": name, "state": code,
            "city": b.get("cityLabel", {}).get("value"),
            "coord": coord, "tz": states.tz_for(coord, code),
            "home": site, "url": None, "alternates": [alt] if alt and len(alt) <= 40 else [],
        }
    return list(by_qid.values())


def assign_ids(museums: list[dict], previous: dict[str, dict]) -> list[dict]:
    """Stable ids: a museum keeps the id it had last time (matched by Wikidata id)."""
    by_qid = {m.get("wikidata"): mid for mid, m in previous.items() if m.get("wikidata")}
    used = set(previous)
    for m in museums:
        mid = by_qid.get(m["wikidata"])
        if not mid:
            mid = "mus_" + slug(m["name"])
            if mid in used:
                mid = f"{mid}_{m['wikidata'].lower()}"
        m["id"] = mid
        used.add(mid)
        old = previous.get(mid, {})
        m["url"] = old.get("url")            # visit page found earlier
        m["alternates"] = m["alternates"] or old.get("alternates") or []
    return museums
