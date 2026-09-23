"""HackAPrompt collector (Hugging Face: hackaprompt/hackaprompt-dataset).

The dataset is GATED on HF (auto-approved access): a token that has accepted
the dataset terms must be provided via LEASH_HF_TOKEN. Without it this
collector records a blocked status instead of failing the pipeline.
"""

from __future__ import annotations

import json
import os
import sys

from collectors import common


def collect() -> tuple[str | None, dict, bool]:
    cfg = common.CONFIG["hackaprompt"]
    token = os.environ.get(cfg["auth_env_var"])
    if not token:
        status = {
            "source": "hackaprompt",
            "status": "blocked",
            "reason": f"gated HF dataset; export {cfg['auth_env_var']} (accept terms at "
                      "https://huggingface.co/datasets/hackaprompt/hackaprompt-dataset)",
        }
        (common.raw_dir("hackaprompt") / f"blocked_{common.today()}.json").write_text(
            json.dumps(status, indent=2)
        )
        print(json.dumps(status), file=sys.stderr)
        return None, status, False

    headers = {"Authorization": f"Bearer {token}"}
    filename = "hackaprompt.parquet"
    path, meta, cached = common.get_stream(
        f"https://huggingface.co/datasets/{cfg['hf_repo']}/resolve/main/{cfg['files'][0]}",
        "hackaprompt", filename, headers=headers, timeout=300,
    )
    info = {
        "source": "hackaprompt",
        "bytes": meta["bytes"],
        "cached": cached,
        "retrieved_at": meta["retrieved_at"],
        "sha256": meta["sha256"],
    }
    print(json.dumps(info), file=sys.stderr)
    return str(path), meta, cached


if __name__ == "__main__":
    collect()
