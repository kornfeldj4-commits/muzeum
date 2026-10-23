"""Compare two independent readings of the same week and report disagreements.

Sources can be: the model's reading of the visit page, the page's own JSON-LD,
and an optional third party listing (Google Places / OSM opening_hours). When
two sources disagree, the record is held ("Usually open") and the official page
wins, which is the same rule used by hand in the prototype data.
"""
from __future__ import annotations

from .holidays import WEEKDAYS


def compare(primary: dict, other: dict | None, other_name: str) -> list[dict]:
    if not other:
        return []
    issues = []
    for d in WEEKDAYS:
        a, b = primary.get(d), other.get(d)
        if a is None or b is None or a == b:
            continue
        issues.append({"level": "hold", "code": f"crosscheck_{other_name}",
                       "msg": f"{d}: official page {_fmt(a)}, {other_name} {_fmt(b)}"})
    return issues


def _fmt(v) -> str:
    return "closed" if v == "closed" else f"{v[0]}–{v[1]}"
