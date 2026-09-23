"""Majestic Million collector.

Download: https://downloads.majestic.com/majestic_million.csv
License: free with attribution; commercial use requires license.
"""

from __future__ import annotations

import json
import sys

from collectors import common


def collect() -> tuple[str, dict, bool]:
    cfg = common.CONFIG["majestic"]
    filename = f"majestic_million_{common.today()}.csv"
    path, meta, cached = common.get_stream(cfg["csv_url"], "majestic", filename)
    info = {
        "source": "majestic",
        "bytes": meta["bytes"],
        "cached": cached,
        "retrieved_at": meta["retrieved_at"],
        "sha256": meta["sha256"],
    }
    print(json.dumps(info), file=sys.stderr)
    return str(path), meta, cached


if __name__ == "__main__":
    collect()
