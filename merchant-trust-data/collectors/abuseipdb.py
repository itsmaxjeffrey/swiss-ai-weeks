"""AbuseIPDB collector — SCAFFOLD, key-ready (like zefix.py).

Free-tier API requires an API key (401 without; probe recorded 2026-09-24).
Get a free key at https://www.abuseipdb.com/account/api after signup, then
  export LEASH_ABUSEIPDB_KEY=<key>
and set abuseipdb.enabled=true in config/sources.json.

Endpoint used: GET /api/v2/check?ipAddress=<ip>&maxAgeInDays=90
Rate limits: free tier 1,000 checks/day — cached per IP, resume-safe.
License: AbuseIPDB terms — free tier is for non-commercial use with
attribution; responses should not be resold (see LICENSE_NOTES.md).
"""

from __future__ import annotations

import json
import os
import pathlib

import requests

from collectors import common


class MissingCredential(RuntimeError):
    pass


class AbuseIPDBClient:
    def __init__(self, token: str | None = None):
        cfg = common.CONFIG["abuseipdb"]
        self.api_base = cfg["api_base"].rstrip("/")
        self.token = token or os.environ.get(cfg.get("auth_env_var", "LEASH_ABUSEIPDB_KEY"))

    def _require_token(self) -> None:
        if not self.token:
            raise MissingCredential(
                "AbuseIPDB requires an API key (free). See DATA_SOURCES.md; "
                "export LEASH_ABUSEIPDB_KEY=<key> and set abuseipdb.enabled=true.")

    def check(self, ip: str, max_age_days: int = 90) -> dict:
        self._require_token()
        cache = common.raw_dir("abuseipdb") / f"check_{ip}.json"
        if cache.exists():
            return json.loads(cache.read_text())
        r = requests.get(
            f"{self.api_base}/check",
            params={"ipAddress": ip, "maxAgeInDays": max_age_days},
            headers={"Key": self.token, "Accept": "application/json",
                     "User-Agent": common.UA},
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        cache.write_text(json.dumps(data, indent=1))
        return data


def probe_unauthenticated() -> dict:
    """Record the no-key status for provenance (does not fetch any data)."""
    url = f"{common.CONFIG['abuseipdb']['api_base'].rstrip('/')}/check"
    try:
        r = requests.get(url, params={"ipAddress": "9.9.9.9", "maxAgeInDays": 1},
                         headers={"User-Agent": common.UA}, timeout=30)
        status = {"url": url, "status": r.status_code,
                  "expected_without_key": 401, "probed_at": common.utcnow()}
    except requests.RequestException as e:
        status = {"url": url, "status": None, "error": type(e).__name__,
                  "probed_at": common.utcnow()}
    common.raw_dir("abuseipdb").joinpath("probe_status.json").write_text(
        json.dumps({**status, "status": "BLOCKED-pending-key",
                    "key_env_var": "LEASH_ABUSEIPDB_KEY"}, indent=2))
    return status


def collect() -> tuple[str, dict, bool]:
    status = probe_unauthenticated()
    if status.get("status") != 200:
        raise MissingCredential(
            "abuseipdb BLOCKED pending free API key (probe recorded, "
            f"status={status.get('status')}). Register at "
            "https://www.abuseipdb.com/account/api, export LEASH_ABUSEIPDB_KEY, "
            "flip abuseipdb.enabled=true.")
    return "probe-ok", status, False


def _load_queue(limit: int | None = None) -> list[str]:
    q = common.raw_dir("abuseipdb") / "_ip_queue.json"
    if not q.exists():
        raise FileNotFoundError("missing data/raw/abuseipdb/_ip_queue.json")
    ips = json.loads(q.read_text())
    return ips if limit is None else ips[:limit]


def run_checks(max_fresh: int = 950, sleep_s: float = 1.1, limit: int | None = None) -> dict:
    """Check top IP-literal threat hosts (free tier: 1k/day), cached per IP.

    Cap-aware nightly resume: cached IPs are skipped WITHOUT sleeping and
    without counting against max_fresh — only fresh API calls count. Stops
    cleanly when max_fresh is reached or the API answers 429 (daily quota
    spent): no 429 error storms, and no lost IPs — uncached entries are
    simply retried by the next run. Failures are never cached (check()
    raises before the cache write).
    """
    import time
    client = AbuseIPDBClient()
    client._require_token()
    ips = _load_queue(limit)
    fresh = errors = skipped = 0
    cap_reached = False
    log = common.raw_dir("abuseipdb") / "_run.log"
    for ip in ips:
        if (common.raw_dir("abuseipdb") / f"check_{ip}.json").exists():
            skipped += 1
            continue
        if fresh >= max_fresh:
            cap_reached = True
            break
        try:
            data = client.check(ip)
            if isinstance(data.get("data"), dict):
                fresh += 1
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code == 429:
                cap_reached = True  # daily quota spent — resume tomorrow
                break
            errors += 1
        except Exception:  # noqa: BLE001 — log and continue
            errors += 1
        if fresh % 100 == 0:
            with log.open("a") as f:
                f.write(json.dumps({"fresh": fresh, "skipped": skipped,
                                    "errors": errors}) + "\n")
        time.sleep(sleep_s)
    queue_total = len(json.loads(
        (common.raw_dir("abuseipdb") / "_ip_queue.json").read_text()))
    stats = {"source": "abuseipdb", "checked": fresh, "ok": fresh,
             "errors": errors, "cached_skipped": skipped,
             "cap_reached": cap_reached,
             "remaining": max(0, queue_total - skipped - fresh - errors),
             "queue_total": queue_total}
    (common.raw_dir("abuseipdb") / "run_stats.json").write_text(json.dumps(stats, indent=2))
    return stats


def collect() -> tuple[str, dict, bool]:
    """update_all contract (path, meta, cached): run one cap-aware resume batch.

    Missing key raises MissingCredential -> update_all records 'blocked'
    (remediation stays visible without failing the batch). A spent daily
    quota is NOT an error: run_checks stops cleanly and we report cached=True
    so the batch moves on; uncached IPs are picked up by the next run.
    """
    stats = run_checks()
    meta = {
        "retrieved_at": common.utcnow(),
        "stats": stats,
        "note": "free tier 1000 checks/day; cap-aware per-IP cached resume",
    }
    return str(common.raw_dir("abuseipdb")), meta, stats.get("checked", 0) == 0


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-fresh", type=int, default=950,
                    help="max fresh API calls this run (free tier 1000/day; 950 headroom)")
    ap.add_argument("--limit", type=int, default=None,
                    help="only walk the first N queue entries (default: whole queue)")
    ap.add_argument("--sleep", type=float, default=1.1)
    a = ap.parse_args()
    print(json.dumps(run_checks(a.max_fresh, a.sleep, a.limit), indent=2))
