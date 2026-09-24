"""Sanctions list collectors: UN consolidated, OFAC SDN, SECO (via OpenSanctions mirror), EU (probed/blocked).

- UN:    https://scsanctions.un.org/resources/xml/en/consolidated.xml  (302 → follow)
- OFAC:  https://www.treasury.gov/ofac/downloads/sdn.csv  (bonus, US Treasury SDN)
- SECO:  SECO publishes no stable anonymous bulk CSV/XML URL we could find
         (seco.admin.ch is JS-rendered; verified 2026-09-24). OpenSanctions
         mirrors the SECO list and republishes the *original* `source.xml`
         plus normalized exports daily; data CC BY-SA 4.0 (OpenSanctions) /
         public Swiss federal data. We store `source.xml` as-is with a
         provenance sidecar naming the mirror.
- EU:    https://webgate.ec.europa.eu/fsd/resources/trade-sanctions/consolidated-list/
         sanctions_conso.csv now redirects to EU Login even with
         `?anonymous=true` (verified 2026-09-24, with cookie jar) →
         recorded BLOCKED-needs-login; probe status file kept.

All XML/CSV parsed at clean time; raw files streamed (UN consolidated.xml
is tens of MB — stream to .part then rename).
"""

from __future__ import annotations

import json
import sys

import requests

from collectors import common

EU_URL = ("https://webgate.ec.europa.eu/fsd/resources/trade-sanctions/"
          "consolidated-list/sanctions_conso.csv?anonymous=true")
OS_INDEX = "https://data.opensanctions.org/datasets/latest/ch_seco_sanctions/index.json"


def collect() -> tuple[str, dict, bool]:
    cfg = common.CONFIG["sanctions"]
    results = []
    last_err = None

    # --- UN consolidated.xml (streamed) ---
    try:
        path, meta, cached = common.get_stream(
            cfg["un_xml_url"], "sanctions_un", f"un_consolidated_{common.today()}.xml")
        results.append({"source": "sanctions_un", "bytes": meta["bytes"],
                        "sha256": meta["sha256"], "cached": cached})
    except requests.RequestException as e:
        last_err = e
        results.append({"source": "sanctions_un", "status": "error",
                        "error": f"{type(e).__name__}: {e}"})

    # --- OFAC SDN CSV (small) ---
    try:
        path, meta, cached = common.get(
            cfg["ofac_sdn_url"], "sanctions_ofac", f"ofac_sdn_{common.today()}.csv")
        results.append({"source": "sanctions_ofac", "bytes": meta["bytes"],
                        "sha256": meta["sha256"], "cached": cached})
    except requests.RequestException as e:
        last_err = e
        results.append({"source": "sanctions_ofac", "status": "error",
                        "error": f"{type(e).__name__}: {e}"})

    # --- SECO via OpenSanctions mirror: resolve latest source.xml ---
    try:
        r = requests.get(OS_INDEX, headers={"User-Agent": common.UA}, timeout=60)
        r.raise_for_status()
        idx = r.json()
        # find the source.xml artifact URL in the index (layout: {artifacts: {...}})
        src_url = None
        for v in idx.values():
            if isinstance(v, dict):
                for u in v.values():
                    if isinstance(u, str) and u.endswith("source.xml"):
                        src_url = u
            if isinstance(v, str) and v.endswith("source.xml"):
                src_url = v
        if not src_url:
            # fallback: regex the known artifacts path pattern from the dataset page
            r2 = requests.get("https://www.opensanctions.org/datasets/ch_seco_sanctions/",
                              headers={"User-Agent": common.UA}, timeout=60)
            import re
            m = re.search(r'https://data\.opensanctions\.org/artifacts/ch_seco_sanctions/[^" ]+source\.xml', r2.text)
            src_url = m.group(0) if m else None
        if not src_url:
            raise RuntimeError("no source.xml artifact found in OpenSanctions index")
        path, meta, cached = common.get_stream(
            src_url, "sanctions_seco", f"seco_source_{common.today()}.xml",
            cache_key=src_url)
        results.append({"source": "sanctions_seco", "via": "opensanctions_mirror",
                        "artifact_url": src_url, "bytes": meta["bytes"],
                        "sha256": meta["sha256"], "cached": cached})
    except (requests.RequestException, RuntimeError) as e:
        last_err = e
        results.append({"source": "sanctions_seco", "status": "error",
                        "error": f"{type(e).__name__}: {e}"})

    # --- EU: record the EU-Login wall probe (BLOCKED) ---
    try:
        s = requests.Session()
        s.headers.update({"User-Agent": common.UA})
        r = s.get(EU_URL, timeout=60, allow_redirects=True)
        body = r.text[:300]
        eu_status = {"url": EU_URL, "http_status": r.status_code,
                     "redirected_to_login": "EU Login" in body,
                     "probed_at": common.utcnow()}
        common.raw_dir("sanctions_eu").joinpath("probe_status.json").write_text(
            json.dumps({**eu_status, "status": "BLOCKED-needs-login"}, indent=2))
        results.append({"source": "sanctions_eu", **eu_status})
    except requests.RequestException as e:
        results.append({"source": "sanctions_eu", "status": "error",
                        "error": f"{type(e).__name__}: {e}"})

    print(json.dumps({"collected": results}), file=sys.stderr)
    if all(r.get("status") == "error" for r in results):
        raise last_err or RuntimeError("sanctions: all sources failed")
    return json.dumps(results), {"results": results}, False
