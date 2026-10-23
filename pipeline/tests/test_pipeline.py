import json
import unittest
from datetime import date

from muzeum_pipeline import crosscheck, jsonld
from muzeum_pipeline import normalize as N
from muzeum_pipeline import validate as V
from muzeum_pipeline.extract import parse_json
from muzeum_pipeline.holidays import parse_early_close, resolve_holidays, resolve_nth_weekday

AS_OF = date(2026, 10, 23)
REG = {"id": "t", "name": "Test Museum", "city": "Testville", "state": "OH", "tz": "America/New_York", "url": "https://x.test/visit"}
WEEK = {"MON": "closed", "TUE": "10:00-17:00", "WED": "10:00-17:00", "THU": "10:00-20:00",
        "FRI": "10:00-17:00", "SAT": "10:00-17:00", "SUN": "12:00-17:00"}


def rec(**over):
    base = {"weekly_hours": WEEK, "exceptions": [], "admission": [], "timed_entry": "not stated",
            "exhibitions": [], "page_date_signals": None, "hours_quote": "Tue–Sat 10 am–5 pm, Thu until 8 pm, Sun noon–5 pm"}
    base.update(over)
    return N.normalize(base, REG, AS_OF)


class Holidays(unittest.TestCase):
    def test_next_occurrences(self):
        got = dict(resolve_holidays("Thanksgiving, Christmas Eve, Christmas and New Year's Day", AS_OF))
        self.assertEqual(got["Thanksgiving"], date(2026, 11, 26))
        self.assertEqual(got["Christmas Eve"], date(2026, 12, 24))
        self.assertEqual(got["Christmas"], date(2026, 12, 25))
        self.assertEqual(got["New Year's Day"], date(2027, 1, 1))

    def test_monday_holidays(self):
        got = dict(resolve_holidays("MLK Day, Presidents Day, Memorial Day, Labor Day", AS_OF))
        self.assertEqual(got["Martin Luther King Jr. Day"], date(2027, 1, 18))
        self.assertEqual(got["Presidents Day"], date(2027, 2, 15))
        self.assertEqual(got["Memorial Day"], date(2027, 5, 31))
        self.assertEqual(got["Labor Day"], date(2027, 9, 6))

    def test_nth_weekday(self):
        self.assertEqual(resolve_nth_weekday("First Wednesday of every month", AS_OF, 60),
                         [date(2026, 11, 4), date(2026, 12, 2)])
        self.assertEqual(resolve_nth_weekday("first Wednesday", AS_OF, 60), [])  # no "month": not recurring

    def test_early_close(self):
        self.assertEqual(parse_early_close("Open until 3 p.m."), "15:00")
        self.assertEqual(parse_early_close("Closed at 4:00 p.m.; opening time not stated."), "16:00")
        self.assertEqual(parse_early_close("closes at 3 pm on Christmas Eve"), "15:00")
        self.assertIsNone(parse_early_close("open late"))


class Exceptions(unittest.TestCase):
    def test_holiday_closed_and_early_close(self):
        n = rec(exceptions=[{"date": "Thanksgiving", "closed": True, "hours": None, "note": ""},
                            {"date": "Christmas Eve", "closed": False, "hours": None, "note": "Closes at 3 pm"}])
        ex = {e["date"]: e for e in n["exceptions"]}
        self.assertTrue(ex["2026-11-26"]["closed"])
        self.assertEqual((ex["2026-12-24"]["open"], ex["2026-12-24"]["close"]), ("10:00", "15:00"))

    def test_event_window_is_not_hours(self):
        n = rec(exceptions=[{"date": "Third Thursdays of every month", "closed": False, "hours": "17:00-20:00", "note": "Free evening"}])
        self.assertEqual(n["exceptions"], [])

    def test_written_past_ranges_mark_stale(self):
        n = rec(exceptions=[{"date": "November 23–26, 2023", "closed": True, "hours": None, "note": ""},
                            {"date": "December 22, 2023–January 1, 2024", "closed": True, "hours": None, "note": ""}])
        self.assertEqual(n["exceptions"], [])  # "January 1" inside a dated range is not a holiday
        self.assertIn("2023", n["stale_reason"])

    def test_copyright_alone_is_not_stale(self):
        n = rec(page_date_signals="©2022")
        self.assertIsNone(n["stale_reason"])
        self.assertTrue(any("copyright" in w for w in n["warnings"]))

    def test_partial_closure(self):
        n = rec(exceptions=[{"date": "undated", "closed": False, "hours": None,
                             "note": "Second-floor galleries are temporarily closed for changeover."}])
        self.assertEqual(n["partial_closure_note"], "Second-floor galleries closed for changeover")

    def test_early_close_is_not_partial_closure(self):
        n = rec(exceptions=[{"date": "New Year's Eve", "closed": False, "hours": None, "note": "Galleries and Shop close at 3pm."}])
        self.assertIsNone(n["partial_closure_note"])
        self.assertEqual(n["exceptions"][0]["close"], "15:00")

    def test_future_closure_range(self):
        n = rec(exceptions=[{"date": "2026-11-02 to 2026-11-20", "closed": True, "hours": None, "note": "Installation"}])
        self.assertEqual(n["temporary_closure"], {"from": "2026-11-02", "until": "2026-11-20", "reason": "Installation"})

    def test_missing_days_inferred_closed(self):
        n = rec(weekly_hours={**WEEK, "MON": None, "TUE": None})
        self.assertEqual(n["inferred_closed"], ["MON", "TUE"])
        self.assertEqual(n["weekly"]["MON"], "closed")


class Admission(unittest.TestCase):
    def test_primary_and_free_label(self):
        n = rec(admission=[{"label": "Adults", "amount": 27, "free": False},
                           {"label": "Seniors 65+", "amount": 20, "free": False},
                           {"label": "Kids 12 and under", "amount": 0, "free": True},
                           {"label": "Members", "amount": 0, "free": True}])
        tiers = n["admission"]["tiers"]
        self.assertEqual(next(t for t in tiers if t.get("primary"))["amount"], 27)
        self.assertEqual(next(t for t in tiers if t.get("free_label"))["free_label"], "12 and under free")
        self.assertFalse(any("Member" in t["label"] for t in tiers))

    def test_non_resident_is_general(self):
        n = rec(admission=[{"label": "Residents - Adults", "amount": 19, "free": False},
                           {"label": "Non-Residents - Adults", "amount": 22, "free": False}])
        self.assertEqual(next(t for t in n["admission"]["tiers"] if t.get("primary"))["amount"], 22)

    def test_resident_only_free_is_not_free_admission(self):
        n = rec(admission=[{"label": "Free for residents of three counties", "amount": 0, "free": True}])
        self.assertEqual(n["admission"]["tiers"], [])
        self.assertTrue(n["admission"]["notes"][0].startswith("General price not listed"))

    def test_weekday_free_becomes_day_note(self):
        n = rec(admission=[{"label": "Adults", "amount": 20, "free": False},
                           {"label": "State residents, Tuesdays 5-9 pm", "amount": 0, "free": True}])
        self.assertEqual(n["admission"]["day_notes"], [{"day": "TUE", "text": "Free: State residents 5–9 pm"}])

    def test_missing_price(self):
        n = rec(admission=[{"label": "Special exhibitions", "amount": None, "free": False}])
        self.assertIn("Special exhibitions: price not listed", n["admission"]["notes"])


class Validation(unittest.TestCase):
    def test_clean_record_publishes(self):
        self.assertEqual(V.verdict(V.validate(rec())), "publish")

    def test_building_hours_held(self):
        n = rec(weekly_hours={**WEEK, "TUE": "08:00-19:00"}, hours_quote="Building Tue 8 a.m.–7 p.m., Wed–Sat 10–5, Thu until 8, Sun 12–5")
        self.assertEqual(V.verdict(V.validate(n)), "hold")

    def test_quote_without_times_held(self):
        self.assertEqual(V.verdict(V.validate(rec(hours_quote="We are open during the following hours:"))), "hold")

    def test_impossible_hours_dropped(self):
        self.assertEqual(V.verdict(V.validate(rec(weekly_hours={**WEEK, "TUE": "17:00-10:00"}))), "drop")

    def test_too_few_days_dropped(self):
        self.assertEqual(V.verdict(V.validate(rec(weekly_hours={"TUE": "10:00-17:00"}))), "drop")

    def test_ended_exhibitions_hidden(self):
        n = rec(exhibitions=[{"title": "Old", "start": None, "end": "2026-10-04"},
                             {"title": "Undated", "start": None, "end": None},
                             {"title": "Current", "start": "2026-09-01", "end": "2027-01-10"}])
        self.assertEqual([e["title"] for e in n["exhibitions"]], ["Current"])


class Structured(unittest.TestCase):
    def test_jsonld_spec(self):
        html = '<script type="application/ld+json">' + json.dumps({"@type": "Museum", "openingHoursSpecification": [
            {"dayOfWeek": ["https://schema.org/Tuesday", "Wednesday"], "opens": "10:00", "closes": "17:00"},
            {"dayOfWeek": "Thursday", "opens": "10:00:00", "closes": "20:00:00"}]}) + "</script>"
        w = jsonld.opening_hours(html)
        self.assertEqual(w["TUE"], ("10:00", "17:00"))
        self.assertEqual(w["THU"], ("10:00", "20:00"))
        self.assertEqual(w["MON"], "closed")

    def test_jsonld_short_form(self):
        w = jsonld.opening_hours('<script type="application/ld+json">{"openingHours": ["Tu-Su 10:00-17:00"]}</script>')
        self.assertEqual(w["SUN"], ("10:00", "17:00"))
        self.assertEqual(w["MON"], "closed")

    def test_crosscheck_holds_on_disagreement(self):
        issues = crosscheck.compare({"MON": "closed", "TUE": ("10:00", "17:00")}, {"MON": ("10:00", "17:00"), "TUE": ("10:00", "17:00")}, "jsonld")
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0]["level"], "hold")

    def test_parse_json_keeps_urls(self):
        self.assertEqual(parse_json('```json\n{"u": "https://a.org/x"}\n```'), {"u": "https://a.org/x"})


if __name__ == "__main__":
    unittest.main()
