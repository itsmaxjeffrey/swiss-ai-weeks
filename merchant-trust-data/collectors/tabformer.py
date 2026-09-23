"""IBM TabFormer credit-card transaction dataset collector.

Download: git-lfs object served via media.githubusercontent.com (266MB tgz).
Fallback (manual): https://ibm.box.com/v/tabformer-data
License: synthetic data released by IBM for research (IBM/TabFormer repo).
"""

from __future__ import annotations

import json
import sys

from collectors import common


def collect() -> tuple[str, dict, bool]:
    cfg = common.CONFIG["tabformer"]
    filename = "tabformer_transactions.tgz"
    path, meta, cached = common.get_stream(cfg["tgz_url"], "tabformer", filename)
    info = {
        "source": "tabformer",
        "bytes": meta["bytes"],
        "cached": cached,
        "retrieved_at": meta["retrieved_at"],
        "sha256": meta["sha256"],
    }
    print(json.dumps(info), file=sys.stderr)
    return str(path), meta, cached


if __name__ == "__main__":
    collect()
