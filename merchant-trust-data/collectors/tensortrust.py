"""Tensor Trust collector (HumanCompatibleAI/tensor-trust-data).

Targeted files: raw attack/defense dumps (jsonl.bz2) + derived benchmarks.
License: permissively licensed (per repo README).
"""

from __future__ import annotations

import json
import sys

from collectors import common


def collect() -> tuple[list[str], dict, bool]:
    cfg = common.CONFIG["tensortrust"]
    paths = []
    metas = []
    cached_all = True
    for rel in cfg["files"]:
        fname = rel.replace("/", "__")
        # big raw dumps stream; small benchmark jsonls can too (uniform path)
        path, meta, cached = common.get_stream(
            cfg["base_url"] + rel, "tensortrust", fname, timeout=300
        )
        paths.append(str(path))
        metas.append(meta)
        cached_all = cached_all and cached
    info = {
        "source": "tensortrust",
        "files": [{k: m[k] for k in ("file", "bytes", "sha256")} for m in metas],
        "cached": cached_all,
        "retrieved_at": metas[-1]["retrieved_at"],
    }
    print(json.dumps(info), file=sys.stderr)
    return paths, {"files": metas}, cached_all


if __name__ == "__main__":
    collect()
