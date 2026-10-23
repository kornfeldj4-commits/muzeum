"""Polite page fetching for unattended runs.

- robots.txt is checked for every site, with a named user agent
- requests to the same site are at least 2 seconds apart, even across threads
- transient failures (timeouts, 429, 5xx) are retried with backoff
- pages whose text is too short are rendered in headless Chromium when available
- every page gets a hash of its visible text, so unchanged pages skip the model
"""
from __future__ import annotations

import hashlib
import html as htmllib
import re
import threading
import time
import urllib.robotparser
from urllib.parse import urljoin, urlparse

import requests

from . import config

USER_AGENT = config.USER_AGENT
MIN_TEXT = 400
SITE_GAP = 2.0
RETRY_STATUS = {429, 500, 502, 503, 504}
VISIT_HINTS = re.compile(r"/(visit|plan-your-visit|plan-a-visit|hours|admission|tickets|hours-and-admission|hours-admission)(/|$|-|\.)", re.I)

_robots: dict[str, urllib.robotparser.RobotFileParser] = {}
_robots_lock = threading.Lock()
_site_locks: dict[str, threading.Lock] = {}
_last_hit: dict[str, float] = {}
_session = requests.Session()
_session.headers.update({"User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.8"})


def _site(url: str) -> str:
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}"


def allowed(url: str) -> bool:
    host = _site(url)
    with _robots_lock:
        rp = _robots.get(host)
    if rp is None:
        rp = urllib.robotparser.RobotFileParser(host + "/robots.txt")
        try:
            r = _session.get(host + "/robots.txt", timeout=10)
            # 4xx means "no robots.txt": everything allowed. 5xx means "unsure": be careful.
            if r.status_code >= 500:
                rp.parse(["User-agent: *", "Disallow: /"])
            else:
                rp.parse(r.text.splitlines() if r.ok else [])
        except requests.RequestException:
            rp.parse([])
        with _robots_lock:
            _robots[host] = rp
    return rp.can_fetch(USER_AGENT, url)


def _wait_turn(url: str):
    host = urlparse(url).netloc
    with _robots_lock:
        lock = _site_locks.setdefault(host, threading.Lock())
    with lock:
        wait = _last_hit.get(host, 0) + SITE_GAP - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_hit[host] = time.time()


def get(url: str, tries: int = 3) -> tuple[int | str, str, str]:
    """-> (status, final_url, html). Retries transient failures."""
    delay = 3.0
    for attempt in range(tries):
        _wait_turn(url)
        try:
            r = _session.get(url, timeout=25, allow_redirects=True)
            if r.status_code in RETRY_STATUS and attempt < tries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            ctype = r.headers.get("content-type", "")
            if "html" not in ctype and "text" not in ctype:
                return f"not_html:{ctype[:30]}", r.url, ""
            return r.status_code, r.url, r.text
        except requests.RequestException as e:
            if attempt == tries - 1:
                return f"error:{e.__class__.__name__}", url, ""
            time.sleep(delay)
            delay *= 2
    return "error:exhausted", url, ""


def page_text(html: str) -> str:
    html = re.sub(r"(?is)<(script|style|noscript|svg|template)[^>]*>.*?</\1>", " ", html)
    html = re.sub(r"(?is)<(nav|header)[^>]*>.*?</\1>", " ", html)
    html = re.sub(r"(?i)<br\s*/?>|</(p|div|li|tr|td|th|h\d|dt|dd|section|article)>", "\n", html)
    text = htmllib.unescape(re.sub(r"<[^>]+>", " ", html))
    text = re.sub(r"[ \t\xa0​]+", " ", text)
    return re.sub(r"\n\s*\n+", "\n", text).strip()


def text_hash(text: str) -> str:
    # Ignore "Open today ..." style lines, which change daily without the hours changing.
    stable = re.sub(r"(?im)^.*\btoday\b.*$", "", text)
    stable = re.sub(r"\s+", " ", stable).strip().lower()
    return hashlib.sha256(stable.encode()).hexdigest()[:24]


def fetch(url: str) -> dict:
    """-> {url, final_url, status, html, text, hash, rendered}."""
    if not allowed(url):
        return {"url": url, "status": "robots_disallowed", "html": "", "text": "", "hash": None}
    status, final, html = get(url)
    text, rendered = page_text(html), False
    if status == 200 and len(text) < MIN_TEXT:
        html2 = render(url)
        if html2:
            html, text, rendered = html2, page_text(html2), True
    ok = status == 200 and len(text) >= 80
    return {"url": url, "final_url": final, "status": status if ok or status != 200 else "too_little_text",
            "html": html, "text": text, "hash": text_hash(text) if ok else None, "rendered": rendered}


def render(url: str) -> str | None:
    """Headless Chromium for pages built by JavaScript. Optional."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return None
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            try:
                pg = b.new_page(user_agent=USER_AGENT)
                pg.goto(url, wait_until="networkidle", timeout=30000)
                return pg.content()
            finally:
                b.close()
    except Exception:
        return None


def find_visit_page(home_url: str) -> str | None:
    """From a museum's home page, the same-site link most likely to hold hours."""
    if not allowed(home_url):
        return None
    status, final, html = get(home_url)
    if status != 200:
        return None
    cands = []
    for href in re.findall(r'href=["\']([^"\'#]+)["\']', html):
        u = urljoin(final, href.strip())
        if urlparse(u).netloc.removeprefix("www.") != urlparse(final).netloc.removeprefix("www."):
            continue
        path = urlparse(u).path.lower()
        if VISIT_HINTS.search(path):
            score = 3 * ("hour" in path) + 2 * ("visit" in path) + ("admission" in path) - path.count("/") * 0.1
            cands.append((score, u.split("?")[0]))
    return max(cands)[1] if cands else final
