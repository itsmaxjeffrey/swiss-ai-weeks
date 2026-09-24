"""FeodoTracker (abuse.ch) C2 IP blocklist collector.

Downloads: JSON variant preferred, CSV fallback:
  https://feodotracker.abuse.ch/downloads/ipblocklist.json
  https://feodotracker.abuse.ch/downloads/ipblocklist.csv
License: abuse.ch FeodoTracker — free to use and share; attribution
appreciated. Non-commercial per abuse.ch terms (see LICENSE_NOTES.md).
"""

from __future__ import annotations

import json
import sys

import requests

from collectors import common


def collect() -> tuple[str, dict, bool]:
    cfg = common.CONFIG["feodotracker"]
    last_err: Exception | None = None
    for variant, url, ctype in (
        ("json", cfg["json_url"], "application/json"),
        ("csv", cfg["csv_url"], "text/csv"),
    ):
        filename = f"feodotracker_ipblocklist_{variant}_{common.today()}.{variant}"
        try:
            path, meta, cached = common.get(url, "feodotracker", filename)
            info = {
                "source": "feodotracker",
                "variant": variant,
                "bytes": meta["bytes"],
                "cached": cached,
                "retrieved_at": meta["retrieved_at"],
                "sha256": meta["sha256"],
            }
            print(json.dumps(info), file=sys.stderr)
            return str(path), meta, cached
        except requests.RequestException as e:  # try next variant
            last_err = e
    raise RuntimeError(f"all feodotracker variants failed; last: {last_err}")
