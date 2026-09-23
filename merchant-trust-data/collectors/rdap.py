"""RDAP domain registration-data collector (prefer RDAP over legacy WHOIS).

Endpoint: https://rdap.org/domain/{domain} (redirects to authoritative
registry RDAP, e.g. rdap.nic.ch for .ch, Verisign for .com).

Policy:
- cached per domain (resume-safe, no repeated queries for the same domain)
- polite fixed sleep between queries; no identity rotation
- 404 => domain not registered (recorded as rdap_status=not_found)
- non-JSON / rate-limit responses recorded, never retried in a tight loop
"""

from __future__ import annotations

import json
import pathlib
import sys

import requests

from collectors import common


def enrich(domains: list[str]) -> dict[str, dict]:
    cfg = common.CONFIG["rdap"]
    limit = int(cfg.get("max_domains", 250))
    sleep_s = float(cfg.get("sleep_seconds", 0.8))
    timeout = int(cfg.get("timeout_seconds", 25))
    session = requests.Session()
    results: dict[str, dict] = {}

    todo = list(dict.fromkeys(domains))[:limit]
    for i, d in enumerate(todo):
        filename = f"rdap_{d}.json"
        path = common.raw_dir("rdap") / filename
        if path.exists():
            try:
                results[d] = json.loads(path.read_text())
                continue
            except Exception:
                pass
        try:
            p, meta, _ = common.get(
                cfg["endpoint"].format(domain=d), "rdap", filename,
                timeout=timeout, session=session, sleep_seconds=sleep_s,
                cache_key=f"rdap:{d}",
            )
            doc = json.loads(p.read_text())
            results[d] = doc
        except requests.HTTPError as e:
            code = e.response.status_code if e.response is not None else None
            if code == 404:
                doc = {"domain": d, "rdap_status": "not_found"}
            else:
                doc = {"domain": d, "rdap_status": f"http_{code}"}
            _save(doc, filename)
            results[d] = doc
        except Exception as e:
            doc = {"domain": d, "rdap_status": "error", "error": str(e)[:200]}
            _save(doc, filename)
            results[d] = doc
        if (i + 1) % 25 == 0:
            print(json.dumps({"source": "rdap", "done": i + 1, "total": len(todo)}), file=sys.stderr)
    return results


def _save(doc: dict, filename: str) -> None:
    (common.raw_dir("rdap") / filename).write_text(json.dumps(doc))
