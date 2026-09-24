# External data quality report

Generated: 2026-09-24T11:23:20Z · cleaner: processing/clean_external.py · raw cached in data/raw/<source>/ with provenance sidecars.

| source | status | key numbers | license |
|---|---|---|---|
| sanctions_seco | ok | list_date=2026-09-04; targets_seen=17312; rows_clean=8609; via=OpenSanctions ch_seco_sanctions source.xml mirror | SECO Swiss sanctions via OpenSanctions mirror (CC BY-SA 4.0 on mirror; Swiss public data) |
| ulb_creditcard | ok integrity=PASS | rows=284807; duplicates_kept=1081; frauds=492; fraud_rate=0.001727; integrity_checks.rows_ok=True; integrity_checks.frauds_ok=True | ULB Credit Card Fraud via OpenML did 1597 |
| sanctions_ofac | ok | rows_raw=19392; rows_clean=19392; programs.RUSSIA-EO14024=5666; programs.SDGT=2180; programs.SDNTK=1333; programs.IRAN-EO13902=920; programs.GLOMAG=723; programs.NPWMD] [IFSR=636; programs.UKRAINE-EO13662] [RUSSIA-EO14024=507 | OFAC SDN list (US Treasury, public domain) |
| agentdojo | ok | result_files=36679; models=29; utility_true_rate=0.5441; security_true_rate=0.2403; suite_files=60 | AgentDojo (ETH; MIT) |
| sanctions_eu | blocked | reason=EU consolidated-list bulk CSV now requires EU Login (verified 2026-09-24; 307->EU Login HTML even with ?anonymous=true); probe.url=https://webgate.ec.europa.eu/fsd/resources/trade-sanctions/consolidated-list/sanctions_conso.csv?anonymous=true; probe.http_status=401; probe.redirected_to_login=False; probe.probed_at=2026-09-24T09:47:19Z; probe.status=BLOCKED-needs-login | EU consolidated list (public data; bulk download behind EU Login) |
| tranco | ok | rows_raw=1000000; rows_clean=999356; invalid_domains=644; dup_domains=0; list_date=2026-09-23 | Tranco (research, attribution) |
| viseca | ok | sha256_verified=11 | Viseca public synthetic pack (SYNTHETIC TEST DATA) |
| feodotracker | ok | rows_raw=5; rows_clean=5; unique_ips=5; malware_families.QakBot=4; malware_families.Emotet=1 | abuse.ch FeodoTracker (free, attribution appreciated) |
| ieee_cis | ok integrity=PASS | rows=590540; frauds=20663; with_identity=144233; null_V=590540; fraud_rate=0.03499; sample_rows=49078; verification=expected fraud count corrected 20661->20663: mirror value_counts (0:569877, 1:20663) match published Kaggle kernel counts exactly; raw column recounted directly; expected.rows=590540; expected.frauds=20663 | IEEE-CIS Fraud Detection via public HF mirror (competition data; unofficial mirror) |
| malwarebazaar | blocked | reason=no raw data; blob + API unreachable (see probe_status.json); probe.probed_at=2026-09-24T10:29:40Z; probe.status=BLOCKED; probe.reason=blob + API endpoints unreachable via egress proxy (502); API get-recent additionally needs a free abuse.ch auth key (env LEASH_ABUSECH_KEY) as fallback | abuse.ch MalwareBazaar (free, attribution; auth key for API) |
| tensortrust | ok | attacks.rows=563349; attacks.sample_rows=15000; attacks.granted_rate_sample=0.1409; defenses.rows=118377; defenses.sample_rows=5941; benchmarks.benchmarks__hijacking-robustness__v1__hijacking_robustness_dataset.jsonl=776; benchmarks.benchmarks__extraction-robustness__v1__extraction_robustness_dataset.jsonl=570; benchmarks.detecting-extractions__v1__prompt_extraction_detection.jsonl=230 | Tensor Trust (HumanCompatibleAI; permissive) |
| bipia | ok | rows=1450; attack_texts=250; context_pairs.email.train=50; context_pairs.email.test=50; context_pairs.table.train=900; context_pairs.table.test=100; context_pairs.code.train=50; context_pairs.code.test=50 | Microsoft BIPIA (MIT) |
| domain_health | ok | rows=5484; coverage_dns=0.9867; coverage_http=0.953; coverage_wayback=0.0005; coverage_crtsh=0.0026; dead_domains=5171; parked_like=0; http_live=517 | protocol lookups + Wayback CDX + crt.sh (public services, bounded/cached) |
| threatfox | ok | rows_raw=9331; rows_clean=8812; no_host_extracted=519; unique_domains_ips=7611; ioc_types.domain=5042; ioc_types.ip:port=3207; ioc_types.url=563 | abuse.ch ThreatFox (free, attribution appreciated) |
| hackaprompt | blocked | reason=gated HF dataset; export LEASH_HF_TOKEN (accept terms at https://huggingface.co/datasets/hackaprompt/hackaprompt-dataset) | HackAPrompt (MIT; gated access) |
| sanctions_un | ok | rows=1011; individuals=736; entities=275 | UN consolidated list (public data, (c) United Nations) |
| google_taxonomy | ok | rows=5595; max_depth=7; distinct_l1=21 | Google Merchant product taxonomy |
| majestic | ok | rows_raw=1000000; rows_clean=999416; invalid_domains=584 | Majestic Million (attribution) |
| tabformer | ok | rows=24386900; frauds=29757; fraud_rate=0.00122; unique_users=2000; years=1991-2020; nulls_errors=23998469; sample_rows=130000; use_chip.Swipe Transaction=15386082; use_chip.Chip Transaction=6287598 | IBM TabFormer synthetic credit-card transactions (research) |
| abuseipdb | ok | rows=1000; queue_total=5091; flagged_any_confidence=850; flagged_50plus=203; median_confidence=24.0; coverage_reports=1.0 | AbuseIPDB free tier (non-commercial, attribution; per-IP cached) |

**HackAPrompt is gated on Hugging Face** (auto-approved terms). Export `LEASH_HF_TOKEN` with accepted terms, then rerun `make collect-external SRC=hackaprompt` and `make clean-external SRC=hackaprompt`.

Full cleaned parquet: `data/processed/external/<source>/` (gitignored, reproducible). Tracked exports: `data/exports/external/<source>/` (samples / compact full sets).

Integrity semantics: `integrity=PASS` verifies publisher-published constants (IEEE-CIS 590,540 rows / 20,663 frauds — expected count corrected from 20,661 after the mirror matched published Kaggle kernel value-counts exactly; ULB 284,807 rows / 492 frauds; Viseca sha256 vs pack manifest).
