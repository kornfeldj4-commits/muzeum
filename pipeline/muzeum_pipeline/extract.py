"""One fixed prompt for every museum page. The model only reads; what to show
is decided by the rules in normalize.py and validate.py."""
from __future__ import annotations

import json
import re

from . import config

MAX_CHARS = 40000
REQUIRED = {"weekly_hours", "exceptions", "admission", "exhibitions", "hours_quote"}


def prompt() -> str:
    return config.PROMPT_FILE.read_text()


class ExtractError(Exception):
    pass


def extract(page_text: str, museum: dict, client=None) -> tuple[dict, dict]:
    """-> (raw JSON as the prompt asks, usage {input_tokens, output_tokens}).
    Needs ANTHROPIC_API_KEY unless a client is passed in."""
    if client is None:
        import anthropic
        client = anthropic.Anthropic(max_retries=4)
    user = (f"MUSEUM: {museum['name']} ({museum.get('city') or ''}, {museum.get('state') or ''})\n"
            f"URL: {museum.get('url')}\n\nPAGE TEXT:\n{page_text[:MAX_CHARS]}")
    usage = {"input_tokens": 0, "output_tokens": 0}
    last = None
    for _ in range(2):   # one retry when the answer is not valid JSON
        msg = _create(client, user)
        u = getattr(msg, "usage", None)
        if u is not None:
            usage["input_tokens"] += getattr(u, "input_tokens", 0) or 0
            usage["output_tokens"] += getattr(u, "output_tokens", 0) or 0
        text = "".join(getattr(b, "text", "") for b in msg.content if getattr(b, "type", "") == "text")
        try:
            raw = parse_json(text)
            check_shape(raw)
            return raw, usage
        except (ValueError, ExtractError) as e:
            last = e
    raise ExtractError(f"unusable model answer: {last}")


_SAMPLING = {"temperature": 0}


def _create(client, user):
    """Ask for deterministic output; if a model refuses the sampling setting, drop it for the rest of the run."""
    kw = dict(model=config.MODEL, max_tokens=2500, system=prompt(), messages=[{"role": "user", "content": user}])
    try:
        return client.messages.create(**kw, **_SAMPLING)
    except Exception as e:
        if _SAMPLING and "temperature" in str(e).lower():
            _SAMPLING.clear()
            return client.messages.create(**kw)
        raise


def parse_json(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("model returned no JSON")
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return json.loads(re.sub(r"(?m)^\s*//[^\n]*$|,\s*//[^\n\"]*$", ",", m.group(0)))


def check_shape(raw: dict):
    missing = REQUIRED - set(raw)
    if missing:
        raise ExtractError(f"missing keys {sorted(missing)}")
    if not isinstance(raw["weekly_hours"], dict) and raw["weekly_hours"] is not None:
        raise ExtractError("weekly_hours is not an object")
    for k in ("exceptions", "exhibitions"):
        if raw[k] is not None and not isinstance(raw[k], list):
            raise ExtractError(f"{k} is not a list")
