# Prompt-injection detector — evaluation & model card

Detector for untrusted merchant-supplied text in the LEASH wallet-control
engine: item_details, purchase_description, merchant_name. Escalation-only —
it can never approve, decline, or loosen anything; it only adds step_up
evidence or an uncertainty note, exactly like the deterministic regex scan.

## Shipped model: v2

- Features: md5-hashed TF-IDF (2^19 buckets, uni+bi-grams over `[a-z0-9']+`),
  sign hashing (`idx=int(h[:8],16)%n`, `sign=+1 if int(h[8:16],16)%2==0`),
  smooth IDF, L2 normalisation. 333,546 exported weights (9.3 MB JSON).
- Classifier: SGD logistic regression (L2, alpha 2e-6, 3 epochs, constant
  eta0 0.3), two-phase: full space, then retrained in the exported keep-set
  so the deployed scorer's feature space matches training exactly.
- Scoring: **window_max** — max over the whole text plus sliding 40-token
  windows (stride 20). Defeats dilution when a short manipulation clause is
  embedded in an otherwise-benign product description.
- Threshold: τ = 0.0542, calibrated post-training by
  `calibrate_threshold.py` under a **per-pool FPR budget** (≤0.5% per benign
  pool; pools ≤100 rows pinned at max+5%): TT-val negatives 0.24%, BIPIA
  benign tasks 0%, Viseca pack 0%. Suspect band (uncertainty only, no
  escalation) = 0.55·τ ≈ 0.030.

## Training data (all previously collected Phase-2 sources)

- Positives: TensorTrust raw-dump `attacker_input` (≥20 chars, ≥5 tokens,
  deduped; 156,789 short password-guess attacks filtered out) — 203,143 train.
- Negatives: TensorTrust defenses (68,671), GLEIF CH legal names (26,120),
  Tranco domains sampled 2.5% (23,129), Google product taxonomy (4,787),
  AgentDojo clean-run tool outputs + user tasks (1,239). The broadened benign
  mix was the v2 fix: v1 (defenses-only) learned "instruction-like = safe" —
  the exact inverse of the deployment need — and flagged 31.8% of benign
  Viseca pack text.
- Eval-only (never trained): BIPIA (197 directive attacks / 50 benign-looking
  tasks, hand-partitioned), Viseca pack text (280 rows, deployment-domain).

## Results at τ=0.0542, window-max scoring

| set | n | pos | neg | FPR / recall |
|-----|---|-----|-----|--------------|
| TT val+test (positives) | ~18k | 15,699 | — | recall 0.160 |
| TT val negatives | 5,087 | — | — | FPR 0.0024 |
| BIPIA benign tasks | 50 | — | — | FPR 0.0 |
| Viseca pack (deployment) | 280 | — | — | FPR 0.0 (max score 0.029) |
| Challenge-pack clean texts | 30 | — | — | FPR 0.0 (max 0.025) |
| Challenge-pack manipulated | 6 | — | — | recall 0.0 (median 0.013) |
| BIPIA directive attacks | 197 | — | — | recall 0.0 |

Interpretation, stated plainly:

1. **Zero false positives on deployment-domain text.** Every benign pool sits
   comfortably below τ. The engine's suspect band and escalation never fire on
   ordinary product text in these corpora.
2. **The model adds real coverage for TT-style manipulation** — continuation
   hijacks, "[END OF INPUT]" traps, "summarize this starting with …" — that
   the regex layer misses (8 such held-out attacks are locked into
   `wallet-control/test/fixtures/` and must escalate end-to-end).
3. **It does not catch the challenge pack's own embedded clauses** (median
   0.013 vs τ 0.054) nor BIPIA directive style. Those are covered by the
   deterministic regex layer (`lib/signals.js`), which fires on the pack's
   "ignore/approve/cardholder unavailable" phrasing. Word-level TF-IDF
   features do not transfer across these attack distributions; closing that
   gap needs different features (see below).

## Ablation: v3 mixture training failed (documented, not shipped)

v3 added 113k synthetic positives (attacks embedded in benign carriers at
deployment-like ratios) to teach firing on embedded clauses. Result: the same
benign strings appeared in positives (as carriers) and negatives (pure), so
benign n-grams lost negative evidence value and the score distribution
collapsed — Viseca benign p99 0.95, TT-defenses p99 1.0, challenge-pack CLEAN
texts max 0.92. No threshold separates the classes; v3 is preserved as
`injection-model-v3.json` + corpus source `tensortrust_mixture` for the
record. Future attempt should use strictly disjoint carrier/negative pools and
sequence-aware features, or wait for HackAPrompt (still HF-token-blocked) for
attack-style diversity.

## Latency & integration

- Artifact loads eagerly at module import (~100 ms, once per process); scoring
  is ~1–2 ms per field for typical item text (md5 per n-gram, sparse lookup).
- Engine: `lib/injection-model.js` scores the same untrusted fields as the
  regex scan; score ≥ τ → `INJ_MODEL` entry in `flags.manipulation` →
  step_up with quoted evidence (strongest n-grams of the winning window);
  score in [0.55τ, τ) → `INJECTION_SUSPECT` uncertainty note (escalates only
  under `ask` policy); missing artifact → layer silently inert.
- Tests: `wallet-control/test/injection-model.test.js` (parity ±1e-6 vs
  Python vectors, engine escalation, benign quiet) +
  `merchant-trust-data/tests/test_prompt_injection_model.py`.

## Regeneration

```bash
cd merchant-trust-data
make setup
.venv/bin/python models/prompt_injection/build_corpus.py        # ~9 min
.venv/bin/python models/prompt_injection/train_detector.py --version vN   # ~12 min
.venv/bin/python models/prompt_injection/calibrate_threshold.py --artifact models/prompt_injection/injection-model-vN.json
node models/prompt_injection/make_fixtures.mjs                  # refreshes JS test fixtures
```
