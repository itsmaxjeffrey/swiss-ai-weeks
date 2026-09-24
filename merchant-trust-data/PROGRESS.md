# PROGRESS

 Living log: DONE / IN PROGRESS / BLOCKED / NEXT. Updated continuously.

## DONE

- 2026-09-24: **prompt-injection detector v2 built, calibrated, deployed into
  wallet-control** (`models/prompt_injection/`): corpus v2 (TT attacks 203k /
  defenses 69k + benign GLEIF/Tranco/taxonomy/AgentDojo 55k; BIPIA + Viseca
  pack held out eval-only), md5-hashed TF-IDF (2^19, uni+bi) + two-phase SGD
  logreg, window-max scoring (40-token windows, stride 20), per-pool-FPR
  threshold calibration (τ=0.0542; 0% FPR on Viseca pack, BIPIA benign, pack
  clean texts). JS scorer `wallet-control/lib/injection-model.js` (md5 lockstep
  with Python, parity-tested ±1e-6) + engine step_up-with-evidence integration
  + suspect band; 8 regex-escaping held-out attacks locked into fixtures.
  Documented failures: v1 (defenses-only negatives inverted the domain — 31.8%
  FPR on benign product text), v3 mixture training (carrier leakage collapsed
  the score distribution — benign p99 0.95) — both kept as ablations in
  EVAL.md. Tests: JS 30 (25 engine + 5 model), Python 32. Details:
  models/prompt_injection/EVAL.md.
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
- 2026-09-23 (evening): GLEIF collector rewritten to cursor pagination; full
  CH slice collected: 28,222 records in 142 cached pages (`gleif_ch_c*.json`).
  RDAP/DNS limits raised (rdap 6000, dns 6000); full-domain enrichment run
  started (see IN PROGRESS).
- 2026-09-23 (night): **dataset v2 built**: 42,489 raw rows → 33,706 entities
  (28,222 companies + 5,484 domain-keyed rows) → 0 duplicates, 0 validation
  problems. Labels: 25,606 likely_legitimate · 5,484 confirmed_malicious ·
  2,616 unknown (GLEIF rows lacking registration/creation dates — honest
  unknowns, shrink once Zefix supplies true dates).
- 2026-09-23 (night): **enrichment scoping fix**: discovered 4,908 of the
  5,484 "root domains" are IP-literal hosts (URLhaus malware infra is mostly
  bare-IP; e.g. "0.100" fragments of 0.100.14.129). `step_enrich` now skips
  letter-less roots (576 real domains enriched: DNS A/MX known for 568/576;
  RDAP docs + not_found cached for ~1,204 domain keys). Failed RDAP stubs from
  the proxy-407 storm moved to `data/raw/rdap/_retry_stash2/`.

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
- GLEIF API rejects page-number pagination beyond 10,000 results (HTTP 400:
  `page[number] * page[size] must not exceed 10000`) even while meta reports
  `lastPage: 142` — a full CH slice (28,222) silently dies at page 51. Fix:
  cursor pagination (`page[cursor]=*`, follow `links.next`). The
  `filter[entity.legalAddress.region]` filter is NOT supported on lei-records
  (400 "Filter should contain only allowed values"), so region-splitting is
  not an option. Cached cursor pages resume by reading the next cursor from
  the previous page's `links.next`.
- **Semantic caveat**: GLEIF `initialRegistrationDate` = LEI issuance date,
  NOT company founding date. `company_age_days`/`incorporation_date` on
  GLEIF-sourced rows currently mean "age of the LEI record". True incorporation
  dates come from Zefix once the token exists (NEXT). Do not use
  company_age_days as company age for GLEIF rows without this caveat.
- **Egress proxy 407 storms**: mid-bulk-run the env's HTTP proxy started
  rejecting CONNECT tunnels (`407 Proxy Authentication Required`) → thousands
  of RDAP lookups failed with identical ProxyError stubs. Transient: probes
  succeeded again shortly after. If bulk collectors fail en masse with 407,
  pause and retry later instead of burning retries; keep error stubs stashable
  (`_retry_stash*/`) so re-runs only fetch the gaps.
- **URLhaus reality check**: csv_recent is majority bare-IP hosting (12,570 of
  14,265 threat rows; 4,908 unique IP-literal "roots" vs 576 real domains).
  Never RDAP/DNS IP literals as domains; enrich set is filtered for letter-less
  roots in `step_enrich`.

- 2026-09-23 (evening): **Phase-2 external datasets collected + cleaned** (11 sources,
  owner-requested batch): TabFormer, IEEE-CIS, ULB CC fraud, HackAPrompt, BIPIA,
  AgentDojo, TensorTrust, Tranco, Majestic Million, Google Product Taxonomy,
  Viseca synthetic pack. Collectors in `collectors/`, runner
  `processing/collect_external.py`, cleaner `processing/clean_external.py`,
  `make collect-external` / `make clean-external`. Full cleaned parquet in
  `data/processed/external/` (gitignored); tracked exports + stats + report in
  `data/exports/external/` (largest file 24MB).
  - Tranco 1,000,000 rows (584 invalid dropped) · Majestic 1,000,000 (644 dropped)
  - Google taxonomy 5,595 categories, depth ≤7
  - Viseca 11 CSV tables, **sha256 all verified vs pack manifest**
  - TabFormer 24,386,900 rows / 29,757 frauds (0.122%), 2,000 users, 1991–2020,
    chunk-streamed to parquet + 130k stratified sample
  - IEEE-CIS (HF mirror) 590,540 rows / **20,663 frauds — verified**: value
    counts (0:569877 / 1:20663) match published Kaggle kernel counts exactly;
    initial 20,661 expectation was wrong, not the data
  - ULB via OpenML did 1597: 284,807 rows / 492 frauds, integrity PASS (1,081
    duplicate rows kept, documented)
  - BIPIA 1,450 rows (250 attack texts + qa/email/table/code context pairs)
  - AgentDojo 36,679 published benchmark results (29 models × 4 suites),
    utility-true 54.4% / security-true 24.0%; suites inventory extracted
  - TensorTrust 563,349 attacks + 118,377 defenses (typed parquet; streaming
    schema-fixed) + 3 derived benchmark files as-is
  - HackAPrompt **BLOCKED**: HF-gated (auto-approve) — needs `LEASH_HF_TOKEN`
    with accepted terms; collector is token-ready, no other work pending.

## DONE

### 2026-09-24 — Phase-3 enrichment: threat feeds + sanctions + domain health

- **ThreatFox** (abuse.ch): recent IOC CSV collected 2026-09-24 (9,331 rows raw →
  8,812 cleaned, 7,611 unique domains/IPs; ioc types: 5,042 domain / 3,207 ip:port /
  563 url; 519 rows without extractable host dropped). Parser handles the
  header-in-`#`-comment format. License: abuse.ch free w/ attribution.
- **FeodoTracker** (abuse.ch): ipblocklist JSON variant (CSV fallback wired);
  recent list is tiny right now (5 C2 IPs: QakBot 4 / Emotet 1). Note: the
  full historic dumps need the abuse.ch auth key; blocklist variants are key-free.
- **UN consolidated sanctions**: consolidated.xml streamed (2.2MB) → 1,011
  designations parsed (736 individuals / 275 entities) with aliases + listed_on.
- **OFAC SDN** (bonus): 19,392 designations parsed (`-0-` placeholders nulled).
- **SECO Swiss sanctions**: no stable anonymous bulk URL on seco.admin.ch
  (verified) → collected the original `source.xml` via the OpenSanctions
  `ch_seco_sanctions` mirror (42MB, list date 2026-09-04) → 8,609 unique ssid
  targets w/ name variants. Mirror license CC BY-SA 4.0; Swiss public data.
- **EU consolidated list BLOCKED**: bulk CSV now redirects to EU Login even with
  `?anonymous=true` (verified with cookie jar 2026-09-24); probe recorded in
  `data/raw/sanctions_eu/probe_status.json`.
- **MalwareBazaar BLOCKED (proxy)**: daily blob + API both 502 via the egress
  proxy (probed today + yesterday, API retried); probe stashed in
  `data/raw/malwarebazaar/probe_status.json`. If the proxy wall persists, a free
  auth key from auth.abuse.ch (`LEASH_ABUSECH_KEY`) is the API fallback.
- **AbuseIPDB scaffold**: key-ready collector (`LEASH_ABUSEIPDB_KEY`); 401
  unauthenticated probe recorded → BLOCKED-pending-key.
- **Domain-health enrichment**: DNS (A/MX/NS/SPF) + HTTP liveness (HEAD→GET,
  parked-page sniff) + Wayback CDX first-seen over ALL confirmed-malicious root
  domains (5,484 unique — the earlier "576" was the bounded DNS batch size);
  crt.sh first-seen bounded to ≤500 domains. Resumable JSONL cache in
  `data/raw/domain_health/`.
- Cleaners + tests added (`tests/test_external_collectors.py`, 16 tests pass);
  EXTERNAL_QUALITY_REPORT.md regenerated; LICENSE_NOTES.md + DATA_SOURCES.md
  updated for every new source.

### 2026-09-24 — Reproducible update pipeline + weekly auto-update toggle

- `processing/update_all.py`: one command (`make update`) re-fetches every
  source (feeds, GLEIF CH re-pull, rankings, enrichment catch-up) and rebuilds
  all derived artifacts (parquet, clean_external exports, quality reports).
- Freshness model: dated feed filenames → same-day cache / next-day fresh;
  GLEIF page cache cleared per update (policy knob); static archives cached
  forever (`--refresh-all` forces); enrichment resume-safe. Blocked/gated
  sources recorded per run, never fail the update.
- Per-run provenance: `reports/update_runs/update_<UTC>.json` + `latest.json`
  (last 52 kept) with per-source status (fresh/cached/blocked/error/disabled).
- Weekly auto-update is opt-in: `make weekly-on|off|status` flips
  `config/update.json` `auto_update.enabled` (default **off**); the scheduled
  runner checks that flag before running, so the repo config is the single
  source of truth.
- Tests: `tests/test_update_all.py` (10) — toggle roundtrip, plan building,
  cleaner-mapping integrity, report retention. Full suite: 25 pass.

## IN PROGRESS

- Nothing right now.

## BLOCKED

- **HackAPrompt (Phase-2)**: dataset is gated on Hugging Face (auto-approve
  terms). Action: accept terms at
  huggingface.co/datasets/hackaprompt/hackaprompt-dataset with an HF account,
  create a token, `export LEASH_HF_TOKEN=***`, then rerun
  `make collect-external SRC=hackaprompt && make clean-external SRC=hackaprompt`.

- **EU consolidated sanctions list**: bulk CSV sits behind EU Login
  (verified 2026-09-24). Action needed by human: create an EU Login account and
  either export the consolidated list manually once logged in, or provide
  credentials/a session for the collector. Until then UN+OFAC+SECO cover the
  sanctions angle.

- **MalwareBazaar**: daily blob + API unreachable through the host egress proxy
  (502 on both, 2026-09-24). Retry from a different network, or register a free
  auth key at https://auth.abuse.ch/ and `export LEASH_ABUSECH_KEY=***` so the
  API get-recent path works. Collector records probes automatically.

- **AbuseIPDB**: free API key required (401 without; probe recorded
  2026-09-24). Action: register at https://www.abuseipdb.com/account/api,
  `export LEASH_ABUSEIPDB_KEY=***`, flip `abuseipdb.enabled=true`. Collector
  scaffold is key-ready (per-IP cache, 1k checks/day free tier).

- **Zefix API**: requires registered (free) token. Unauthenticated POST → 401
  (verified). Action needed by human: email **zefix@bj.admin.ch** (official
  contact per bj.admin.ch, verified 2026-09-23) to request REST API access.
  Then export `LEASH_ZEFIX_TOKEN=***, set `zefix.enabled=true` in
  `config/sources.json`. Collector is ready; nothing else blocks on it.
  **Token-free alternative found**: opendata.swiss hosts the official Zefix
  dataset (daily core data: name, seat, domicile of active entities) queryable
  via SPARQL on Lindas — worth wiring regardless of token timing.
- **OpenCorporates / Companies House**: both need API keys (free tiers exist
  via account signup). Collectors to be added once keys exist.
- **URLhaus API v2**: auth key now required for API endpoints (free from
  auth.abuse.ch). Legacy `/downloads/csv_recent/` works without key as of
  today; if that goes away, get a free key and set env var.

## NEXT

1. ~~Raise `rdap.max_domains`/`dns.max_domains` and re-run `make enrich`~~
   → done (see DONE night entry); RDAP/DNS now cover all 576 real domains.
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
8. ~~Retry the 11 http_429 + 3 http_403 RDAP lookups~~ → superseded by the
   night re-run; residual failures are stashed in `data/raw/rdap/_retry_stash2/`.
9. Add `host_type` flag (domain | ip_literal) at entity resolution so the
   4,908 IP-host entities are typed correctly instead of masquerading as
   "domains"; feature columns stay NA for them (already the case post-filter).
10. Optionally re-scrape the two threat feeds in a few days for fresh rows
    (feeds move fast); GLEIF CH slice refresh is cheap (cursor-cached).

## Source status table

| source | records downloaded | records usable | last successful run | errors | rate limits |
|---|---|---|---|---|---|
| openphish | 300 URLs | 167 unique domains (after dedupe) | 2026-09-23 | none | none observed (free feed ≈300 active entries) |
| urlhaus | 13,967 URLs | 5,322 unique domains (after dedupe; 5 overlap w/ openphish) | 2026-09-23 | header-in-comment parsing bug fixed | keep ≥5 min between dumps (per abuse.ch) |
| gleif (CH) | 6,000 / 28,215 | 6,000 | 2026-09-23 | none (pagination fixed: lastPage/total keys) | 0.35 s sleep between pages |
| zefix | 0 — token required | — | probe 2026-09-23 (401) | 401 unauthenticated | per API terms once tokenized |
| rdap | 167 lookups | 133 ok (130 w/ dates), 20 not_found | 2026-09-23 | 11 http_429, 3 http_403 (retryable) | 0.8 s sleep; cached per domain |
| dns | 167 lookups | 167 | 2026-09-23 | NXDOMAIN kept as dns_error signal | 0.05 s sleep, 4 s timeout |
| threatfox | 9,331 IOCs | 8,812 cleaned (7,611 unique hosts) | 2026-09-24 | 519 no-host rows dropped | none (free export) |
| feodotracker | 5 C2 IPs (recent JSON list is tiny) | 5 | 2026-09-24 | — | none |
| sanctions_un | 1,011 designations | 1,011 (736 ind / 275 ent) | 2026-09-24 | none | none |
| sanctions_ofac | 19,392 designations | 19,392 | 2026-09-24 | none | none |
| sanctions_seco | 42MB source.xml (list 2026-09-04) | 8,609 unique ssid | 2026-09-24 | via OpenSanctions mirror | polite (single file) |
| sanctions_eu | 0 — EU Login wall | — | probe 2026-09-24 (307→login) | EU Login required | — |
| malwarebazaar | 0 — proxy 502 | — | probe 2026-09-24 | egress proxy 502 (blob+API) | — |
| domain_health | 5,484/5,484 domains (DNS MX/NS/A + SPF, HTTP liveness, Wayback first-seen, crt.sh 500-sample) | see stats/domain_health.json | 2026-09-24 | none | polite ≤10 threads |
| abuseipdb | 1,000 checks (999 ok / 1 err) of 5,091 IP queue | 850 flagged (>0 confidence), 203 ≥50, median 24 | 2026-09-24 | free-tier 1k/day cap | 1k/day; resumable queue reruns tomorrow |

## Dataset counts (v1, 2026-09-23)

- dataset_raw rows: **20,267** (13,967 urlhaus + 300 openphish + 6,000 gleif)
- dataset_clean entities: **11,484** (6,000 companies + 5,484 domains)
- dataset_features rows: **11,484**
- label distribution: likely_legitimate 5,926 · confirmed_malicious 5,484 ·
  unknown 74 · verified_legitimate 0 · suspicious 0 (correct: none of the
  current evidence justifies those labels)
- validation problems: none · duplicate entity keys: 0
- detail: reports/data_quality_report.md
