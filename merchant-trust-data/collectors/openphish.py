"""OpenPhish community feed collector.

Feed: https://openphish.com/feed.txt (active confirmed phishing URLs).
License: free for non-commercial use with attribution; commercial use needs a
subscription. See DATA_SOURCES.md.
"""

from __future__ import annotations

import json
import sys

from collectors import common


def collect() -> tuple[list[str], dict, bool]:
    cfg = common.CONFIG["openphish"]
    filename = f"openphish_feed_{common.today()}.txt"
    path, meta, cached = common.get(cfg["feed_url"], "openphish", filename)
    text = path.read_text(encoding="utf-8", errors="replace")
    urls = [line.strip() for line in text.splitlines() if line.strip()]
    info = {
        "source": "openphish",
        "urls": len(urls),
        "cached": cached,
        "retrieved_at": meta["retrieved_at"],
        "sha256": meta["sha256"],
    }
    print(json.dumps(info), file=sys.stderr)
    return urls, meta, cached
