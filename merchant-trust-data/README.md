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

make collect-external            # Phase-2 external datasets (11 sources)
make collect-external SRC=viseca # one source
make clean-external              # clean/normalize them (chunked, RAM-safe)

make update                      # refresh EVERYTHING (feeds + GLEIF + rebuild + clean + reports)
make update-refresh              # ... and re-download cached static archives (large)
make weekly-status               # weekly auto-update toggle (default off)
```

Every step is resumable: raw downloads are cached with provenance sidecars
(`data/raw/<source>/*.<ext>.meta.json`), so re-running never re-downloads
unchanged data.

## Reproducible updates & weekly auto-refresh

One command re-fetches every source the dataset was built from and rebuilds
all derived artifacts (see `processing/update_all.py`):

```bash
make update                    # full refresh: threat feeds, GLEIF CH re-pull,
                               # rankings, enrichment catch-up, parquet rebuild,
                               # clean_external + quality reports

# subset / preview without touching the core dataset:
.venv/bin/python -m processing.update_all --dry-run
.venv/bin/python -m processing.update_all --sources threatfox,feodotracker
```

Freshness model:

- **Dated feeds** (openphish, urlhaus, threatfox, feodotracker, sanctions,
  malwarebazaar, tranco, majestic) use `{today}` filenames — same-day reruns
  are cache hits; the next calendar day fetches fresh automatically.
- **GLEIF** pages are undated, so `update` clears the page cache and re-pulls
  the CH slice (new LEIs appear weekly). Disable via
  `config/update.json` → `policy.refresh_gleif`.
- **Static research archives** (TabFormer, IEEE-CIS, ULB, BIPIA, AgentDojo,
  TensorTrust, HackAPrompt, Viseca, Google taxonomy) are request-key cached
  forever; `--refresh-all` forces re-download.
- **Enrichment** (RDAP/DNS, domain_health) is resume-safe per domain — only
  unseen domains cost network.
- **Blocked/gated sources** (Zefix, AbuseIPDB, MalwareBazaar behind the egress
  proxy, EU sanctions, HF-gated sets without token) are recorded per run as
  `blocked`/`disabled` and never fail the update.

Each run writes `reports/update_runs/update_<UTC>.json` (+ `latest.json`)
with per-source status and counts; the last 52 are kept.

### Weekly auto-update (opt-in)

```bash
make weekly-on      # writes auto_update.enabled=true into config/update.json
make weekly-off     # back to off — the runner stays silent
make weekly-status  # current flag + schedule
```

With the flag on, the scheduled runner (OpenClaw automation
`leash-weekly-data-update`, Mondays 06:00 Europe/Zurich) checks
`config/update.json`, runs `make update`, and commits/pushes refreshed
exports + run reports to GitHub. The flag in the repo is the single source of
truth: turning it off stops updates without touching the scheduler. Without
an OpenClaw host, wire the same gate to any cron:

```
0 6 * * 1  cd <repo>/merchant-trust-data && test "$(jq .auto_update.enabled config/update.json)" = true && make update
```

## Architecture

```
merchant-trust-data/
├── config/sources.json      # endpoints, rate limits, batch bounds, licenses
├── schemas/canonical_schema.py   # canonical columns + conventions + API feature object
├── collectors/              # openphish, urlhaus, gleif, zefix, rdap, dns +
│                            # tabformer, ieee_cis, ulb_creditcard, hackaprompt,
│                            # bipia, agentdojo, tensortrust, tranco, majestic,
│                            # google_taxonomy, viseca
├── processing/              # normalization, entity resolution, lookalike,
│                            # labeling, feature engineering, build, quality report,
│                            # collect_external + clean_external (Phase-2 datasets)
├── data/{raw,intermediate,processed,samples}
├── data/exports/external/   # tracked Phase-2 exports + stats + EXTERNAL_QUALITY_REPORT.md
├── reports/                 # data_quality_report.md
└── tests/
```

## External datasets (Phase 2)

Eleven owner-requested sources beyond the merchant-trust core, covering
transaction risk (TabFormer 24.4M synthetic card transactions, IEEE-CIS
590,540 rows / 20,663 frauds verified, ULB 284,807 / 492 baseline),
prompt-injection robustness (HackAPrompt — gated, BIPIA, AgentDojo,
TensorTrust 563k attacks + 118k defenses), and benign-domain references
(Tranco, Majestic Million) + Google Product Taxonomy + the Viseca synthetic
Swiss pack (sha256-verified).

- Full cleaned parquet: `data/processed/external/<source>/` (gitignored,
  reproducible via `make clean-external`).
- Tracked exports, per-source stats, and the generated quality report:
  `data/exports/external/`.
- Big files stream to disk; nothing large is committed. HackAPrompt stays
  blocked until `LEASH_HF_TOKEN` is exported (gated HF dataset; collector is
  token-ready).
- Integrity: publisher-constant checks are asserted per source (row counts,
  fraud counts, Viseca sha256 manifest); see `EXTERNAL_QUALITY_REPORT.md`.

## Prompt-injection detector (model)

`models/prompt_injection/` trains a hashed TF-IDF + linear detector on the
collected prompt-injection corpora (TensorTrust attacks vs broadened benign
text) and exports a portable sparse-weight artifact consumed by the
`wallet-control` engine as an escalation-only signal (never approves/declines;
missing artifact → layer inert). Threshold is calibrated per benign pool
(`calibrate_threshold.py`); scoring is window-max so short embedded clauses
are not diluted. Full honest evaluation — including two documented failed
variants — lives in `models/prompt_injection/EVAL.md`; tests in
`tests/test_prompt_injection_model.py` and `wallet-control/test/`.

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
