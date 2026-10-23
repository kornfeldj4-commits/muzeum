"""Read schema.org opening hours from a page's JSON-LD, when the museum publishes it.

This is the cheap, structured path: no model call. Many sites have none, and
some publish stale values, so it is used as a second source to cross-check the
model's reading rather than as the only source.
"""
from __future__ import annotations

import json
import re

DAY_URI = {"monday": "MON", "tuesday": "TUE", "wednesday": "WED", "thursday": "THU",
           "friday": "FRI", "saturday": "SAT", "sunday": "SUN"}
SHORT = {"mo": "MON", "tu": "TUE", "we": "WED", "th": "THU", "fr": "FRI", "sa": "SAT", "su": "SUN"}
ORDER = list(SHORT.values())
SCRIPT_RE = re.compile(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', re.S | re.I)


def _nodes(obj):
    if isinstance(obj, list):
        for x in obj:
            yield from _nodes(x)
    elif isinstance(obj, dict):
        yield obj
        for k in ("@graph", "mainEntity", "location"):
            if k in obj:
                yield from _nodes(obj[k])


def _day_key(v: str) -> str | None:
    v = v.rsplit("/", 1)[-1].lower()
    return DAY_URI.get(v)


def _expand_short(spec: str) -> dict:
    """'Tu-Su 10:00-17:00' / 'Mo,We 11:00-17:00' -> {DAY: (open, close)}."""
    out = {}
    m = re.match(r"\s*([A-Za-z,\- ]+)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})", spec)
    if not m:
        return out
    days, o, c = m.groups()
    for part in days.replace(" ", "").split(","):
        if "-" in part:
            a, b = (SHORT.get(x.lower()[:2]) for x in part.split("-"))
            if a and b:
                i, j = ORDER.index(a), ORDER.index(b)
                rng = ORDER[i:j + 1] if i <= j else ORDER[i:] + ORDER[:j + 1]
                out.update({d: (o.zfill(5), c.zfill(5)) for d in rng})
        elif SHORT.get(part.lower()[:2]):
            out[SHORT[part.lower()[:2]]] = (o.zfill(5), c.zfill(5))
    return out


def opening_hours(html: str) -> dict | None:
    """-> {DAY: (open, close) | 'closed'} or None when the page has no hours data."""
    found: dict = {}
    for block in SCRIPT_RE.findall(html):
        try:
            data = json.loads(block.strip())
        except json.JSONDecodeError:
            continue
        for node in _nodes(data):
            for spec in node.get("openingHoursSpecification", []) or []:
                if not isinstance(spec, dict) or spec.get("validThrough") or spec.get("validFrom"):
                    continue  # dated specs are exceptions, not the regular week
                days = spec.get("dayOfWeek")
                days = days if isinstance(days, list) else [days]
                o, c = spec.get("opens"), spec.get("closes")
                for d in days:
                    k = _day_key(str(d or ""))
                    if not k:
                        continue
                    if o and c and o[:5] != c[:5]:
                        found[k] = (o[:5].zfill(5), c[:5].zfill(5))
                    else:
                        found[k] = "closed"
            oh = node.get("openingHours")
            for s in ([oh] if isinstance(oh, str) else oh or []):
                found.update(_expand_short(s))
    if not found:
        return None
    return {d: found.get(d, "closed") for d in ORDER}
