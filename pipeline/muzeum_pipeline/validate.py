"""Checks that decide whether a normalized record is published, held, or dropped.

  error -> record is not published (kept in the report)
  hold  -> published, but labeled "Usually open" until a person or a second
           source confirms it (sets conflict_flag in the app record)
  info  -> published as is, listed in the report
"""
from __future__ import annotations

import re

from .holidays import WEEKDAYS


def _mins(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _h12(hhmm: str) -> set[str]:
    """Ways an hour can appear in page text: '17:00' -> {'5', '17'}."""
    h, m = (int(x) for x in hhmm.split(":"))
    forms = {str(h)}
    if h == 0:
        forms.add("12")
    elif h > 12:
        forms.add(str(h - 12))
    if h == 12:
        forms.add("noon")
    return forms


def validate(n: dict) -> list[dict]:
    issues = []

    def flag(level, code, msg):
        issues.append({"level": level, "code": code, "msg": msg})

    weekly = n["weekly"]
    open_days = {d: v for d, v in weekly.items() if isinstance(v, tuple)}
    stated = [d for d in WEEKDAYS if weekly[d] is not None and d not in n["inferred_closed"]]

    if not n.get("is_visit_page", True):
        flag("error", "not_visit_page", "the page is not about visiting this museum")
    if len(stated) < 3:
        flag("error", "too_few_days", f"only {len(stated)} weekdays stated")
    if not open_days:
        flag("error", "never_open", "no open day in the week")

    for d, (o, c) in open_days.items():
        if _mins(o) >= _mins(c):
            flag("error", "order", f"{d} opens {o} after it closes {c}")
            continue
        span = (_mins(c) - _mins(o)) / 60
        if not 2 <= span <= 14:
            flag("error", "span", f"{d} open {span:.1f} h")
        if _mins(o) < 9 * 60:
            flag("hold", "early_open", f"{d} opens {o}: may be building, not gallery, hours")
        if _mins(c) > 22 * 60:
            flag("hold", "late_close", f"{d} closes {c}")

    if n["inferred_closed"]:
        flag("info", "inferred_closed", "page does not mention " + ", ".join(n["inferred_closed"]) + "; treated as closed")

    # Evidence: the hours the model returned should appear in the quote it gave.
    quote = n["hours_quote"].lower()
    nums = set(re.findall(r"\d{1,2}", quote)) | ({"noon"} & set(quote.split()))
    needed = {t for v in open_days.values() for t in v}
    found = [t for t in needed if _h12(t) & nums]
    if not re.search(r"\d", quote):
        flag("hold", "no_quote_evidence", "hours quote has no times in it")
    elif needed and len(found) / len(needed) < 0.5:
        flag("hold", "weak_quote_evidence", f"only {len(found)} of {len(needed)} times appear in the quote")
    elif "today" in quote and len(found) < len(needed):
        flag("info", "today_only_quote", "quote shows only today's hours")

    a = n["admission"]
    if a is None:
        flag("info", "no_admission", "admission not on this page")
    else:
        for t in a["tiers"]:
            if not 0 <= t["amount"] <= 100:
                flag("error", "price_range", f"{t['label']} {t['amount']}")

    for w in n["warnings"]:
        flag("info", "normalize", w)
    for u in n["unresolved"]:
        flag("info", "unresolved_" + u["why"].replace(" ", "_"), u["text"][:100])
    dropped = n["exhibitions_dropped"]
    if dropped["undated"]:
        flag("info", "undated_exhibitions", f"{dropped['undated']} exhibition(s) without an end date not shown")
    if dropped["ended"]:
        flag("info", "ended_exhibitions", f"{dropped['ended']} ended exhibition(s) still on the page")
    return issues


def verdict(issues: list[dict]) -> str:
    levels = {i["level"] for i in issues}
    return "drop" if "error" in levels else "hold" if "hold" in levels else "publish"
