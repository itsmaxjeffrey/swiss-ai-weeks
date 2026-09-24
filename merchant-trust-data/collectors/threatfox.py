"""ThreatFox (abuse.ch) recent IOC export collector.

Download: https://threatfox.abuse.ch/export/csv/recent/
License: abuse.ch ThreatFox data is free to use and share; attribution
appreciated ("Data provided by abuse.ch ThreatFox"). Non-commercial spirit
per abuse.ch terms — see LICENSE_NOTES.md.
CSV has `#` comment header lines.
"""

from __future__ import annotations

import json
import sys

from collectors import common


def collect() -> tuple[str, dict, bool]:
    cfg = common.CONFIG["threatfox"]
    filename = f"threatfox_csv_recent_{common.today()}.csv"
    path, meta, cached = common.get(cfg["csv_url"], "threatfox", filename)
    info = {
        "source": "threatfox",
        "bytes": meta["bytes"],
        "cached": cached,
        "retrieved_at": meta["retrieved_at"],
        "sha256": meta["sha256"],
    }
    print(json.dumps(info), file=sys.stderr)
    return str(path), meta, cached
