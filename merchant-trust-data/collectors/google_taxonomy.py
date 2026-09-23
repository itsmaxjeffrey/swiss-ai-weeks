"""Google Product Taxonomy collector.

Download: https://www.google.com/basepages/producttype/taxonomy-with-ids.en-US.txt
License: free to use for product categorization (Google Merchant Center taxonomy).
"""

from __future__ import annotations

import json
import sys

from collectors import common


def collect() -> tuple[str, dict, bool]:
    cfg = common.CONFIG["google_taxonomy"]
    filename = f"taxonomy_en-US_{common.today()}.txt"
    path, meta, cached = common.get(cfg["taxonomy_url"], "google_taxonomy", filename)
    info = {
        "source": "google_taxonomy",
        "bytes": meta["bytes"],
        "cached": cached,
        "retrieved_at": meta["retrieved_at"],
        "sha256": meta["sha256"],
    }
    print(json.dumps(info), file=sys.stderr)
    return str(path), meta, cached


if __name__ == "__main__":
    collect()
