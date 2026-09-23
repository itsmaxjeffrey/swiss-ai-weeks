"""Shared collector plumbing: polite HTTP, raw-file caching, provenance sidecars.

Rules encoded here (see LICENSE_NOTES.md / DATA_SOURCES.md):
- Every download lands in data/raw/<source>/ with a .meta.json sidecar
  recording url, retrieved_at, sha256, collector_version.
- Identical requests are served from cache (resumable pipelines, no
  unnecessary re-downloads).
- One polite global User-Agent; no identity rotation, no captcha evasion.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import pathlib
import time

import requests

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "raw"
CONFIG_PATH = ROOT / "config" / "sources.json"
CONFIG = json.loads(CONFIG_PATH.read_text())

COLLECTOR_VERSION = "0.1.0"
UA = "LEASH-merchant-trust-data/0.1 (open-data research; cached, rate-limited, no-bypass)"


def raw_dir(source: str) -> pathlib.Path:
    d = RAW_DIR / source
    d.mkdir(parents=True, exist_ok=True)
    return d


def today() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")


def utcnow() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _request_key(url: str, params: dict | None, headers: dict | None) -> str:
    blob = json.dumps({"url": url, "params": params or {}, "headers": headers or {}}, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()


def get(
    url: str,
    source: str,
    filename: str,
    params: dict | None = None,
    headers: dict | None = None,
    timeout: int = 60,
    session: requests.Session | None = None,
    sleep_seconds: float = 0.0,
    overwrite: bool = False,
    cache_key: str | None = None,
) -> tuple[pathlib.Path, dict, bool]:
    """GET a URL into data/raw/<source>/<filename> with a provenance sidecar.

    Returns (path, meta, cached). Cache hit requires the same request key AND
    an existing file, so pipelines are resumable without re-downloading.
    `cache_key` overrides the derived request key (e.g. to decouple the cache
    identity from redirect-target URLs).
    """
    s = session or requests.Session()
    s.headers.update({"User-Agent": UA})
    if headers:
        s.headers.update(headers)

    d = raw_dir(source)
    meta_path = d / f"{filename}.meta.json"
    key = cache_key or _request_key(url, params, headers)

    if not overwrite and meta_path.exists():
        try:
            old = json.loads(meta_path.read_text())
            if old.get("request_key") == key and (d / old["file"]).exists():
                return d / old["file"], old, True
        except Exception:
            pass

    if sleep_seconds:
        time.sleep(sleep_seconds)

    r = s.get(url, params=params, timeout=timeout)
    r.raise_for_status()

    path = d / filename
    path.write_bytes(r.content)
    meta = {
        "source": source,
        "url": str(r.url),
        "file": filename,
        "http_status": r.status_code,
        "bytes": len(r.content),
        "sha256": hashlib.sha256(r.content).hexdigest(),
        "retrieved_at": utcnow(),
        "request_key": key,
        "collector_version": COLLECTOR_VERSION,
        "final_url": str(r.url),
    }
    meta_path.write_text(json.dumps(meta, indent=2))
    return path, meta, False


def get_stream(
    url: str,
    source: str,
    filename: str,
    headers: dict | None = None,
    timeout: int = 180,
    chunk_size: int = 1 << 20,
    session: requests.Session | None = None,
    sleep_seconds: float = 0.0,
    overwrite: bool = False,
    cache_key: str | None = None,
) -> tuple[pathlib.Path, dict, bool]:
    """Streaming GET for large files (same sidecar/caching contract as get).

    Writes chunk-by-chunk to <filename>.part then atomically renames, so an
    interrupted download never poisons the cache. Use for anything >50MB.
    """
    s = session or requests.Session()
    s.headers.update({"User-Agent": UA})
    if headers:
        s.headers.update(headers)

    d = raw_dir(source)
    meta_path = d / f"{filename}.meta.json"
    key = cache_key or _request_key(url, {}, headers or {})

    if not overwrite and meta_path.exists():
        try:
            old = json.loads(meta_path.read_text())
            if old.get("request_key") == key and (d / old["file"]).exists():
                return d / old["file"], old, True
        except Exception:
            pass

    if sleep_seconds:
        time.sleep(sleep_seconds)

    tmp = d / f"{filename}.part"
    hasher = hashlib.sha256()
    total = 0
    with s.get(url, stream=True, timeout=timeout) as r:
        r.raise_for_status()
        with tmp.open("wb") as f:
            for chunk in r.iter_content(chunk_size=chunk_size):
                if not chunk:
                    continue
                f.write(chunk)
                hasher.update(chunk)
                total += len(chunk)

    path = d / filename
    tmp.replace(path)
    meta = {
        "source": source,
        "url": str(r.url),
        "file": filename,
        "http_status": r.status_code,
        "bytes": total,
        "sha256": hasher.hexdigest(),
        "retrieved_at": utcnow(),
        "request_key": key,
        "collector_version": COLLECTOR_VERSION,
        "final_url": str(r.url),
    }
    meta_path.write_text(json.dumps(meta, indent=2))
    return path, meta, False


def extract_tarball(archive: pathlib.Path, source: str, members: list[str] | None = None) -> pathlib.Path:
    """Extract a tar.gz into data/raw/<source>/extracted/ (idempotent).

    `members` optionally restricts extracted top-level paths (prefix match).
    Returns the extraction root.
    """
    import tarfile

    out = raw_dir(source) / "extracted"
    if out.exists() and any(out.iterdir()):
        return out
    out.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as tf:
        if members:
            tf.extractall(out, filter="data", members=[m for m in tf.getmembers() if m.name.startswith(tuple(members))])
        else:
            tf.extractall(out, filter="data")
    return out
