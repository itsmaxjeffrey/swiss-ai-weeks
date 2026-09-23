"""Zefix (Swiss central business index) collector — INTERFACE ONLY until token.

The public REST API requires a registered (free) API token:
  - Request access / info: *** (official Federal Office of
    Justice contact, verified on bj.admin.ch 2026-09-23)
  - API docs (Swagger): https://www.zefix.admin.ch/ZefixPublicREST/swagger-ui/index.html
  Unauthenticated calls return 401 (verified 2026-09-23).

Token-free alternative (official): opendata.swiss dataset "Zefix – Zentraler
Firmenindex" exposes daily core data (name, seat, domicile of active entities)
queryable via SPARQL on Lindas.

Set the token in the environment variable configured under
config/sources.json -> zefix.auth_env_var (default LEASH_ZEFIX_TOKEN),
then flip zefix.enabled to true.

Data (c) Swiss Confederation / cantons; respect Zefix terms of use.
"""

from __future__ import annotations

import json
import os

import requests

from collectors import common


class MissingCredential(RuntimeError):
    pass


class ZefixClient:
    def __init__(self, token: str | None = None):
        cfg = common.CONFIG["zefix"]
        self.api_base = cfg["api_base"]
        self.token = token or os.environ.get(cfg.get("auth_env_var", "LEASH_ZEFIX_TOKEN"))

    def _require_token(self) -> None:
        if not self.token:
            raise MissingCredential(
                "Zefix API requires a registered token (free). See DATA_SOURCES.md; "
                "export LEASH_ZEFIX_TOKEN=<token> and set zefix.enabled=true."
            )

    def search(self, name: str, max_entries: int = 100) -> dict:
        self._require_token()
        url = f"{self.api_base}/company/search"
        r = requests.post(
            url,
            json={"name": name, "maxEntries": max_entries},
            headers={
                "Authorization": f"Token {self.token}",
                "User-Agent": common.UA,
                "Content-Type": "application/json",
            },
            timeout=30,
        )
        r.raise_for_status()
        return r.json()

    def detail(self, uid: str) -> dict:
        self._require_token()
        url = f"{self.api_base}/company/{uid}"
        r = requests.get(
            url,
            headers={"Authorization": f"Token {self.token}", "User-Agent": common.UA},
            timeout=30,
        )
        r.raise_for_status()
        return r.json()


def probe_unauthenticated() -> dict:
    """Record the no-token status for provenance (does not fetch any data)."""
    url = f"{common.CONFIG['zefix']['api_base']}/company/search"
    try:
        r = requests.post(url, json={"name": "test"}, headers={"User-Agent": common.UA}, timeout=20)
        return {"url": url, "status": r.status_code,
                "conclusion": "token required" if r.status_code == 401 else f"unexpected {r.status_code}"}
    except Exception as e:  # network error
        return {"url": url, "status": None, "conclusion": f"error: {e}"}


if __name__ == "__main__":
    print(json.dumps(probe_unauthenticated(), indent=2))
