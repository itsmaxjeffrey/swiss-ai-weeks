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
