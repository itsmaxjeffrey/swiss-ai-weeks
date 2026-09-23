"""URLhaus (abuse.ch) recent malware-URL collector.

Download: https://urlhaus.abuse.ch/downloads/csv_recent/
License: abuse.ch data is free to use and share; attribution appreciated.
CSV has comment lines starting with '#'.
"""

from __future__ import annotations

import json
import sys

from collectors import common


def collect() -> tuple[str, dict, bool]:
    cfg = common.CONFIG["urlhaus"]
    filename = f"urlhaus_csv_recent_{common.today()}.csv"
    path, meta, cached = common.get(cfg["csv_url"], "urlhaus", filename)
    info = {
        "source": "urlhaus",
        "bytes": meta["bytes"],
        "cached": cached,
        "retrieved_at": meta["retrieved_at"],
        "sha256": meta["sha256"],
    }
    print(json.dumps(info), file=sys.stderr)
    return str(path), meta, cached
