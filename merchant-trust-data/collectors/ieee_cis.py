"""IEEE-CIS Fraud Detection collector (Kaggle competition data).

Official source requires Kaggle credentials + rule acceptance; this collector
pulls a public Hugging Face mirror (aliceczr/ieee-fraud-detection) and the
clean step verifies shape/integrity (590,540 train rows, isFraud present).
Optional token via LEASH_HF_TOKEN (not needed for this public mirror).
"""

from __future__ import annotations

import json
import os
import sys

import requests

from collectors import common


def _headers() -> dict:
    token = os.environ.get(common.CONFIG["ieee_cis"]["auth_env_var"])
    return {"Authorization": f"Bearer {token}"} if token else {}


def collect() -> tuple[list[str], dict, bool]:
    cfg = common.CONFIG["ieee_cis"]
    base = f"https://huggingface.co/datasets/{cfg['hf_repo']}/resolve/main"
    paths = []
    metas = []
    cached_all = True
    for fname in cfg["files"]:
        filename = f"ieee_cis_{fname}"
        path, meta, cached = common.get_stream(
            f"{base}/{fname}", "ieee_cis", filename, headers=_headers(), timeout=300
        )
        paths.append(str(path))
        metas.append(meta)
        cached_all = cached_all and cached
    info = {
        "source": "ieee_cis",
        "files": [{k: m[k] for k in ("file", "bytes", "sha256")} for m in metas],
        "cached": cached_all,
        "retrieved_at": metas[-1]["retrieved_at"],
    }
    print(json.dumps(info), file=sys.stderr)
    return paths, {"files": metas}, cached_all


if __name__ == "__main__":
    collect()
