"""AgentDojo collector (ethz-spylab/agentdojo).

Download: repo tarball; extracts src/ (task suites + injection vectors, Python)
and runs/ (published benchmark results: attack/utility success per pipeline).
License: MIT (per repo LICENSE).
"""

from __future__ import annotations

import json
import sys

from collectors import common


def collect() -> tuple[list[str], dict, bool]:
    cfg = common.CONFIG["agentdojo"]
    filename = f"agentdojo_main_{common.today()}.tar.gz"
    path, meta, cached = common.get(cfg["tarball_url"], "agentdojo", filename)
    root = common.extract_tarball(path, "agentdojo", members=cfg.get("members"))
    extracted = sorted(
        str(p) for p in root.rglob("*")
        if p.is_file() and (("/src/" in str(p)) or ("/runs/" in str(p)))
    )
    info = {
        "source": "agentdojo",
        "bytes": meta["bytes"],
        "cached": cached,
        "retrieved_at": meta["retrieved_at"],
        "files": len(extracted),
    }
    print(json.dumps(info), file=sys.stderr)
    return extracted, meta, cached


if __name__ == "__main__":
    collect()
