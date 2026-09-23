"""ULB Credit Card Fraud collector via OpenML (did 1597, file_id 1673544).

Kaggle-original needs credentials; OpenML hosts the identical dataset
(284,807 rows, 492 frauds) as ARFF. Verified by the clean step.
"""

from __future__ import annotations

import json
import sys

from collectors import common


def collect() -> tuple[str, dict, bool]:
    cfg = common.CONFIG["ulb_creditcard"]
    filename = f"ulb_creditcard_{common.today()}.arff"
    path, meta, cached = common.get_stream(cfg["arff_url"], "ulb_creditcard", filename, timeout=300)
    info = {
        "source": "ulb_creditcard",
        "bytes": meta["bytes"],
        "cached": cached,
        "retrieved_at": meta["retrieved_at"],
        "sha256": meta["sha256"],
    }
    print(json.dumps(info), file=sys.stderr)
    return str(path), meta, cached


if __name__ == "__main__":
    collect()
