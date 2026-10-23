"""Turn holiday names and recurring phrases from museum pages into calendar dates.

Rule-based, no hard-coded years: every date is computed from the run date, so
"Thanksgiving" always means the next Thanksgiving on or after the run date.
"""
from __future__ import annotations

import re
from datetime import date, timedelta

WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
WEEKDAY_WORDS = {
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
}
MONTHS = {m: i + 1 for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july",
     "august", "september", "october", "november", "december"])}


def nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """n-th weekday (0=Mon) of a month; n=-1 means the last one."""
    if n > 0:
        d = date(year, month, 1)
        d += timedelta(days=(weekday - d.weekday()) % 7)
        return d + timedelta(weeks=n - 1)
    nxt = date(year + (month == 12), month % 12 + 1, 1)
    d = nxt - timedelta(days=1)
    return d - timedelta(days=(d.weekday() - weekday) % 7)


# name pattern -> function(year) -> date
HOLIDAYS: list[tuple[str, re.Pattern, callable]] = [
    ("Christmas Eve", re.compile(r"christmas eve|december 24|dec\.? 24"), lambda y: date(y, 12, 24)),
    ("New Year's Eve", re.compile(r"new year'?s eve|december 31|dec\.? 31"), lambda y: date(y, 12, 31)),
    ("Christmas", re.compile(r"christmas|december 25|dec\.? 25"), lambda y: date(y, 12, 25)),
    ("New Year's Day", re.compile(r"new year|january 1\b|jan\.? 1\b"), lambda y: date(y, 1, 1)),
    ("Martin Luther King Jr. Day", re.compile(r"martin luther king|\bmlk\b"), lambda y: nth_weekday(y, 1, 0, 3)),
    ("Presidents Day", re.compile(r"president'?s'? day"), lambda y: nth_weekday(y, 2, 0, 3)),
    ("Memorial Day", re.compile(r"memorial day"), lambda y: nth_weekday(y, 5, 0, -1)),
    ("Juneteenth", re.compile(r"juneteenth|june 19"), lambda y: date(y, 6, 19)),
    ("Independence Day", re.compile(r"independence day|fourth of july|4th of july|july 4"), lambda y: date(y, 7, 4)),
    ("Labor Day", re.compile(r"labor day"), lambda y: nth_weekday(y, 9, 0, 1)),
    ("Indigenous Peoples' Day", re.compile(r"indigenous peoples'? day|columbus day"), lambda y: nth_weekday(y, 10, 0, 2)),
    ("Veterans Day", re.compile(r"veterans'? day|november 11"), lambda y: date(y, 11, 11)),
    ("Day after Thanksgiving", re.compile(r"day after thanksgiving|black friday"), lambda y: nth_weekday(y, 11, 3, 4) + timedelta(days=1)),
    ("Thanksgiving", re.compile(r"thanksgiving"), lambda y: nth_weekday(y, 11, 3, 4)),
]


def resolve_holidays(text: str, as_of: date) -> list[tuple[str, date]]:
    """Every holiday named in text, each at its next occurrence on or after as_of.
    Matched words are removed as we go, so "Christmas Eve" is not also "Christmas"."""
    t = text.lower().replace("\u2019", "'")
    found = []
    for name, pat, fn in HOLIDAYS:
        m = pat.search(t)
        if m:
            d = fn(as_of.year)
            if d < as_of:
                d = fn(as_of.year + 1)
            found.append((name, d))
            t = pat.sub(" ", t)
    return found


ORDINALS = {"first": 1, "1st": 1, "second": 2, "2nd": 2, "third": 3, "3rd": 3,
            "fourth": 4, "4th": 4, "last": -1}
NTH_RE = re.compile(r"\b(first|1st|second|2nd|third|3rd|fourth|4th|last)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b"
                    r"(?:\s+(?:of|in)\s+(?:every|each|the)\s+month)?")


def resolve_nth_weekday(text: str, as_of: date, horizon_days: int) -> list[date]:
    """'First Wednesday of every month' -> every matching date in the horizon."""
    m = NTH_RE.search(text.lower())
    if not m or "month" not in text.lower():
        return []
    n, wd = ORDINALS[m.group(1)], WEEKDAY_WORDS[m.group(2)]
    end = as_of + timedelta(days=horizon_days)
    out, y, mo = [], as_of.year, as_of.month
    while date(y, mo, 1) <= end:
        d = nth_weekday(y, mo, wd, n)
        if as_of <= d <= end:
            out.append(d)
        y, mo = (y + 1, 1) if mo == 12 else (y, mo + 1)
    return out


TIME_RE = re.compile(r"\b(\d{1,2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|noon)?", re.I)


def parse_clock(text: str) -> str | None:
    """'3 pm' / '4:00 p.m.' / '8:00 pm' / '15:00' -> 'HH:MM'. Needs am/pm unless 24h."""
    for m in TIME_RE.finditer(text):
        h, mi, ap = int(m.group(1)), int(m.group(2) or 0), (m.group(3) or "").lower()
        if ap.startswith("p") and h < 12:
            h += 12
        elif ap.startswith("a") and h == 12:
            h = 0
        elif not ap and not (m.group(2) and h >= 13):
            continue  # a bare number like "4" is too ambiguous
        if 0 <= h <= 23 and 0 <= mi <= 59:
            return f"{h:02d}:{mi:02d}"
    return None


CLOSE_EARLY_RE = re.compile(r"(?:close[sd]?|until|open until|open till|till)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:a\.?\s?m\.?|p\.?\s?m\.?))", re.I)


def parse_early_close(text: str) -> str | None:
    m = CLOSE_EARLY_RE.search(text)
    return parse_clock(m.group(1)) if m else None
