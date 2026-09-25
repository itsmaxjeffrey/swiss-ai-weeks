# TypeSafe Jev integration

## Live activation verified — 25 September 2026

Jev is now enabled in the running wallet service. The credential is stored outside the repository in an owner-only file; a systemd drop-in supplies TYPESAFE_API_KEY_FILE. The credential is never sent to the browser or shopper service.

Live verification completed:
- Actual saved customer order with its matching four customer messages and account controls: status ok, model jev-1.13.0, 739 ms. Alignment was low-confidence, so this is evidence of working inference, not proof of correctness.
- Deliberately conflicting control: status ok, 698 ms, review_required true.
- Isolated shopper HTTP signing through the production wallet review endpoint: normal proposal HTTP 200; manipulated proposal HTTP 422; no signed file for the rejected proposal. No real order was placed.
- Live policy compilation coverage review: status ok.
- Challenge-data transaction assessment through the same Jev adapter used by the worker: status ok, 742 ms; intent returned unknown. No authorization decision was submitted.
- Wallet full suite passed; current shopper suite: 72 passed. One additional live signing integration test passed. Both services remained active.

The displayed refusal now distinguishes a Jev instruction conflict from spending-settings failures. Verification requests contribute to review usage counters; those counters must not be interpreted as purchases or independent real customer events. Only shopper-review endpoint calls are included in real_app_usage; compilation and worker assessments are not.

Historical disabled-status statements below describe the pre-activation state. Current /api/state is authoritative for enablement.


Jev is integrated as an optional advisory model, using the official POST https://api.typesafe.ai/v1/systemone contract. Default model is pinned to `jev-1.13.0`.

## Enable

Configure `TYPESAFE_API_KEY` in the wallet service environment, or set `TYPESAFE_API_KEY_FILE` to an owner-readable credential file outside the repository (mode 600). Do not commit or print the key. Restart `leash-wallet-control.service` after configuring it. No key means disabled; `/api/state` exposes only enabled/model/mode/timeout, never the key.

Optional settings: `JEV_MODEL` and `JEV_TIMEOUT_MS` (default 1200 ms, capped at 1500 ms). No paid API requests are made without configured credentials.

## What it does

- Policy compile endpoint asks whether the translated rules omit or contradict customer requirements. A high-confidence concern adds a visible question and a `policy.requires_review` guard.
- Worker asks two independent typed Choice questions about merchant-text manipulation and basket/intent mismatch, in parallel with merchant enrichment.
- All Choice answers are validated for allowed labels, finite probabilities, sum, selected option consistency, and confidence.
- A concern with probability at least 0.9 and confidence at least 0.8 forces customer review (or decline when the customer's uncertainty setting requires it). These are conservative initial routing thresholds, not a locally calibrated accuracy guarantee.
- A model response can never override hard limits, remove a rule, clear unresolved instructions, approve a purchase, or answer a human step-up.
- Timeout, error, disabled configuration and malformed responses leave deterministic rules active and surface status as evidence. Enrichment is bounded by the remaining event deadline with submission time reserved.

Only allowlisted policy/purchase fields are sent. Structured card/customer/account/device IDs, payment credentials, delivery identity and transaction history are excluded. Free-text policy/item fields may still contain information supplied in their text; they are bounded but are not a general PII redactor.

This is hosted pretrained-model inference, not a newly trained fraud model. TypeSafe does not offer customer fine-tuning for Jev; configuration is through questions and state. Existing local advisory models remain in place. The integration has contract/failure/timeout/decision-boundary tests; live provider behavior still needs verification with a configured key.

Sources checked 25 September 2026:
- https://docs.typesafe.ai/api
- https://docs.typesafe.ai/models
- https://docs.typesafe.ai/confidence

## Real shopper signing integration (2026-09-25)

The shopper now calls the authenticated loopback wallet review endpoint before signing. It supplies the actual proposed items, quantities, price limits, total budget, timing, merchant restrictions, stop rules, the authenticated account's saved cap/whitelist, and up to four recent customer messages from the selected account-owned chat session. Missing chat context remains empty and the alignment question instructs Jev to return unknown. Structured payment, identity and delivery fields are excluded; user-entered request/chat text is still submitted as context when enabled.

A high-confidence concern prevents signing and requests policy revision. Deterministic shopping and family limits run before review and are rechecked after the async call. Disabled/unavailable review preserves the existing deterministic signing flow and is visibly reported, never counted as successful AI. The signed response includes wallet_review; per-order metadata stores the result and input digest. Wallet /api/state exposes jev.real_app_usage with attempts, successful calls, and last input metadata.

Verified on production using a saved real order and its matching chat: one item, four customer messages, actual budget and saved spending cap. Source is shopper_saved_policy_verification so this dry check is not mislabeled a new signing event. Result was disabled: no TypeSafe credential is configured. No order was signed or purchased by this verification.

Validation: wallet full suite passed; focused Jev/HTTP tests 20 passed; shopper full suite 69 passed. Both services restarted while no shopper turns were active. Live provider accuracy and latency remain unverified until TYPESAFE_API_KEY or TYPESAFE_API_KEY_FILE is configured in the wallet service environment.
