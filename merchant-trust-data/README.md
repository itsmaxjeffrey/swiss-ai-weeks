# LEASH — merchant-trust-data

Trust-and-control data layer for AI shopping agents: collect, normalize,
enrich, validate, and document **merchant legitimacy** data for training and
benchmarking a merchant trust model (approve / step_up / decline).

**Scope of this repo:** merchant/company/domain identity + trust evidence.
It is deliberately NOT the payment decision model, and merchant trust is kept
separate from transaction risk.

## Quick start

```bash
make setup        # venv + deps (or: python3 -m venv .venv && .venv/bin/pip install -e . pytest)
make collect      # download all configured sources (cached, resumable)
make enrich       # bounded RDAP + DNS enrichment over collected domains
make build        # build dataset_raw/clean/features parquet (+ csv)
make report       # reports/data_quality_report.md
make test         # unit tests
```

Every step is resumable: raw downloads are cached with provenance sidecars
(`data/raw/<source>/*.<ext>.meta.json`), so re-running never re-downloads
unchanged data.

## Architecture

```
merchant-trust-data/
├── config/sources.json      # endpoints, rate limits, batch bounds, licenses
├── schemas/canonical_schema.py   # canonical columns + conventions + API feature object
├── collectors/              # openphish, urlhaus, gleif, zefix, rdap, dns
├── processing/              # normalization, entity resolution, lookalike,
│                            # labeling, feature engineering, build, quality report
├── data/{raw,intermediate,processed,samples}
├── reports/                 # data_quality_report.md
└── tests/
```

## Canonical schema conventions (critical)

Full column list: `schemas/canonical_schema.py`.

1. **Missing ≠ negative.** Boolean columns use pandas nullable BooleanDtype:
   `True` / `False` / `NA`. `NA` = unknown or not collected yet; `False` =
   checked and absent. Never let a downstream model read NA as False.
2. **Lookup failures are explicit** via `*_lookup_status` columns
   (`not_attempted | ok | failed`), e.g. `registry_lookup_status`.
3. **Labels** (`schemas/labeling`): `verified_legitimate | likely_legitimate |
   unknown | suspicious | confirmed_malicious`, with `label_confidence`,
   `label_source`, `label_reason`. Rules are conservative:
   - `confirmed_malicious` only from authoritative threat-intel (OpenPhish
     confirmed feed, URLhaus).
   - GLEIF-registered active entities are `likely_legitimate` at **registry
     level only** — without Phase-2 website identity verification they are
     never `verified_legitimate`.
   - `unknown` is never `suspicious`.
4. **Provenance on every row**: `sources`, `source_urls`, `collected_at`,
   `last_verified_at`, `collector_version`, `data_license`. Raw source records
   are preserved in `raw_json` — useful raw info is never dropped.
5. **Lookalike similarity is a risk feature, never a label.** A merchant whose
   name resembles a brand is not malicious because of that.

## Leakage policy

Train/test splits (Phase 4, `models/`) must split at **company / root-domain**
level, never row level; a temporal split (older → train, newest → test) is
built alongside. Entity keys (`entity_key`, `merchant_id`) exist precisely to
make this enforceable.

## Datasets

| file | grain | purpose |
|---|---|---|
| `data/processed/dataset_raw.parquet` | one row per source record | as-collected, raw_json preserved |
| `data/processed/dataset_clean.parquet` | one row per entity (root domain / LEI) | deduped, validated, labeled |
| `data/processed/dataset_features.parquet` | clean + enrichment | RDAP/DNS/lookalike/age features for ML |

Current status and counts: `PROGRESS.md` + `reports/data_quality_report.md`.

## Security note

Everything downloaded (feeds, registry data, later: merchant pages) is
**untrusted data**. Parsers only extract fields; no content is ever executed
or followed as instructions. This dataset exists partly to detect malicious
merchants and prompt-injection attacks — treat collected content accordingly.

## Sources & licensing

See `DATA_SOURCES.md` (per-source access + license) and `LICENSE_NOTES.md`
(redistribution analysis). Unknown/unclear licenses are flagged
`LICENSE_REVIEW_REQUIRED` and are not treated as ingestible for
redistribution until resolved.

## Roadmap

- Phase 1 (current): authoritative sources — OpenPhish, URLhaus, GLEIF,
  RDAP/DNS, Zefix (token pending). Target: 5,000+ records. ✅ first builds
- Phase 2: website crawling + Impressum extraction + identity consistency +
  lookalike at scale. Target: 10,000+ enriched merchants.
- Phase 3: international registries + reputation. Target: 50,000+ if legal/practical.
- Phase 4: baseline models (LogReg/RF/XGBoost), leakage-safe splits,
  calibration + SHAP sanity checks.
