# External data quality report

Generated: 2026-09-23T17:53:13Z · cleaner: processing/clean_external.py · raw cached in data/raw/<source>/ with provenance sidecars.

| source | status | key numbers | license |
|---|---|---|---|
| ulb_creditcard | ok integrity=PASS | rows=284807; duplicates_kept=1081; frauds=492; fraud_rate=0.001727; integrity_checks.rows_ok=True; integrity_checks.frauds_ok=True | ULB Credit Card Fraud via OpenML did 1597 |
| agentdojo | ok | result_files=36679; models=29; utility_true_rate=0.5441; security_true_rate=0.2403; suite_files=60 | AgentDojo (ETH; MIT) |
| tranco | ok | rows_raw=1000000; rows_clean=999356; invalid_domains=644; dup_domains=0; list_date=2026-09-23 | Tranco (research, attribution) |
| viseca | ok | sha256_verified=11 | Viseca public synthetic pack (SYNTHETIC TEST DATA) |
| ieee_cis | ok integrity=PASS | rows=590540; frauds=20663; with_identity=144233; null_V=590540; fraud_rate=0.03499; sample_rows=49078; verification=expected fraud count corrected 20661->20663: mirror value_counts (0:569877, 1:20663) match published Kaggle kernel counts exactly; raw column recounted directly; expected.rows=590540; expected.frauds=20663 | IEEE-CIS Fraud Detection via public HF mirror (competition data; unofficial mirror) |
| tensortrust | ok | attacks.rows=563349; attacks.sample_rows=15000; attacks.granted_rate_sample=0.1409; defenses.rows=118377; defenses.sample_rows=5941; benchmarks.benchmarks__hijacking-robustness__v1__hijacking_robustness_dataset.jsonl=776; benchmarks.benchmarks__extraction-robustness__v1__extraction_robustness_dataset.jsonl=570; benchmarks.detecting-extractions__v1__prompt_extraction_detection.jsonl=230 | Tensor Trust (HumanCompatibleAI; permissive) |
| bipia | ok | rows=1450; attack_texts=250; context_pairs.email.train=50; context_pairs.email.test=50; context_pairs.table.train=900; context_pairs.table.test=100; context_pairs.code.train=50; context_pairs.code.test=50 | Microsoft BIPIA (MIT) |
| hackaprompt | blocked | reason=gated HF dataset; export LEASH_HF_TOKEN (accept terms at https://huggingface.co/datasets/hackaprompt/hackaprompt-dataset) | HackAPrompt (MIT; gated access) |
| google_taxonomy | ok | rows=5595; max_depth=7; distinct_l1=21 | Google Merchant product taxonomy |
| majestic | ok | rows_raw=1000000; rows_clean=999416; invalid_domains=584 | Majestic Million (attribution) |
| tabformer | ok | rows=24386900; frauds=29757; fraud_rate=0.00122; unique_users=2000; years=1991-2020; nulls_errors=23998469; sample_rows=130000; use_chip.Swipe Transaction=15386082; use_chip.Chip Transaction=6287598 | IBM TabFormer synthetic credit-card transactions (research) |

**HackAPrompt is gated on Hugging Face** (auto-approved terms). Export `LEASH_HF_TOKEN` with accepted terms, then rerun `make collect-external SRC=hackaprompt` and `make clean-external SRC=hackaprompt`.

Full cleaned parquet: `data/processed/external/<source>/` (gitignored, reproducible). Tracked exports: `data/exports/external/<source>/` (samples / compact full sets).

Integrity semantics: `integrity=PASS` verifies publisher-published constants (IEEE-CIS 590,540 rows / 20,663 frauds — expected count corrected from 20,661 after the mirror matched published Kaggle kernel value-counts exactly; ULB 284,807 rows / 492 frauds; Viseca sha256 vs pack manifest).
