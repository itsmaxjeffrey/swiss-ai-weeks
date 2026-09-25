# Priority fixes — 25 September 2026

## Fixed

- Retry and first-attempt success now share idempotent finalization of decision status, spending, pending customer request, and feed.
- Accepted approvals and spending are persisted together using atomic file replacement. A pending customer request also survives restart in the offline simulator and remains resolvable.
- One-item permissions enforce units in addition to cart lines.
- Currency caps use the challenge rates; per-night rates remain distinct from per-purchase totals. Hotel booking does not become the books category.
- Compiler preserves supported current-sandbox caps and exposes unresolved conditions instead of silently dropping them. A review guard prevents automatic approval even under approve-uncertainty settings. A supported ordinary grocery request remains automatic.
- Unavailable customer/device history is distinct from evidence of novelty. Familiarity requirements still require evidence or customer review.
- Jev policy coverage and transaction advisory assessment are integrated; see jev.md for setup and limitations.
- Offline replay selects a coherent existing public pack when the hosted catalogue and local purchase rows differ. An explicitly supplied incoherent PACK_DIR fails with an actionable error. No reference files were overwritten or backed up.
- Hosted diagnostic driver now requires interactive policy consent and leaves human step-ups pending. Automated resolution remains available only in the explicitly synthetic offline CLI.

## Limits

Arbitrary natural-language instructions are not fully compiled. Calendar-month budgets, weekday/count restrictions, detailed booking dates, specific chosen products and other unsupported conditions remain visible and force customer review. Nightly rates must be explicitly stated in each booking line to be automatically checked. No claim of fraud-model accuracy is made.

Jev needs a configured TypeSafe API credential for live inference; no credential was present during implementation. Provider behavior is tested with controlled responses until a credential is available.

## Validation

The standard test command includes all previous suites, priority regression tests, compiler coverage tests, Jev contract and fallback tests, isolated HTTP customer flows, and category discovery tests. HTTP acceptance checks cover an ordinary approved purchase, human approval and rejection, and refusal to start a run with a revoked mandate. Offline CLI replays the five public scenarios. All test server state is isolated from the live service.

Final verification: 265 checks passed; all five public scenarios replayed successfully. The restarted service returned HTTP 200 for UI and state; live compiler probes confirmed limits, EUR conversion, quantity rules and hotel classification. Jev remained disabled because no TypeSafe credential was configured.
