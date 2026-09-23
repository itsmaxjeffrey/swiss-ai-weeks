"""Microsoft BIPIA (indirect prompt-injection benchmark) collector.

Download: repo tarball; extracts benchmark/ (qa/email/table/code/abstract).
License: MIT (per repo LICENSE/NOTICE).
"""

from __future__ import annotations

import json
import sys

from collectors import common


def collect() -> tuple[list[str], dict, bool]:
    cfg = common.CONFIG["bipia"]
    filename = f"bipia_main_{common.today()}.tar.gz"
    path, meta, cached = common.get(cfg["tarball_url"], "bipia", filename)
    root = common.extract_tarball(path, "bipia", members=cfg.get("members"))
    bench = root / "BIPIA-main" / "benchmark"
    extracted = sorted(str(p) for p in bench.rglob("*") if p.is_file())
    info = {
        "source": "bipia",
        "bytes": meta["bytes"],
        "cached": cached,
        "retrieved_at": meta["retrieved_at"],
        "files": len(extracted),
    }
    print(json.dumps(info), file=sys.stderr)
    return extracted, meta, cached


if __name__ == "__main__":
    collect()
