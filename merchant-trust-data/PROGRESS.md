# PROGRESS

 Living log: DONE / IN PROGRESS / BLOCKED / NEXT. Updated continuously.

## DONE

- 2026-09-23: repo scaffold: canonical schema (`schemas/canonical_schema.py`),
  three-state conventions (NA ≠ False), provenance columns, leakage policy.
- 2026-09-23: collectors: openphish, urlhaus, gleif (paginated, cached,
  resume-safe), zefix (interface + probe), rdap (cached per domain), dns.
- 2026-09-23: unit tests (10) for normalization + lookalike + labeling: all pass.
- 2026-09-23: source availability verified live:
  - OpenPhish feed.txt → 200 (redirect followed)
  - URLhaus csv_recent → 200 (2.6 MB)
  - GLEIF API → 200 (CH legalAddress filter: 28,215 records total)
  - RDAP (rdap.org) → works (404 = unregistered domain)
  - Zefix API → 401 without token (probe recorded in data/raw/zefix/)
- 2026-09-23: collected: OpenPhish 300 URLs; URLhaus 13,967 URLs;
  GLEIF CH 6,000 records (pages 1–30 of 142).
- 2026-09-23: lookalike detection: Levenshtein-similarity (rapidfuzz),
  homoglyph folding, punycode, brand-in-subdomain, brand list (~90 incl.
  Swiss brands); verified against paypa1/micros0ft-support/xn-- cases.
- 2026-09-23: enrichment v0: RDAP 133 ok/130 with registration dates,
  20 not-found, 11 http_429 (retryable), 3 http_403; DNS 167/167.
- 2026-09-23: **dataset v1 built**: 20,267 raw rows → 11,484 entities →
  raw/clean/features parquet + csv + quality report + sample feature object.
  0 duplicate entity keys, 0 validation problems.

### Bugs found & fixed while building (documented to avoid repeats)

- `build_dataset` had no `__main__` dispatch → silent no-op (exit 0).
- GLEIF pagination keys are `lastPage`/`total`, not `totalPages`/`totalRecords`;
  registration dates live at `attributes.registration` (nullable), with
  `entity.creationDate` fallback.
- URLhaus CSV column header is a `#` comment line — must be recovered and
  passed as `fieldnames`, otherwise every row parses header-less (first data
  row consumed as header, `url` column lost).
- `common.get()` lacked the `cache_key` kwarg its callers passed.
- pandas 3.0 maps None→NaN in mixed columns; date parsing must be
  type-defensive.
- **Semantic caveat**: GLEIF `initialRegistrationDate` = LEI issuance date,
  NOT company founding date. `company_age_days`/`incorporation_date` on
  GLEIF-sourced rows currently mean "age of the LEI record". True incorporation
  dates come from Zefix once the token exists (NEXT). Do not use
  company_age_days as company age for GLEIF rows without this caveat.

## IN PROGRESS

- Nothing right now. RDAP coverage for the remaining threat domains is a
  config bump away (`rdap.max_domains`), resumable via cached lookups.

## BLOCKED

- **Zefix API**: requires registered (free) token. Unauthenticated POST → 401
  (verified). Action needed by human: register at zefix.ch for API access,
  export `LEASH_ZEFIX_TOKEN`, then set `zefix.enabled=true` in
  `config/sources.json`. Collector is ready; nothing else blocks on it.
- **OpenCorporates / Companies House**: both need API keys (free tiers exist
  via account signup). Collectors to be added once keys exist.
- **URLhaus API v2**: auth key now required for API endpoints (free from
  auth.abuse.ch). Legacy `/downloads/csv_recent/` works without key as of
  today; if that goes away, get a free key and set env var.

## NEXT

1. Raise `rdap.max_domains`/`dns.max_domains` and re-run `make enrich` to
   extend coverage from 167 to all 5,484 threat domains (resumable, cached).
2. Website crawler (Phase 2): homepage/Impressum fetch, legal-page detection,
   identity extraction → registry-vs-website consistency features.
3. Zefix token → full Swiss registry pull incl. UID, canton, true
   incorporation dates, legal form names.
4. GLEIF legal-form code → human-readable mapping (api.gleif.org legal-forms).
5. Expand GLEIF to DE/AT/FR/IT/GB/US slices (config-driven, already supported).
6. Reputation sources (Reddit aggregates via official interfaces, complaint
   DBs) — Phase 3, low weight, never ground truth.
7. Baseline models (Phase 4): LogReg/RF/XGBoost, entity-level + temporal
   splits, calibration, SHAP sanity checks.
8. Retry the 11 http_429 + 3 http_403 RDAP lookups (backoff, later run).

## Source status table

| source | records downloaded | records usable | last successful run | errors | rate limits |
|---|---|---|---|---|---|
| openphish | 300 URLs | 167 unique domains (after dedupe) | 2026-09-23 | none | none observed (free feed ≈300 active entries) |
| urlhaus | 13,967 URLs | 5,322 unique domains (after dedupe; 5 overlap w/ openphish) | 2026-09-23 | header-in-comment parsing bug fixed | keep ≥5 min between dumps (per abuse.ch) |
| gleif (CH) | 6,000 / 28,215 | 6,000 | 2026-09-23 | none (pagination fixed: lastPage/total keys) | 0.35 s sleep between pages |
| zefix | 0 — token required | — | probe 2026-09-23 (401) | 401 unauthenticated | per API terms once tokenized |
| rdap | 167 lookups | 133 ok (130 w/ dates), 20 not_found | 2026-09-23 | 11 http_429, 3 http_403 (retryable) | 0.8 s sleep; cached per domain |
| dns | 167 lookups | 167 | 2026-09-23 | NXDOMAIN kept as dns_error signal | 0.05 s sleep, 4 s timeout |

## Dataset counts (v1, 2026-09-23)

- dataset_raw rows: **20,267** (13,967 urlhaus + 300 openphish + 6,000 gleif)
- dataset_clean entities: **11,484** (6,000 companies + 5,484 domains)
- dataset_features rows: **11,484**
- label distribution: likely_legitimate 5,926 · confirmed_malicious 5,484 ·
  unknown 74 · verified_legitimate 0 · suspicious 0 (correct: none of the
  current evidence justifies those labels)
- validation problems: none · duplicate entity keys: 0
- detail: reports/data_quality_report.md
