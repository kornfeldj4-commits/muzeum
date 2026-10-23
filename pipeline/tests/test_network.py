"""The network layer with fake servers: robots.txt, retries, discovery fallbacks, model retries."""
import types
import unittest
from unittest import mock

from muzeum_pipeline import discover, extract, fetch, states


class Resp:
    def __init__(self, status=200, text="", ctype="text/html", url="https://m.test/visit"):
        self.status_code, self.text, self.url = status, text, url
        self.headers = {"content-type": ctype}
        self.ok = status < 400


PAGE = "<html><body><h1>Visit</h1><p>Hours</p><p>Tuesday–Sunday 10 am–5 pm. Closed Monday.</p>" + "<p>Plan your visit to the galleries.</p>" * 20 + "</body></html>"


class Fetching(unittest.TestCase):
    def setUp(self):
        fetch._robots.clear()
        fetch._last_hit.clear()
        self.sleep = mock.patch("muzeum_pipeline.fetch.time.sleep").start()

    def tearDown(self):
        mock.patch.stopall()

    def serve(self, routes):
        calls = []

        def get(url, **kw):
            calls.append(url)
            r = routes[url]
            return r.pop(0) if isinstance(r, list) else r
        mock.patch.object(fetch._session, "get", side_effect=get).start()
        return calls

    def test_robots_disallow_is_respected(self):
        calls = self.serve({"https://m.test/robots.txt": Resp(text="User-agent: *\nDisallow: /visit")})
        out = fetch.fetch("https://m.test/visit")
        self.assertEqual(out["status"], "robots_disallowed")
        self.assertEqual(calls, ["https://m.test/robots.txt"])

    def test_retry_on_503_then_success(self):
        self.serve({"https://m.test/robots.txt": Resp(404),
                    "https://m.test/visit": [Resp(503), Resp(200, PAGE)]})
        out = fetch.fetch("https://m.test/visit")
        self.assertEqual(out["status"], 200)
        self.assertIn("Tuesday–Sunday 10 am–5 pm", out["text"])
        self.assertTrue(out["hash"])

    def test_pdf_is_not_read(self):
        self.serve({"https://m.test/robots.txt": Resp(404), "https://m.test/visit": Resp(200, "%PDF", ctype="application/pdf")})
        self.assertTrue(fetch.fetch("https://m.test/visit")["status"].startswith("not_html"))

    def test_hash_ignores_today_line(self):
        a = fetch.text_hash("Hours\nOpen today 10–5\nTue–Sun 10–5")
        b = fetch.text_hash("Hours\nOpen today 11–4\nTue–Sun 10–5")
        c = fetch.text_hash("Hours\nOpen today 11–4\nTue–Sun 10–6")
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)

    def test_find_visit_page(self):
        home = '<a href="/shop">Shop</a><a href="/visit/hours-admission/">Hours</a><a href="https://other.org/visit">x</a>'
        self.serve({"https://m.test/robots.txt": Resp(404), "https://m.test/": Resp(200, home, url="https://m.test/")})
        self.assertEqual(fetch.find_visit_page("https://m.test/"), "https://m.test/visit/hours-admission/")


class Discovery(unittest.TestCase):
    def binding(self, qid, name, site, city=None, coord=None):
        b = {"m": {"value": f"http://www.wikidata.org/entity/{qid}"}, "mLabel": {"value": name}, "site": {"value": site}}
        if city:
            b["cityLabel"] = {"value": city}
        if coord:
            b["coord"] = {"value": coord}
        return b

    def test_falls_back_to_simple_query_and_dedupes(self):
        rows = [self.binding("Q1", "Test Art Museum", "https://www.test.org/en/", "Testville"),
                self.binding("Q1", "Test Art Museum", "https://test.org", "Testville"),
                self.binding("Q2", "Q2", "https://x.org")]   # no English label
        session = types.SimpleNamespace(calls=0)

        def get(url, params, headers, timeout):
            session.calls += 1
            if "P279*" in params["query"]:
                raise discover.requests.Timeout()
            return types.SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"results": {"bindings": rows}})
        session.get = get
        with mock.patch("muzeum_pipeline.discover.time.sleep"):
            out = discover.discover_state("IL", session)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["home"], "https://test.org")
        self.assertEqual(session.calls, 3)   # full query twice, then the simple one

    def test_time_zone_from_coordinates(self):
        # Gary, Indiana is on Chicago time, unlike most of Indiana
        self.assertEqual(states.tz_for("Point(-87.35 41.60)", "IN"), "America/Chicago")
        self.assertEqual(states.tz_for(None, "IN"), "America/Indiana/Indianapolis")
        self.assertEqual(len(states.ALL), 51)

    def test_ids_are_stable_and_unique(self):
        prev = {"mus_test_art_museum": {"wikidata": "Q1", "url": "https://test.org/visit"}}
        out = discover.assign_ids([{"wikidata": "Q1", "name": "Test Art Museum (renamed)", "alternates": []},
                                   {"wikidata": "Q9", "name": "Test Art Museum", "alternates": []}], prev)
        self.assertEqual(out[0]["id"], "mus_test_art_museum")
        self.assertEqual(out[0]["url"], "https://test.org/visit")
        self.assertEqual(out[1]["id"], "mus_test_art_museum_q9")


class Model(unittest.TestCase):
    def client(self, answers):
        msgs = [types.SimpleNamespace(content=[types.SimpleNamespace(type="text", text=a)],
                                      usage=types.SimpleNamespace(input_tokens=100, output_tokens=20)) for a in answers]
        c = types.SimpleNamespace(calls=[])

        def create(**kw):
            c.calls.append(kw)
            return msgs[len(c.calls) - 1]
        c.messages = types.SimpleNamespace(create=create)
        return c

    GOOD = '{"weekly_hours": {"MON": "closed"}, "exceptions": [], "admission": [], "exhibitions": [], "hours_quote": "Closed Monday"}'

    def test_retries_once_on_bad_json(self):
        c = self.client(["Sorry, I can't", self.GOOD])
        raw, usage = extract.extract("page", {"name": "M", "url": "u"}, client=c)
        self.assertEqual(raw["weekly_hours"]["MON"], "closed")
        self.assertEqual(usage["input_tokens"], 200)
        self.assertEqual(c.calls[0].get("temperature", 0), 0)
        self.assertIn("MUSEUM: M", c.calls[0]["messages"][0]["content"])

    def test_drops_temperature_if_the_model_refuses_it(self):
        good = self.client([self.GOOD])
        calls = []

        def create(**kw):
            calls.append(kw)
            if "temperature" in kw:
                raise ValueError("temperature is not supported for this model")
            return good.messages.create(**kw)
        c = types.SimpleNamespace(messages=types.SimpleNamespace(create=create))
        raw, _ = extract.extract("page", {"name": "M", "url": "u"}, client=c)
        self.assertEqual(raw["hours_quote"], "Closed Monday")
        self.assertNotIn("temperature", calls[-1])
        extract._SAMPLING["temperature"] = 0

    def test_gives_up_after_two_bad_answers(self):
        with self.assertRaises(extract.ExtractError):
            extract.extract("page", {"name": "M", "url": "u"}, client=self.client(["{}", "{}"]))


if __name__ == "__main__":
    unittest.main()
