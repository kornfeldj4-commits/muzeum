"""Settings, all overridable with environment variables (GitHub Actions sets them)."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # pipeline/
REPO = ROOT.parent                                     # repository root
STATE_DIR = Path(os.environ.get("MUZEUM_STATE_DIR", ROOT / "state"))
DATA_OUT = Path(os.environ.get("MUZEUM_DATA_OUT", REPO / "data" / "museums.json"))
MANUAL = ROOT / "manual.json"
OVERRIDES = ROOT / "overrides.json"
PROMPT_FILE = ROOT / "prompts" / "extract.v3.txt"

MODEL = os.environ.get("MUZEUM_MODEL", "claude-sonnet-5-5")
MAX_EXTRACTIONS = int(os.environ.get("MUZEUM_MAX_EXTRACTIONS", "300"))   # model calls per run
WORKERS = int(os.environ.get("MUZEUM_WORKERS", "8"))                    # parallel page fetches
REGISTRY_MAX_AGE_DAYS = int(os.environ.get("MUZEUM_REGISTRY_DAYS", "7"))  # re-run discovery weekly
CARRY_DAYS = int(os.environ.get("MUZEUM_CARRY_DAYS", "120"))            # keep a record this long after its page stops loading
MANUAL_WINS_DAYS = 14          # a hand-checked record beats an automated one while this fresh
BREAKER_RATIO = float(os.environ.get("MUZEUM_BREAKER", "0.8"))          # refuse to publish if the count falls below this share
USER_AGENT = os.environ.get(
    "MUZEUM_USER_AGENT",
    "MuzeumBot/1.0 (+https://github.com/; museum opening hours for visitors)")
