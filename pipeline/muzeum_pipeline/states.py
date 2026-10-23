"""US states (and DC): postal code -> name and main time zone.

The main zone is only a fallback. A museum's own coordinates decide its zone
when they are known, which handles states split between zones."""

STATES = {
    "AL": ("Alabama", "America/Chicago"), "AK": ("Alaska", "America/Anchorage"),
    "AZ": ("Arizona", "America/Phoenix"), "AR": ("Arkansas", "America/Chicago"),
    "CA": ("California", "America/Los_Angeles"), "CO": ("Colorado", "America/Denver"),
    "CT": ("Connecticut", "America/New_York"), "DE": ("Delaware", "America/New_York"),
    "DC": ("District of Columbia", "America/New_York"), "FL": ("Florida", "America/New_York"),
    "GA": ("Georgia", "America/New_York"), "HI": ("Hawaii", "Pacific/Honolulu"),
    "ID": ("Idaho", "America/Boise"), "IL": ("Illinois", "America/Chicago"),
    "IN": ("Indiana", "America/Indiana/Indianapolis"), "IA": ("Iowa", "America/Chicago"),
    "KS": ("Kansas", "America/Chicago"), "KY": ("Kentucky", "America/New_York"),
    "LA": ("Louisiana", "America/Chicago"), "ME": ("Maine", "America/New_York"),
    "MD": ("Maryland", "America/New_York"), "MA": ("Massachusetts", "America/New_York"),
    "MI": ("Michigan", "America/Detroit"), "MN": ("Minnesota", "America/Chicago"),
    "MS": ("Mississippi", "America/Chicago"), "MO": ("Missouri", "America/Chicago"),
    "MT": ("Montana", "America/Denver"), "NE": ("Nebraska", "America/Chicago"),
    "NV": ("Nevada", "America/Los_Angeles"), "NH": ("New Hampshire", "America/New_York"),
    "NJ": ("New Jersey", "America/New_York"), "NM": ("New Mexico", "America/Denver"),
    "NY": ("New York", "America/New_York"), "NC": ("North Carolina", "America/New_York"),
    "ND": ("North Dakota", "America/Chicago"), "OH": ("Ohio", "America/New_York"),
    "OK": ("Oklahoma", "America/Chicago"), "OR": ("Oregon", "America/Los_Angeles"),
    "PA": ("Pennsylvania", "America/New_York"), "RI": ("Rhode Island", "America/New_York"),
    "SC": ("South Carolina", "America/New_York"), "SD": ("South Dakota", "America/Chicago"),
    "TN": ("Tennessee", "America/Chicago"), "TX": ("Texas", "America/Chicago"),
    "UT": ("Utah", "America/Denver"), "VT": ("Vermont", "America/New_York"),
    "VA": ("Virginia", "America/New_York"), "WA": ("Washington", "America/Los_Angeles"),
    "WV": ("West Virginia", "America/New_York"), "WI": ("Wisconsin", "America/Chicago"),
    "WY": ("Wyoming", "America/Denver"),
}

ALL = sorted(STATES)
NAME_TO_CODE = {name.lower(): code for code, (name, _) in STATES.items()}


def name(code: str) -> str:
    return STATES.get(code, (code, None))[0]


def default_tz(code: str) -> str | None:
    return STATES.get(code, (None, None))[1]


def code_for(text: str | None) -> str | None:
    """'IL' / 'Illinois' / 'il' -> 'IL'."""
    if not text:
        return None
    t = text.strip()
    if t.upper() in STATES:
        return t.upper()
    return NAME_TO_CODE.get(t.lower())


_tf = None


def tz_for(coord: str | None, state: str | None) -> str | None:
    """Time zone from Wikidata 'Point(lon lat)', else the state's main zone."""
    global _tf
    if coord:
        try:
            lon, lat = (float(x) for x in coord.replace("Point(", "").rstrip(")").split())
            if _tf is None:
                from timezonefinder import TimezoneFinder
                _tf = TimezoneFinder()
            tz = _tf.timezone_at(lng=lon, lat=lat)
            if tz:
                return tz
        except (ValueError, ImportError):
            pass
    return default_tz(state) if state else None
