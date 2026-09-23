"""DNS enrichment (A / MX / TXT existence) via dnspython.

Three-state convention: True / False / None(lookup error) plus dns_error.
NXDOMAIN means the domain does not exist at all: A/MX/TXT = False,
dns_error = nxdomain. Results cached in data/raw/dns/dns_batch_<date>.json.
"""

from __future__ import annotations

import json
import sys
import time

from collectors import common


def enrich(domains: list[str]) -> dict[str, dict]:
    try:
        import dns.resolver
    except ImportError as e:
        raise RuntimeError("dnspython required: pip install dnspython") from e

    cfg = common.CONFIG["dns"]
    limit = int(cfg.get("max_domains", 400))
    timeout = float(cfg.get("timeout_seconds", 4))
    sleep_s = float(cfg.get("sleep_seconds", 0.05))

    resolver = dns.resolver.Resolver()
    resolver.lifetime = timeout
    resolver.timeout = min(2.0, timeout)

    results: dict[str, dict] = {}
    todo = list(dict.fromkeys(domains))[:limit]
    for i, d in enumerate(todo):
        rec: dict = {"domain": d, "dns_a_exists": None, "dns_mx_exists": None,
                     "dns_txt_exists": None, "dns_error": None}
        try:
            for rtype, key in (("A", "dns_a_exists"), ("MX", "dns_mx_exists"),
                               ("TXT", "dns_txt_exists")):
                try:
                    ans = resolver.resolve(d, rtype)
                    rec[key] = len(ans) > 0
                except dns.resolver.NoAnswer:
                    rec[key] = False
                except dns.resolver.NoNameservers:
                    rec["dns_error"] = "servfail"
                except dns.resolver.LifetimeTimeout:
                    rec["dns_error"] = "timeout"
                except Exception as e:  # noqa: BLE001
                    rec["dns_error"] = type(e).__name__.lower()
        except Exception:  # absolute safety net
            rec["dns_error"] = "resolver_error"
        if rec["dns_error"] == "nxdomain":
            rec.update({"dns_a_exists": False, "dns_mx_exists": False, "dns_txt_exists": False})
        results[d] = rec
        if sleep_s:
            time.sleep(sleep_s)
        if (i + 1) % 50 == 0:
            print(json.dumps({"source": "dns", "done": i + 1, "total": len(todo)}), file=sys.stderr)

    out = common.raw_dir("dns") / f"dns_batch_{common.today()}.json"
    out.write_text(json.dumps(results, indent=1))
    return results
