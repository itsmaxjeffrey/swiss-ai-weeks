"""External-source collection runner (Phase-2 datasets).

Maps source names to collectors and runs them sequentially with cache
(resumable). Blocked sources (gated APIs) record a status file and are
skipped rather than failing the run.

Usage:
  python -m processing.collect_external            # all enabled external sources
  python -m processing.collect_external tabformer  # subset
"""

from __future__ import annotations

import importlib
import json
import sys

from collectors import common

EXTERNAL_SOURCES = [
    "tranco",
    "majestic",
    "google_taxonomy",
    "viseca",
    "bipia",
    "agentdojo",
    "tensortrust",
    "ulb_creditcard",
    "ieee_cis",
    "tabformer",
    "hackaprompt",
]


def main(argv: list[str]) -> int:
    sources = argv or EXTERNAL_SOURCES
    summary = []
    for src in sources:
        cfg = common.CONFIG.get(src)
        if cfg is not None and cfg.get("enabled") is False:
            print(json.dumps({"source": src, "status": "disabled"}), file=sys.stderr)
            continue
        try:
            mod = importlib.import_module(f"collectors.{src}")
            mod.collect()
            summary.append({"source": src, "status": "ok"})
        except Exception as e:  # noqa: BLE001 — keep collecting other sources
            summary.append({"source": src, "status": "error", "error": f"{type(e).__name__}: {e}"})
            print(json.dumps(summary[-1]), file=sys.stderr)
    print(json.dumps({"collected": summary}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
