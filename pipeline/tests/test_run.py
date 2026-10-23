"""Whole-run tests with the network replaced by recorded data.

The recorded data is the real 17-museum test from 2026-10-23: the Wikidata
answer is rebuilt from that registry, and the model's answers are the saved
extractions. Everything after the network runs for real."""
import json
import re
import shutil
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

from muzeum_pipeline import benchmark, config, fetch, pipeline
from muzeum_pipeline import normalize as N

HERE = Path(__file__).resolve().parent.parent
RUN = HERE / "runs" / "2026-10-23"
REGISTRY = json.loads((RUN / "registry.json").read_text())
RAW = json.loads((RUN / "raw.json").read_text())
RAW.update({k: v for k, v in json.loads((RUN / "raw.v2.json").read_text()).items() if not k.startswith("_")})
BY_NAME = {m["name"]: RAW[m["id"]] for m in REGISTRY}
DAY0 = date(2026, 10, 23)
STATES = ["IL", "WI", "MN", "MI", "IN", "MO", "OH"]


class FakeResp:
    def __init__(self, data):
        self.data = data

    def raise_for_status(self):
        pass

    def json(self):
        return self.data


class FakeWikidata:
    """Answers the SPARQL query from the recorded registry."""
    def __init__(self, fail_states=()):
        self.fail_states = set(fail_states)
        self.calls = 0

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls += 1
        code = re.search(r'"US-([A-Z]{2})"', params["query"]).group(1)
        if code in self.fail_states:
            raise fetch.requests.ConnectionError("down")
        rows = [{"m": {"value": f"http://www.wikidata.org/entity/Q{i + 1000}"}, "mLabel": {"value": m["name"]},
                 "site": {"value": m.get("home") or m["url"]}, "cityLabel": {"value": m["city"]},
                 **({"alt": {"value": alt}} if alt else {})}
                for i, m in enumerate(REGISTRY) if m["state"] == code for alt in (m.get("alternates") or [None])]
        return FakeResp({"results": {"bindings": rows}})


class FakeWeb:
    """Each museum page = its recorded hours sentence plus filler; `changed` alters a page."""
    def __init__(self):
        self.changed, self.down = set(), set()

    def finder(self, home):
        return next((m["url"] for m in REGISTRY if (m.get("home") or m["url"]) == home), home)

    def fetch(self, url):
        m = next(m for m in REGISTRY if m["url"] == url)
        if m["name"] in self.down:
            return {"url": url, "final_url": url, "status": "error:ConnectTimeout", "html": "", "text": "", "hash": None}
        text = f"{m['name']}\nHours\n{RAW[m['id']]['hours_quote']}\nPlan your visit. " + ("Updated. " if m["name"] in self.changed else "")
        return {"url": url, "final_url": url, "status": 200, "html": "<html></html>", "text": text * 3,
                "hash": fetch.text_hash(text), "rendered": False}


class FakeModel:
    def __init__(self):
        self.calls = []

    def __call__(self, text, museum):
        self.calls.append(museum["name"])
        return BY_NAME[museum["name"]], {"input_tokens": 3000, "output_tokens": 600}


class Run(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.patches = [mock.patch.object(config, "STATE_DIR", self.tmp / "state"),
                        mock.patch.object(config, "DATA_OUT", self.tmp / "data" / "museums.json"),
                        mock.patch.object(config, "OVERRIDES", self.tmp / "overrides.json"),
                        mock.patch.object(config, "WORKERS", 4),
                        mock.patch("muzeum_pipeline.pipeline.time.sleep"),
                        mock.patch("muzeum_pipeline.pipeline.log")]
        for p in self.patches:
            p.start()
        self.web, self.model, self.wd = FakeWeb(), FakeModel(), FakeWikidata()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.tmp)

    def go(self, day, **kw):
        return pipeline.run(today=day, wanted_states=STATES, extractor=self.model, fetcher=self.web.fetch,
                            finder=self.web.finder, session=self.wd, **kw)

    def data(self):
        return json.loads((self.tmp / "data" / "museums.json").read_text())

    def test_first_run_publishes_and_merges_hand_checked(self):
        r = self.go(DAY0)
        self.assertEqual(len(self.model.calls), 17)
        d = self.data()
        ids = {m["id"] for m in d["museums"]}
        # hand-checked records replace their automated twins (same site, same name), not duplicate them
        self.assertIn("mus_art_institute_chicago", ids)
        self.assertEqual(sum("Art Institute" in m["name"]["display"] for m in d["museums"]), 1)
        self.assertEqual(sum(m["name"]["display"] == "Racine Art Museum" for m in d["museums"]), 1)
        self.assertEqual(len(d["museums"]), 8 + 11)
        mia = next(m for m in d["museums"] if "Minneapolis Institute" in m["name"]["display"])
        self.assertTrue(mia["provenance"]["conflict_flag"])
        self.assertEqual(r["summary"]["hold"], 1)
        self.assertTrue((self.tmp / "state" / "review.md").read_text().count("Minneapolis Institute of Art"))
        for m in d["museums"]:   # every museum's city exists
            self.assertIn(m["city_id"], {c["id"] for c in d["cities"]})
        bench = [x for b in r["benchmark"] for x in b["rows"]]
        self.assertGreaterEqual(sum(x["ok"] for x in bench) / len(bench), 0.95)

    def test_unchanged_pages_skip_the_model_and_stay_fresh(self):
        self.go(DAY0)
        self.model.calls.clear()
        self.go(DAY0 + timedelta(days=1))
        self.assertEqual(self.model.calls, [])
        walker = next(m for m in self.data()["museums"] if m["name"]["display"] == "Walker Art Center")
        self.assertEqual(walker["provenance"]["verified_at"], (DAY0 + timedelta(days=1)).isoformat())

    def test_changed_page_is_read_again(self):
        self.go(DAY0)
        self.model.calls.clear()
        self.web.changed.add("Walker Art Center")
        self.go(DAY0 + timedelta(days=1))
        self.assertEqual(self.model.calls, ["Walker Art Center"])

    def test_page_down_keeps_last_reading_which_then_ages(self):
        self.go(DAY0)
        self.web.down.add("Cleveland Museum of Art")
        day = DAY0 + timedelta(days=20)
        self.go(day)
        cma = next(m for m in self.data()["museums"] if m["name"]["display"] == "Cleveland Museum of Art")
        self.assertEqual(cma["provenance"]["verified_at"], DAY0.isoformat())   # the app shows it as aging
        self.go(DAY0 + timedelta(days=config.CARRY_DAYS + 1), allow_shrink=True)
        self.assertFalse(any(m["name"]["display"] == "Cleveland Museum of Art" for m in self.data()["museums"]))

    def test_model_cap_defers_the_rest(self):
        with mock.patch.object(config, "MAX_EXTRACTIONS", 5):
            r = self.go(DAY0)
            self.assertEqual(len(self.model.calls), 5)
            self.assertEqual(r["summary"]["deferred"], 12)
            self.go(DAY0 + timedelta(days=1))
            self.assertEqual(len(self.model.calls), 10)

    def test_model_failure_on_one_page_does_not_stop_the_run(self):
        def flaky(text, museum):
            if museum["name"] == "Walker Art Center":
                raise RuntimeError("overloaded")
            return self.model(text, museum)
        r = pipeline.run(today=DAY0, wanted_states=STATES, extractor=flaky, fetcher=self.web.fetch,
                         finder=self.web.finder, session=self.wd)
        self.assertEqual(r["summary"]["errors"], 1)
        self.assertEqual(len(self.data()["museums"]), 18)

    def test_circuit_breaker_keeps_the_good_site(self):
        self.go(DAY0)
        before = self.data()
        self.wd = FakeWikidata()
        with mock.patch.object(pipeline, "merge_manual", lambda auto, today: ([], [], [])):
            r = self.go(DAY0 + timedelta(days=1))
        self.assertTrue(r["breaker"])
        self.assertEqual(self.data(), before)

    def test_wikidata_outage_keeps_last_week_list(self):
        self.go(DAY0)
        self.wd = FakeWikidata(fail_states=STATES)
        with mock.patch("muzeum_pipeline.discover.time.sleep"):
            self.go(DAY0 + timedelta(days=8))
        self.assertEqual(len(self.data()["museums"]), 19)

    def test_reviewer_confirm_and_exclude(self):
        r = self.go(DAY0)
        mia = next(x for x in r["results"] if x["name"] == "Minneapolis Institute of Art")
        slam = next(x for x in r["results"] if x["name"] == "Saint Louis Art Museum")
        (self.tmp / "overrides.json").write_text(json.dumps({
            mia["id"]: {"confirm_hash": mia["page_hash"], "note": "checked"},
            slam["id"]: {"exclude": "test"}}))
        r = self.go(DAY0 + timedelta(days=1))
        d = self.data()
        m = next(x for x in d["museums"] if x["id"] == mia["id"])
        self.assertFalse(m["provenance"]["conflict_flag"])
        self.assertFalse(any(x["id"] == slam["id"] for x in d["museums"]))
        # the confirmation lapses when the page changes
        self.web.changed.add("Minneapolis Institute of Art")
        self.go(DAY0 + timedelta(days=2))
        m = next(x for x in self.data()["museums"] if x["id"] == mia["id"])
        self.assertTrue(m["provenance"]["conflict_flag"])

    def test_stable_ids_across_rediscovery(self):
        self.go(DAY0)
        first = {m["id"] for m in self.data()["museums"]}
        self.go(DAY0 + timedelta(days=8), allow_shrink=True)
        self.assertEqual({m["id"] for m in self.data()["museums"]}, first)


class Replay(unittest.TestCase):
    """Regression: the saved extractions must still score at least 85 of 88 against the answer key."""
    def test_benchmark_floor(self):
        key = benchmark.load_key()
        rows = []
        for m in REGISTRY:
            k = benchmark.match_key(key, {**m, "home": m.get("home") or m["url"]})
            if k:
                n = N.normalize(RAW[m["id"]], m, DAY0)
                rows += benchmark.score(k, n, DAY0.isoformat(), (DAY0 + timedelta(days=N.HORIZON_DAYS)).isoformat())["rows"]
        self.assertEqual(len(rows), 88)
        self.assertGreaterEqual(sum(r["ok"] for r in rows), 85)


if __name__ == "__main__":
    unittest.main()
