"""Dataset build orchestrator.

Usage (from repo root, venv active):
  python -m processing.build_dataset collect   # downloads (cached/resumable)
  python -m processing.build_dataset enrich    # bounded RDAP + DNS enrichment
  python -m processing.build_dataset build     # parquet datasets + report

dataset_raw.parquet      one row per source record (pre-dedupe), raw_json kept
dataset_clean.parquet    entity-level, deduped, validated, labels applied
dataset_features.parquet clean + RDAP/DNS/lookalike/age features
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import json
import pathlib
import sys

from schemas.canonical_schema import ALL_COLUMNS, LABELS, build_feature_object, new_row
from collectors import common, openphish, urlhaus, gleif as gleif_col, zefix
from processing import entity_resolution, labeling
from processing.feature_engineering import company_age_days, domain_age_days, parse_rdap_doc
from processing.lookalike_detection import analyze_domain
from processing.normalize_company import normalize_company_name
from processing.normalize_domain import normalize_domain, root_domain

ROOT = common.ROOT
INTER = ROOT / "data" / "intermediate"
PROCESSED = ROOT / "data" / "processed"
SAMPLES = ROOT / "data" / "samples"


def _write_jsonl(path: pathlib.Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False, default=str) + "\n")


def _read_jsonl(path: pathlib.Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


# ---------------------------------------------------------------- collectors

def step_collect() -> None:
    INTER.mkdir(parents=True, exist_ok=True)

    # --- OpenPhish
    urls, op_meta, _ = openphish.collect()
    op_rows = []
    for u in urls:
        d = normalize_domain(u)
        op_rows.append({
            "root_domain": root_domain(d), "domain": d, "url": u,
            "source": "openphish", "threat_type": "phishing",
            "first_seen": op_meta["retrieved_at"][:10], "last_seen": op_meta["retrieved_at"][:10],
            "url_source": "OpenPhish community feed",
        })
    _write_jsonl(INTER / "openphish_records.jsonl", op_rows)

    # --- URLhaus
    csv_path, uh_meta, _ = urlhaus.collect()
    uh_rows = []
    # the dump starts with '#' comment lines; the column header is one of them
    header = None
    body: list[str] = []
    with open(csv_path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("#"):
                candidate = line.lstrip("# ").strip()
                if candidate.startswith("id,"):
                    header = candidate.split(",")
            else:
                body.append(line)
    for row in csv.DictReader(io.StringIO("".join(body)), fieldnames=header):
        u = row.get("url") or ""
        d = normalize_domain(u)
        first = (row.get("date_added") or "")[:10] or uh_meta["retrieved_at"][:10]
        uh_rows.append({
            "root_domain": root_domain(d), "domain": d, "url": u,
            "source": "urlhaus", "threat_type": f"malware:{row.get('threat') or 'unknown'}",
            "first_seen": first, "last_seen": first,
            "url_source": row.get("urlhaus_link") or "https://urlhaus.abuse.ch/",
            "tags": row.get("tags"), "url_status": row.get("url_status"),
        })
    _write_jsonl(INTER / "urlhaus_records.jsonl", uh_rows)

    # --- GLEIF CH
    for country in common.CONFIG["gleif"]["countries"]:
        recs = gleif_col.collect(country)
        _write_jsonl(INTER / f"gleif_{country.lower()}_records.jsonl", recs)
        print(json.dumps({"source": "gleif", "country": country, "records": len(recs)}), file=sys.stderr)

    # --- Zefix: record access status (no data without token)
    probe = zefix.probe_unauthenticated()
    (common.raw_dir("zefix") / f"probe_{common.today()}.json").write_text(json.dumps(probe, indent=2))
    print(json.dumps({"source": "zefix", "status": probe}), file=sys.stderr)


def step_enrich() -> None:
    """Bounded RDAP + DNS enrichment over known threat domains (cached/resumable)."""
    from collectors import rdap, dns_enrich

    op_rows = _read_jsonl(INTER / "openphish_records.jsonl")
    uh_rows = _read_jsonl(INTER / "urlhaus_records.jsonl")
    domains = []
    for r in op_rows + uh_rows:
        if r.get("root_domain") and r["root_domain"] not in domains:
            domains.append(r["root_domain"])

    print(json.dumps({"enrich": "rdap", "domains": min(len(domains), int(common.CONFIG["rdap"]["max_domains"]))}), file=sys.stderr)
    rdap.enrich(domains)
    dns_enrich.enrich(domains)
    print(json.dumps({"enrich": "done", "candidate_domains": len(domains)}), file=sys.stderr)


# --------------------------------------------------------------- build steps

def _gleif_attr(rec: dict) -> dict:
    a = rec.get("attributes") or {}
    ent = a.get("entity") or {}
    legal_addr = ent.get("legalAddress") or {}
    hq = ent.get("headquartersAddress") or {}
    # registration block lives at top level (attributes.registration); dates
    # fall back to entity.creationDate when the block is null
    reg = a.get("registration") or ent.get("registration") or {}
    legal_name = ent.get("legalName")
    if isinstance(legal_name, dict):
        legal_name = legal_name.get("name")
    lf = ent.get("legalForm") or {}
    if isinstance(lf, dict):
        legal_form = lf.get("name") or lf.get("id") or lf.get("other")
    else:
        legal_form = lf
    registered_as = ent.get("registeredAs")
    # Swiss UID (CHE-###.###.###) doubles as vat_uid when present
    vat_uid = registered_as if isinstance(registered_as, str) and registered_as.upper().startswith("CHE-") else None
    return {
        "lei": a.get("lei"),
        "legal_company_name": legal_name,
        "entity_status": ent.get("status"),
        "legal_form": legal_form,
        "incorporation_date": (reg.get("initialRegistrationDate") or ent.get("creationDate") or "")[:10] or None,
        "registry_last_updated": (reg.get("lastUpdateDate") or "")[:10] or None,
        "registered_address": " ".join(legal_addr.get("addressLines") or []) or None,
        "registered_country": legal_addr.get("country"),
        "registered_city": legal_addr.get("city"),
        "region": legal_addr.get("region"),
        "postal_code": legal_addr.get("postalCode"),
        "country": hq.get("country") or legal_addr.get("country"),
        "city": hq.get("city") or legal_addr.get("city"),
        "vat_uid": vat_uid,
    }


def step_build() -> None:
    import pandas as pd

    PROCESSED.mkdir(parents=True, exist_ok=True)
    SAMPLES.mkdir(parents=True, exist_ok=True)
    now = common.utcnow()
    today = common.today()

    # ---------------- RAW: one row per source record
    raw_rows: list[dict] = []

    op_records = _read_jsonl(INTER / "openphish_records.jsonl")
    for r in op_records:
        raw_rows.append(new_row(
            entity_type="domain", domain=r["domain"], domain_normalized=r["domain"],
            openphish_hit=True, known_bad_domain=True,
            threat_sources="openphish", threat_types="phishing",
            threat_first_seen=r["first_seen"], threat_last_seen=r["last_seen"],
            threat_sample_urls=";".join([r["url"]]),
            label="confirmed_malicious", label_confidence=labeling.OPENPHISH_CONF,
            label_source="openphish",
            label_reason="URL present in OpenPhish confirmed phishing community feed.",
            sources="openphish",
            source_urls="https://openphish.com/feed.txt",
            collected_at=now, last_verified_at=now,
            collector_version=common.COLLECTOR_VERSION,
            data_license="OpenPhish community feed (non-commercial, attribution)",
            entity_key=r["root_domain"], raw_json=json.dumps(r, ensure_ascii=False),
        ))

    uh_records = _read_jsonl(INTER / "urlhaus_records.jsonl")
    for r in uh_records:
        raw_rows.append(new_row(
            entity_type="domain", domain=r["domain"], domain_normalized=r["domain"],
            urlhaus_hit=True, known_bad_domain=True,
            threat_sources="urlhaus",
            threat_types=r.get("threat_type") or "malware",
            threat_first_seen=r["first_seen"], threat_last_seen=r["last_seen"],
            threat_sample_urls=r["url"],
            label="confirmed_malicious", label_confidence=labeling.URLHAUS_CONF,
            label_source="urlhaus",
            label_reason="URL present in abuse.ch URLhaus recent malware feed.",
            sources="urlhaus",
            source_urls=r.get("url_source") or "https://urlhaus.abuse.ch/",
            collected_at=now, last_verified_at=now,
            collector_version=common.COLLECTOR_VERSION,
            data_license="abuse.ch URLhaus (free, attribution appreciated)",
            entity_key=r["root_domain"], raw_json=json.dumps(r, ensure_ascii=False),
        ))

    gleif_records = _read_jsonl(INTER / "gleif_ch_records.jsonl")
    for rec in gleif_records:
        a = _gleif_attr(rec)
        lbl, conf, lsrc, lreason = labeling.label_gleif(a["entity_status"])
        raw_rows.append(new_row(
            entity_type="company",
            merchant_name=a["legal_company_name"],
            normalized_merchant_name=normalize_company_name(a["legal_company_name"]),
            legal_company_name=a["legal_company_name"],
            country=a["country"], region=a["region"], city=a["city"],
            street_address=None, postal_code=a["postal_code"],
            registry_found=True, registry_lookup_status="ok",
            registry_source="gleif", registry_id=a["lei"], lei=a["lei"],
            vat_uid=a.get("vat_uid"),
            company_status=a["entity_status"], legal_form=a["legal_form"],
            incorporation_date=a["incorporation_date"],
            company_age_days=company_age_days(a["incorporation_date"]),
            registered_address=a["registered_address"],
            registered_country=a["registered_country"],
            registered_city=a["registered_city"],
            registry_last_updated=a["registry_last_updated"],
            label=lbl, label_confidence=conf, label_source=lsrc, label_reason=lreason,
            sources="gleif", source_urls="https://api.gleif.org/api/v1/lei-records",
            collected_at=now, last_verified_at=now,
            collector_version=common.COLLECTOR_VERSION,
            data_license="GLEIF LEI data (free and open, GLEIF terms of use)",
            entity_key=f"lei:{a['lei']}", raw_json=json.dumps(rec, ensure_ascii=False),
        ))

    raw_df = pd.DataFrame(raw_rows, columns=ALL_COLUMNS)
    raw_df.to_parquet(PROCESSED / "dataset_raw.parquet", index=False)

    # ---------------- CLEAN: entity-level dedupe + validation
    merged = entity_resolution.merge_threat_records(op_records + uh_records)
    threat_by_root = {m["entity_key"]: m for m in merged}

    clean_rows: list[dict] = []
    # threat entities (deduped by root domain across sources)
    for root, m in threat_by_root.items():
        srcs = set(m["sources"])
        lbl, conf, lsrc, lreason = labeling.label_threat(srcs)
        clean_rows.append(new_row(
            entity_type="domain", domain=m["root_domain"], domain_normalized=m["root_domain"],
            openphish_hit="openphish" in srcs, urlhaus_hit="urlhaus" in srcs,
            known_bad_domain=True,
            phishing_database_hits=1 if "openphish" in srcs else 0,
            malware_database_hits=1 if "urlhaus" in srcs else 0,
            threat_sources=";".join(m["sources"]),
            threat_types=";".join(m["threat_types"]),
            threat_first_seen=m["first_seen"], threat_last_seen=m["last_seen"],
            threat_sample_urls=";".join(m["urls"][:3]),
            label=lbl, label_confidence=conf, label_source=lsrc, label_reason=lreason,
            sources=";".join(m["sources"]),
            source_urls=";".join(dict.fromkeys(m["url_sources"])) or "https://openphish.com/feed.txt;https://urlhaus.abuse.ch/",
            collected_at=now, last_verified_at=now,
            collector_version=common.COLLECTOR_VERSION,
            data_license="OpenPhish community feed; abuse.ch URLhaus",
            entity_key=root, raw_json=json.dumps(m, ensure_ascii=False, default=str),
        ))
    # gleif entities (unique by LEI)
    seen_lei: set[str] = set()
    for rec in gleif_records:
        a = _gleif_attr(rec)
        if not a["lei"] or a["lei"] in seen_lei:
            continue
        seen_lei.add(a["lei"])
        lbl, conf, lsrc, lreason = labeling.label_gleif(a["entity_status"])
        clean_rows.append(new_row(
            entity_type="company",
            merchant_name=a["legal_company_name"],
            normalized_merchant_name=normalize_company_name(a["legal_company_name"]),
            legal_company_name=a["legal_company_name"],
            country=a["country"], region=a["region"], city=a["city"],
            postal_code=a["postal_code"],
            registry_found=True, registry_lookup_status="ok",
            registry_source="gleif", registry_id=a["lei"], lei=a["lei"],
            vat_uid=a.get("vat_uid"),
            company_status=a["entity_status"], legal_form=a["legal_form"],
            incorporation_date=a["incorporation_date"],
            company_age_days=company_age_days(a["incorporation_date"]),
            registered_address=a["registered_address"],
            registered_country=a["registered_country"],
            registered_city=a["registered_city"],
            registry_last_updated=a["registry_last_updated"],
            label=lbl, label_confidence=conf, label_source=lsrc, label_reason=lreason,
            sources="gleif", source_urls="https://api.gleif.org/api/v1/lei-records",
            collected_at=now, last_verified_at=now,
            collector_version=common.COLLECTOR_VERSION,
            data_license="GLEIF LEI data (free and open, GLEIF terms of use)",
            entity_key=f"lei:{a['lei']}", raw_json=None,
        ))

    clean_rows = entity_resolution.dedupe_by_entity_key(clean_rows)
    for r in clean_rows:
        r["merchant_id"] = entity_resolution.merchant_id_for(r["entity_key"])

    clean_df = pd.DataFrame(clean_rows, columns=ALL_COLUMNS)

    # validation
    problems: list[str] = []
    if clean_df["merchant_id"].duplicated().any():
        problems.append("duplicate merchant_id")
    bad_labels = set(clean_df["label"].dropna()) - set(LABELS)
    if bad_labels:
        problems.append(f"invalid labels: {sorted(bad_labels)}")
    missing_prov = clean_df["sources"].isna().sum() + clean_df["collected_at"].isna().sum()
    if missing_prov:
        problems.append(f"{missing_prov} rows missing provenance")
    if problems:
        print(json.dumps({"validation_problems": problems}), file=sys.stderr)

    clean_df = clean_df.convert_dtypes()
    clean_df.to_parquet(PROCESSED / "dataset_clean.parquet", index=False)

    # ---------------- FEATURES: RDAP + DNS + lookalike
    feat_df = clean_df.copy()

    rdap_docs = {}
    rdap_dir = common.raw_dir("rdap")
    for p in rdap_dir.glob("rdap_*.json"):
        try:
            rdap_docs[p.stem.removeprefix("rdap_")] = json.loads(p.read_text())
        except Exception:
            pass

    dns_docs = {}
    for p in (common.raw_dir("dns")).glob("dns_batch_*.json"):
        try:
            dns_docs.update(json.loads(p.read_text()))
        except Exception:
            pass

    # domain-typed rows get enrichment
    has_domain = feat_df["domain_normalized"].notna()
    as_of = dt.date.today()

    rdap_parsed = {}
    dns_parsed = {}
    for idx in feat_df.index[has_domain]:
        d = feat_df.at[idx, "domain_normalized"]
        doc = rdap_docs.get(d)
        rdap_parsed[idx] = parse_rdap_doc(doc) if doc else {"rdap_available": None}
        dd = dns_docs.get(d)
        dns_parsed[idx] = dd if dd else {}

    if rdap_parsed:
        for field in ["domain_creation_date", "domain_expiry_date", "registrar",
                      "nameservers", "country_from_domain_registration"]:
            feat_df[field] = feat_df.index.map(lambda i: rdap_parsed.get(i, {}).get(field))
        feat_df["rdap_available"] = feat_df.index.map(
            lambda i: rdap_parsed.get(i, {}).get("rdap_available"))
        feat_df["domain_age_days"] = feat_df["domain_creation_date"].map(
            lambda c: domain_age_days(c, as_of))

    if dns_parsed:
        for field in ["dns_a_exists", "dns_mx_exists", "dns_txt_exists", "dns_error"]:
            feat_df[field] = feat_df.index.map(lambda i: dns_parsed.get(i, {}).get(field))

    # lookalike features for every row with a domain
    look = {}
    for idx in feat_df.index[has_domain]:
        look[idx] = analyze_domain(feat_df.at[idx, "domain_normalized"])
    for field in ["possible_brand_impersonation", "closest_known_brand", "brand_name_similarity",
                  "domain_typo_score", "homoglyph_detected", "punycode_domain",
                  "suspicious_subdomain_pattern"]:
        feat_df[field] = feat_df.index.map(lambda i: look.get(i, {}).get(field))
    # company rows: lookalike on normalized name (brand proximity as risk feature)
    has_name = feat_df["normalized_merchant_name"].notna() & ~has_domain
    for idx in feat_df.index[has_name]:
        name = feat_df.at[idx, "normalized_merchant_name"]
        from processing.lookalike_detection import _ratio, BRANDS
        best, bs = None, 0.0
        for brand in BRANDS:
            s = _ratio(name or "", brand)
            if s > bs:
                best, bs = brand, s
        feat_df.at[idx, "closest_known_brand"] = best
        feat_df.at[idx, "brand_name_similarity"] = round(min(bs, 1.0), 4)
        feat_df.at[idx, "domain_typo_score"] = round(1.0 - min(bs, 1.0), 4)
        feat_df.at[idx, "possible_brand_impersonation"] = bool(0.8 <= bs < 0.995)

    feat_df = feat_df.convert_dtypes()
    feat_df.to_parquet(PROCESSED / "dataset_features.parquet", index=False)

    # CSV exports (inspection convenience)
    feat_df.to_csv(PROCESSED / "dataset_features.csv", index=False)

    # sample feature object from a real GLEIF row
    sample = feat_df[feat_df["entity_type"] == "company"]
    if len(sample):
        obj = build_feature_object(sample.iloc[0].to_dict())
        (SAMPLES / "feature_object_example.json").write_text(json.dumps(obj, indent=2, ensure_ascii=False, default=str))

    print(json.dumps({
        "raw_rows": len(raw_df), "clean_rows": len(clean_df), "feature_rows": len(feat_df),
        "validation_problems": problems,
    }))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "build"
    if cmd == "collect":
        step_collect()
    elif cmd == "enrich":
        step_enrich()
    elif cmd == "build":
        step_build()
    elif cmd == "all":
        step_collect()
        step_enrich()
        step_build()
    else:
        raise SystemExit(f"unknown command: {cmd} (use collect|enrich|build|all)")
