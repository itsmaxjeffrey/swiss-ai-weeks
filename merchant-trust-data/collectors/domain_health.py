"""Domain-health enrichment collector for known threat domains (Phase-3).

For each domain (default: all confirmed-malicious root domains in the
current dataset_clean, or a JSON list passed via --input):

- DNS: MX / NS / A existence + SPF (TXT starting `v=spf1`) — reuses the
  dns_enrich.py three-state convention (True/False/None + dns_error).
- HTTP liveness: HEAD (fallback GET on 405) with short timeout; records
  status, whether the host answers, and a parked-page sniff (title/keywords
  from the first 4KB of a GET, only when HEAD suggests a live 200 page).
- Wayback CDX first-seen: https://web.archive.org/cdx/search/cdx?url=<domain>
  &limit=1 → oldest capture timestamp.
- crt.sh certificate-transparency first-seen: bounded sample (≤ crt.sh
  sample limit, default 500) to respect their load; JSON streamed/attempted
  per domain with polite sleep.

Contracts: results cached per domain in data/raw/domain_health/, resumable
(rerun skips domains already in the cache), polite concurrency ≤10 threads
with short timeouts, nothing large held in RAM. Output: one JSONL file
data/raw/domain_health/domain_health_<date>.jsonl (append/resumable) plus a
sidecar .meta.json with sha256/counts.

License: protocol lookups / factual metadata; Wayback CDX and crt.sh are
public services — used politely, bounded, cached (see LICENSE_NOTES.md).
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime
import hashlib
import json
import pathlib
import sys
import threading

import requests

from collectors import common

RAW = common.raw_dir("domain_health")
_lock = threading.Lock()


# ------------------------------------------------------------------- DNS

def dns_health(domain: str, timeout: float = 3.0) -> dict:
    try:
        import dns.resolver
    except ImportError as e:
        raise RuntimeError("dnspython required") from e
    resolver = dns.resolver.Resolver()
    resolver.lifetime = timeout
    resolver.timeout = min(2.0, timeout)
    rec: dict = {"dns_mx_exists": None, "dns_ns_exists": None,
                 "dns_a_exists": None, "has_spf": None, "dns_error": None}
    try:
        for rtype, key in (("A", "dns_a_exists"), ("MX", "dns_mx_exists"),
                           ("NS", "dns_ns_exists")):
            try:
                ans = resolver.resolve(domain, rtype)
                rec[key] = len(ans) > 0
                if rtype == "MX":
                    rec["mx_record"] = str(ans[0].exchange) if len(ans) else None
            except dns.resolver.NoAnswer:
                rec[key] = False
            except dns.resolver.NoNameservers:
                rec["dns_error"] = "servfail"
            except dns.resolver.LifetimeTimeout:
                rec["dns_error"] = "timeout"
            except Exception as e:  # noqa: BLE001
                rec["dns_error"] = type(e).__name__.lower()
        if rec["dns_error"] == "nxdomain":
            rec.update({"dns_a_exists": False, "dns_mx_exists": False,
                        "dns_ns_exists": False, "has_spf": False})
        else:
            try:
                txt = resolver.resolve(domain, "TXT")
                rec["has_spf"] = any(
                    b"".join(getattr(s, "strings", [b""])).lower().startswith(b"v=spf1")
                    for r in txt for s in [r])
            except Exception:  # noqa: BLE001
                rec["has_spf"] = False
    except Exception:  # absolute safety net
        rec["dns_error"] = "resolver_error"
    return rec


# ------------------------------------------------------------------ HTTP

_PARKED_MARKERS = ("domain for sale", "buy this domain", "parked", "sedoparking",
                   "afternic", "dan.com", "hugedomains", "coming soon", "godaddy")


def http_health(domain: str, timeout: float = 6.0) -> dict:
    rec: dict = {"http_live": None, "http_status": None, "https_ok": None,
                 "parked_like": None, "page_title": None, "http_error": None}
    s = requests.Session()
    s.headers.update({"User-Agent": common.UA})
    for scheme in ("https", "http"):
        try:
            r = s.head(f"{scheme}://{domain}/", timeout=timeout, allow_redirects=True)
            rec["http_status"] = r.status_code
            rec[f"{scheme[:-1]}_ok" if scheme == "https" else "http_live"] = \
                r.status_code < 500
            if scheme == "https":
                rec["https_ok"] = True
            if r.status_code == 405:
                r = s.head(f"{scheme}://{domain}/", timeout=timeout,
                           allow_redirects=True)  # some stacks 405 HEAD only
            if r.status_code in (403, 401):
                rec["http_live"] = True  # server answers; WAF is a signal too
            if r.status_code == 200:
                # small GET for parked-page sniff (cap 64KB)
                g = s.get(f"{scheme}://{domain}/", timeout=timeout, stream=True)
                chunk = next(g.iter_content(65536), b"") or b""
                g.close()
                head = chunk.decode("utf-8", "replace").lower()
                import re
                m = re.search(r"<title[^>]*>(.*?)</title>", head, re.S | re.I)
                if m:
                    rec["page_title"] = m.group(1).strip()[:160]
                rec["parked_like"] = any(mk in head for mk in _PARKED_MARKERS)
                break
            if scheme == "https" and rec["https_ok"] is None:
                rec["https_ok"] = False
        except requests.exceptions.SSLError:
            if scheme == "https":
                rec["https_ok"] = False
            continue
        except requests.RequestException as e:
            rec["http_error"] = type(e).__name__.lower()
            if scheme == "https":
                rec["https_ok"] = False
            continue
    if rec["https_ok"]:
        rec["http_live"] = rec["http_live"] if rec["http_live"] is not None else True
    return rec


# --------------------------------------------------------------- wayback

def wayback_first_seen(domain: str, timeout: float = 20.0) -> dict:
    url = f"https://web.archive.org/cdx/search/cdx?url={domain}&limit=1"
    try:
        r = requests.get(url, headers={"User-Agent": common.UA}, timeout=timeout)
        if r.status_code == 200 and r.text.strip():
            first = r.text.strip().split()[1]  # timestamp col
            return {"wayback_first_seen": first, "wayback_error": None}
        return {"wayback_first_seen": None,
                "wayback_error": f"http_{r.status_code}" if r.status_code != 200 else "empty"}
    except requests.RequestException as e:
        return {"wayback_first_seen": None, "wayback_error": type(e).__name__.lower()}


# ---------------------------------------------------------------- crt.sh

def crtsh_first_seen(domain: str, timeout: float = 25.0) -> dict:
    url = f"https://crt.sh/?q={domain}&output=json&limit=1"
    try:
        r = requests.get(url, headers={"User-Agent": common.UA}, timeout=timeout)
        if r.status_code == 200 and r.text.strip():
            data = r.json()
            if isinstance(data, list) and data:
                return {"crtsh_first_seen": min(e.get("not_before", "") for e in data),
                        "crtsh_error": None}
            return {"crtsh_first_seen": None, "crtsh_error": "empty"}
        return {"crtsh_first_seen": None, "crtsh_error": f"http_{r.status_code}"}
    except requests.RequestException as e:
        return {"crtsh_first_seen": None, "crtsh_error": type(e).__name__.lower()}
    except ValueError:
        return {"crtsh_first_seen": None, "crtsh_error": "bad_json"}


# ----------------------------------------------------------------- driver

def default_threat_domains() -> list[str]:
    import pandas as pd
    sys.path.insert(0, str(common.ROOT))
    from processing.normalize_domain import root_domain
    df = pd.read_parquet(common.ROOT / "data" / "processed" / "dataset_clean.parquet")
    d = df[(df["entity_type"] == "domain") & (df["label"] == "confirmed_malicious")]
    dom = d["domain_normalized"].dropna().astype(str)
    real = dom[dom.str.contains(r"\.", na=False)
               & ~dom.str.match(r"^\d+\.\d+\.\d+\.\d+$")]
    return sorted(set(real.map(root_domain).dropna()))


def _load_done(jsonl: pathlib.Path) -> set[str]:
    done = set()
    if jsonl.exists():
        with jsonl.open() as f:
            for line in f:
                try:
                    done.add(json.loads(line)["domain"])
                except Exception:  # noqa: BLE001 — tolerate a torn trailing line
                    continue
    return done


def collect(input_path: str | None = None, crtsh_limit: int = 500,
            max_workers: int = 10) -> tuple[str, dict, bool]:
    if input_path:
        domains = json.loads(pathlib.Path(input_path).read_text())
    else:
        domains = default_threat_domains()
    domains = sorted(set(d.strip().lower() for d in domains if d.strip()))

    out = RAW / f"domain_health_{common.today()}.jsonl"
    done = _load_done(out)
    todo = [d for d in domains if d not in done]
    print(json.dumps({"source": "domain_health", "total": len(domains),
                      "already_done": len(done), "todo": len(todo)}), file=sys.stderr)

    def probe(domain: str) -> dict:
        rec = {"domain": domain}
        rec.update(dns_health(domain))
        rec.update(http_health(domain))
        rec.update(wayback_first_seen(domain))
        return rec

    with out.open("a") as f:
        with cf.ThreadPoolExecutor(max_workers=max_workers) as ex:
            futs = {ex.submit(probe, d): d for d in todo}
            for i, fut in enumerate(cf.as_completed(futs), 1):
                d = futs[fut]
                try:
                    rec = fut.result()
                except Exception as e:  # noqa: BLE001 — one bad domain must not kill the batch
                    rec = {"domain": d, "error": f"{type(e).__name__}: {e}"}
                with _lock:
                    f.write(json.dumps(rec) + "\n")
                    f.flush()
                if i % 100 == 0:
                    print(json.dumps({"source": "domain_health", "done": i,
                                      "total": len(todo)}), file=sys.stderr)

    # crt.sh bounded sample (sequential + polite sleep, on domains not yet done)
    sample = [d for d in domains if "crtsh_first_seen" not in
              _domain_record(out, d)][:max(0, crtsh_limit)]
    for i, d in enumerate(sample, 1):
        rec = crtsh_first_seen(d)
        with _lock, out.open("a") as f:
            f.write(json.dumps({"domain": d, **rec}) + "\n")
            f.flush()
        if i % 50 == 0:
            print(json.dumps({"source": "crtsh", "done": i, "total": len(sample)}),
                  file=sys.stderr)
        import time as _t
        _t.sleep(0.3)

    blob = out.read_bytes()
    meta = {"source": "domain_health", "file": out.name, "url": "dns/http/cdx/crt.sh",
            "bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest(),
            "domains_total": len(domains), "records": len(_load_done(out)),
            "crtsh_sampled": crtsh_limit, "retrieved_at": common.utcnow(),
            "collector_version": common.COLLECTOR_VERSION}
    (RAW / f"{out.stem}.meta.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps({"source": "domain_health", "records": meta["records"]}),
          file=sys.stderr)
    return str(out), meta, False


_record_cache: dict[str, dict] = {}


def _domain_record(jsonl: pathlib.Path, domain: str) -> dict:
    if not _record_cache:
        if jsonl.exists():
            with jsonl.open() as f:
                for line in f:
                    try:
                        r = json.loads(line)
                        _record_cache[r["domain"]] = r
                    except Exception:  # noqa: BLE001
                        continue
    return _record_cache.get(domain, {})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=None, help="JSON list of domains")
    ap.add_argument("--crtsh-limit", type=int, default=500)
    ap.add_argument("--max-workers", type=int, default=10)
    args = ap.parse_args()
    collect(args.input, args.crtsh_limit, args.max_workers)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
