"""Viseca public synthetic pack collector (Swiss-ai-Weeks/viseca-2026).

Download: repo tarball; extracts data/ (CSVs + JSON schemas + scenario fixtures).
License: synthetic data released via the Swiss-ai-Weeks repo; see repo README.
"""

from __future__ import annotations

import json
import sys

from collectors import common


def collect() -> tuple[list[str], dict, bool]:
    cfg = common.CONFIG["viseca"]
    filename = f"viseca_2026_main_{common.today()}.tar.gz"
    path, meta, cached = common.get(cfg["tarball_url"], "viseca", filename)
    root = common.extract_tarball(path, "viseca", members=cfg.get("members"))
    extracted = sorted(str(p) for p in (root / "viseca-2026-main" / "data").rglob("*") if p.is_file())
    info = {
        "source": "viseca",
        "bytes": meta["bytes"],
        "cached": cached,
        "retrieved_at": meta["retrieved_at"],
        "files": len(extracted),
    }
    print(json.dumps(info), file=sys.stderr)
    return extracted, meta, cached


if __name__ == "__main__":
    collect()
