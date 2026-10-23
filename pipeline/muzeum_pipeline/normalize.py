"""Turn one raw extraction (the LLM's JSON) into a normalized record.

Every rule here is generic: nothing refers to a specific museum. What cannot be
turned into a dated, displayable fact is kept in `unresolved` for the report
instead of being guessed.
"""
from __future__ import annotations

import re
from datetime import date, timedelta

from .holidays import (WEEKDAYS, WEEKDAY_WORDS, parse_early_close, resolve_holidays,
                       resolve_nth_weekday)

HORIZON_DAYS = 120          # how far ahead exceptions are expanded
ISO = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
RANGE_HH = re.compile(r"^(\d{2}):(\d{2})-(\d{2}):(\d{2})$")
MEMBER_RE = re.compile(r"\bmember", re.I)
QUALIFIER_RE = re.compile(r"resident|county|member|ebt|snap|link card|museums for all|tribal|military|teacher|valid id|id required|with id", re.I)
CHILD_RE = re.compile(r"child|kid|youth|teen|under\s*\d+|\d+\s*(?:and|&)\s*(?:under|younger)|ages?\s*\d", re.I)
ADULT_RE = re.compile(r"\badult|general", re.I)
UNNAMED_TIER_RE = re.compile(r"not stated|unnamed|tier \d+ of \d+", re.I)
VENUE_RE = re.compile(r"house|garden|park|library|caf[eé]|shop|store|restaurant|theater|theatre|cinema", re.I)


def iso(d: date) -> str:
    return d.isoformat()


# ---------------------------------------------------------------- hours
def parse_weekly(raw_weekly: dict | None):
    """-> ({DAY: (open, close) | 'closed' | None}, [inferred-closed days])."""
    out = {}
    for d in WEEKDAYS:
        v = (raw_weekly or {}).get(d)
        if isinstance(v, str) and v.strip().lower() == "closed":
            out[d] = "closed"
        elif isinstance(v, str) and RANGE_HH.match(v.strip()):
            o, c = v.strip().split("-")
            out[d] = (o, c)
        else:
            out[d] = None
    stated = [d for d in WEEKDAYS if out[d] is not None]
    inferred = []
    # Museums list the days they are open; a day the page leaves out is closed.
    # Only applied when most of the week is stated, and always recorded.
    if len(stated) >= 4:
        for d in WEEKDAYS:
            if out[d] is None:
                out[d] = "closed"
                inferred.append(d)
    return out, inferred


MONTH_NAMES = "january|february|march|april|may|june|july|august|september|october|november|december"
TEXT_DATE = re.compile(rf"\b({MONTH_NAMES})\.?\s+(\d{{1,2}})(?:\s*[–-]\s*(\d{{1,2}})(?!\d))?(?:,?\s+(\d{{4}}))?", re.I)


def _iso_dates(text: str) -> list[date]:
    """ISO dates, plus written dates that carry a year ("November 23–26, 2023").
    A year applies to the written dates before it that have none."""
    text = text or ""
    out = [date(int(y), int(m), int(d)) for y, m, d in ISO.findall(text)]
    pending = []
    for m in TEXT_DATE.finditer(text):
        mo = ["january", "february", "march", "april", "may", "june", "july", "august",
              "september", "october", "november", "december"].index(m.group(1).lower()) + 1
        days = [int(m.group(2))] + ([int(m.group(3))] if m.group(3) else [])
        pending += [(mo, d) for d in days]
        if m.group(4):
            y = int(m.group(4))
            for mo_, d_ in pending:
                try:
                    out.append(date(y, mo_, d_))
                except ValueError:
                    pass
            pending = []
    return out


def expand_exceptions(raw_ex: list, weekly: dict, as_of: date):
    """-> (dated exceptions, temporary_closure, past closures, recurring notes, unresolved)."""
    horizon = as_of + timedelta(days=HORIZON_DAYS)
    dated: dict[str, dict] = {}
    closure = None
    past, recurring, unresolved, partials = [], [], [], []

    def add(d: date, entry: dict) -> bool:
        if as_of <= d <= horizon and iso(d) not in dated:
            dated[iso(d)] = {"date": iso(d), **entry}
        return True

    def special_hours(d: date, hours, text, note_label) -> bool:
        """Apply changed hours for one date. An entry that starts later than the
        usual opening is an event window (free evening, members' hour), not hours."""
        base = weekly.get(WEEKDAYS[d.weekday()])
        if hours and RANGE_HH.match(hours):
            o, c = hours.split("-")
            if isinstance(base, tuple) and o > base[0]:
                return False
            return add(d, {"closed": False, "open": o, "close": c, "note": note_label})
        close = parse_early_close(text)
        if isinstance(base, tuple) and close:
            return add(d, {"closed": False, "open": base[0], "close": close, "note": note_label})
        return False

    for ex in raw_ex or []:
        label = str(ex.get("date") or "")
        note = str(ex.get("note") or "")
        text = f"{label} {note}".strip()
        closed = bool(ex.get("closed"))
        hours = ex.get("hours")

        # 0. part of the building closed, museum still open
        if not closed and not parse_early_close(text) and re.search(
                r"galler(?:y|ies)[^.]*\b(?:temporarily clos|clos(?:ed|ure) for|changeover|renovat|improvement|installation)", text, re.I):
            partials.append(note or label)
            continue

        # 1. "first Wednesday of every month"
        nth = resolve_nth_weekday(text, as_of, HORIZON_DAYS)
        if nth:
            used = False
            for d in nth:
                used |= add(d, {"closed": True, "note": _short(note or label)}) if closed \
                    else special_hours(d, hours, text, _short(note or label))
            if not used:
                recurring.append(_short(text))
            continue

        # 2. explicit ISO date or range
        isos = _iso_dates(label)
        if isos:
            if not closed and not (hours and RANGE_HH.match(hours)):
                recurring.append(note or label)   # "beginning <date>, some galleries close"
                continue
            if len(isos) >= 2 and closed:
                start, end = min(isos), max(isos)
                if end < as_of:
                    past.append(f"{iso(start)} to {iso(end)}")
                elif start <= horizon:
                    closure = {"from": iso(start), "until": iso(end), "reason": note or None}
                continue
            d = isos[0]
            if d < as_of:
                if closed:
                    past.append(iso(d))
                continue
            if closed:
                add(d, {"closed": True, "note": note or label})
            elif not special_hours(d, hours, text, note or None):
                recurring.append(_short(text))
            continue

        # 3. venue-specific lines (a house, garden, cafe...) are not gallery hours
        if VENUE_RE.search(label) and not re.search(r"galler|museum", label, re.I):
            unresolved.append({"why": "other venue", "text": text})
            continue

        # 4. named holidays (one line may name several)
        hols = [] if _is_recurring_weekday(label) else (resolve_holidays(label, as_of) or resolve_holidays(note, as_of))
        if hols:
            for name, d in hols:
                if closed:
                    add(d, {"closed": True, "note": name})
                elif not special_hours(d, hours, text, f"{name} hours"):
                    if weekly.get(WEEKDAYS[d.weekday()]) != "closed":
                        unresolved.append({"why": "holiday hours not stated", "text": f"{name}: {text}"})
            continue

        # 5. member hours, weekly specials, undated notes
        if _is_recurring_weekday(label) or MEMBER_RE.search(text):
            recurring.append(_short(text))
        else:
            unresolved.append({"why": "no date", "text": text})

    return sorted(dated.values(), key=lambda e: e["date"]), closure, past, recurring, unresolved, partials


def _is_recurring_weekday(label: str) -> bool:
    l = label.lower()
    return any(re.search(rf"\b{w}s\b|\bevery {w}|\beach {w}|daily", l) for w in WEEKDAY_WORDS) or "daily" in l


def _short(s: str, n: int = 90) -> str:
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


# ---------------------------------------------------------------- admission
def free_label(label: str) -> str | None:
    m = re.search(r"under\s*(\d+)", label, re.I)
    if m:
        return f"Under {m.group(1)} free"
    m = re.search(r"(\d+)\s*(?:and|&)\s*(?:under|younger)", label, re.I)
    if m:
        return f"{m.group(1)} and under free"
    return None


def normalize_admission(raw_adm, timed_raw, as_of: date):
    notes, day_notes, flags = [], [], []
    tiers = []
    if raw_adm is None:
        return None, flags
    seen_unnamed = False
    for t in raw_adm:
        label = re.sub(r"\s+", " ", str(t.get("label") or "")).strip()
        amount = t.get("amount")
        is_free = bool(t.get("free")) or amount == 0
        if MEMBER_RE.search(label) and is_free and not re.search(r"resident|county", label, re.I):
            continue  # members get in free everywhere; not useful on a card
        day = next((k for k, v in WEEKDAY_WORDS.items() if re.search(rf"\b{k}s?\b", label, re.I)), None)
        if day and is_free:
            txt = re.sub(rf",?\s*\b{day}s?\b", "", label, flags=re.I)
            txt = re.sub(r"\s+(on|every|each)\s*$", "", txt, flags=re.I)
            txt = re.sub(r"(\d)\s*-\s*(\d)", "\\1–\\2", txt)
            day_notes.append({"day": WEEKDAYS[WEEKDAY_WORDS[day]], "text": "Free: " + _short(txt)})
            continue
        if amount is None:
            notes.append(f"{label}: price not listed")
            continue
        label = re.sub(r"\s*\((?:[^)]*;\s*)?all tiers;?\s*([^)]*)\)", r" (\1)", label).replace(" ()", "")
        if UNNAMED_TIER_RE.search(label):
            if seen_unnamed and not is_free:
                flags.append("admission tiers without names; extra tiers dropped")
                continue
            seen_unnamed = True
            label = re.sub(r"\s*\(.*?(not stated|tier \d+ of \d+).*?\)", "", label, flags=re.I).strip()
        if not is_free and ("exhibition" in label.lower() or "additional" in label.lower()):
            notes.append(f"{label}: +${amount:g}" if amount else label)
            continue
        tier = {"label": label, "amount": float(amount) if amount % 1 else int(amount)}
        if is_free:
            tier["amount"] = 0
            tier["is_free"] = True
            fl = free_label(label)
            if fl and CHILD_RE.search(label):
                tier["free_label"] = fl
        if QUALIFIER_RE.search(label) and not re.search(r"\bnon[- ][\w-]*\s*resident", label, re.I):
            tier["qualified"] = True
        tiers.append(tier)

    general = [t for t in tiers if not t.get("qualified")]
    if not general:
        # Only qualified tiers (residents, members...): never say "Free admission".
        if tiers:
            notes.insert(0, "General price not listed. " + "; ".join(
                t["label"] if "free" in t["label"].lower() else
                ("Free" if t.get("is_free") else f"${t['amount']:g}") + f": {t['label']}" for t in tiers))
            flags.append("only eligibility-limited prices listed")
        tiers = []
    else:
        paid = [t for t in tiers if not t.get("is_free")]
        primary = next((t for t in paid if ADULT_RE.search(t["label"]) and not t.get("qualified")), None) \
            or next((t for t in paid if not t.get("qualified")), None)
        if primary:
            primary["primary"] = True
        elif all(t.get("is_free") for t in general):
            general[0]["primary"] = True
            if len(general) == 1 and re.search(r"general|museum admission|everyone|collection", general[0]["label"], re.I):
                general[0]["label"] = "Everyone"

    timed = None
    if timed_raw == "required":
        timed = {"required_from": iso(as_of), "required_until": iso(as_of + timedelta(days=365)), "otherwise": None}
    elif timed_raw == "recommended":
        timed = {"required_from": "9999-12-31", "required_until": "9999-12-31", "otherwise": "recommended"}

    for t in tiers:
        t.pop("qualified", None)
    return {"currency": "USD", "tiers": tiers, "notes": notes, "timed_entry": timed, "day_notes": day_notes}, flags


# ---------------------------------------------------------------- exhibitions
def normalize_exhibitions(raw_ex, as_of: date):
    kept, dropped = [], {"ended": 0, "undated": 0}
    for e in raw_ex or []:
        end = e.get("end")
        if not end or not ISO.match(end):
            dropped["undated"] += 1
            continue
        if end < iso(as_of):
            dropped["ended"] += 1
            continue
        kept.append({"title": e["title"].strip(), "start": e.get("start"), "end": end})
    return kept, dropped


# ---------------------------------------------------------------- staleness
YEAR_RE = re.compile(r"\b(20\d{2})\b")


def staleness(signals: str | None, past_ranges: list, raw_ex: list, as_of: date):
    """Stale only on dated content, never on a copyright year alone."""
    s = signals or ""
    copyright_only = bool(s) and not re.search(r"modified|updated|build|season|spring|summer|fall|autumn|winter|\d{4}-\d{2}", s, re.I)
    fresh = re.search(rf"{as_of.year}-\d{{2}}-\d{{2}}|(modified|updated|build).*{as_of.year}", s, re.I)
    seasons = re.findall(r"(spring|summer|fall|autumn|winter)\s+(20\d{2})", s, re.I)
    reasons = []
    if fresh:
        return None, []
    if seasons:
        y = max(int(y) for _, y in seasons)
        if y < as_of.year:
            reasons.append(f"The official page is dated {seasons[-1][0].title()} {y}.")
    labeled_years = [int(y) for e in raw_ex or [] for y in YEAR_RE.findall(str(e.get("note") or "")) if "schedule" in str(e.get("note")).lower()]
    future_dated = any(d >= as_of for e in raw_ex or [] for d in _iso_dates(str(e.get("date") or "")))
    if past_ranges and not future_dated and not reasons:
        yrs = sorted({int(y) for r in past_ranges for y in YEAR_RE.findall(r)})
        if yrs and max(yrs) < as_of.year:
            reasons.append(f"The official page only lists closures from {yrs[0]}–{yrs[-1]}." if len(yrs) > 1 else f"The official page only lists closures from {yrs[0]}.")
    warnings = []
    if copyright_only:
        yrs = [int(y) for y in YEAR_RE.findall(s)]
        if yrs and as_of.year - max(yrs) >= 2:
            warnings.append(f"copyright year {max(yrs)} only (weak signal, not marked stale)")
    if labeled_years and max(labeled_years) < as_of.year:
        warnings.append(f"holiday list labeled {max(labeled_years)}; dates applied to the coming year")
    return (reasons[0] if reasons else None), warnings


# ---------------------------------------------------------------- record
def normalize(raw: dict, reg: dict, as_of: date) -> dict:
    weekly, inferred = parse_weekly(raw.get("weekly_hours"))
    dated, closure, past, recurring, unresolved, partials = expand_exceptions(raw.get("exceptions"), weekly, as_of)
    admission, adm_flags = normalize_admission(raw.get("admission"), raw.get("timed_entry"), as_of)
    exhibitions, ex_dropped = normalize_exhibitions(raw.get("exhibitions"), as_of)
    stale_reason, stale_warn = staleness(raw.get("page_date_signals"), past, raw.get("exceptions"), as_of)
    partial = partials[0] if partials else None
    return {
        "id": reg["id"],
        "registry": reg,
        "weekly": weekly,
        "inferred_closed": inferred,
        "exceptions": dated,
        "temporary_closure": closure,
        "partial_closure_note": _partial(partial) if partial else None,
        "recurring_notes": recurring,
        "admission": admission,
        "exhibitions": exhibitions,
        "exhibitions_dropped": ex_dropped,
        "stale_reason": stale_reason,
        "warnings": list(dict.fromkeys(stale_warn + adm_flags)),
        "unresolved": unresolved,
        "past_dates": past,
        "hours_quote": raw.get("hours_quote") or "",
        "street": _addr(raw).get("street"),
        "address_city": _addr(raw).get("city"),
        "address_state": _addr(raw).get("state"),
        "is_visit_page": raw.get("is_museum_visit_page", True) is not False,
        "page_date_signals": raw.get("page_date_signals"),
    }


def _partial(note: str) -> str:
    m = re.search(r"(select |some )?([\w\- ]*?galler(?:y|ies))[^.]*?(temporarily )?clos", note, re.I)
    if m:
        where = m.group(2).strip()
        where = re.sub(r"^(the|select|some)\s+", "", where, flags=re.I)
        if "changeover" in note.lower():
            return f"{where[0].upper() + where[1:]} closed for changeover"
        return f"Some {where} temporarily closed" if not where.lower().startswith("some") else f"{where} temporarily closed"
    return _short(note, 60)


def _addr(raw: dict) -> dict:
    a = raw.get("address")
    if isinstance(a, dict):
        return {k: (v.strip() if isinstance(v, str) and v.strip() else None) for k, v in a.items()}
    return {"street": raw.get("street_address")}
