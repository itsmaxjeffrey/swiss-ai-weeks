"""Tranco top-1M ranking collector.

Download: https://tranco-list.eu/top-1m.csv.zip (307-redirects to the daily list)
License: free for research with attribution; see tranco-list.eu terms.
"""

from __future__ import annotations

import json
import sys

from collectors import common


def collect() -> tuple[str, dict, bool]:
    cfg = common.CONFIG["tranco"]
    filename = f"tranco_top1m_{common.today()}.zip"
    path, meta, cached = common.get_stream(cfg["list_url"], "tranco", filename)
    info = {
        "source": "tranco",
        "bytes": meta["bytes"],
        "cached": cached,
        "retrieved_at": meta["retrieved_at"],
        "sha256": meta["sha256"],
    }
    print(json.dumps(info), file=sys.stderr)
    return str(path), meta, cached


if __name__ == "__main__":
    collect()
