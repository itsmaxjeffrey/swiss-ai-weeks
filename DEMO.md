# LEASH — five-minute reviewer demo

The [README](README.md) explains the architecture, feature set, evidence, and boundaries. This guide demonstrates the challenge's three core journeys: an ordinary purchase, useful intervention, and customer control.

## Prepare

Use a fresh local wallet to avoid modifying a shared demonstration account:

```sh
cd wallet-control
LEASH_MODE=offline LEASH_DEVICE_AUTH=off npm start
```

Open http://127.0.0.1:8790. Use the override only for isolated local evaluation. The [hosted wallet](https://viseca-shopper.pixerful.com/wallet/) requires an enrolled browser; initial enrollment follows the operator procedure in [wallet-upgrade.md](wallet-control/docs/wallet-upgrade.md).

## 0:00–1:00 — delegate and inspect permission

1. In **Policy**, select **SCEN0000 · Connection check**.
2. Choose **Translate to permissions**.
3. Read the interpretation, executable rules, and any open questions.
4. Choose **Confirm & activate**.

Explain: the customer's instruction becomes visible permissions; translation alone does not activate them.

## 1:00–2:00 — an ordinary purchase

1. Open **Purchases** and select **SCEN0000**.
2. Start the run.
3. Inspect the outcome, amount, and evidence.

The customer HTTP-flow test verifies automatic approval with the bundled connection-check fixture and corresponding policy. Existing standing controls or a different policy can change the result; explain the actual evidence instead of assuming approval.

Evidence: [server-flow.test.js](wallet-control/test/server-flow.test.js).

## 2:00–3:00 — change a fact, observe intervention

1. Open **Try a purchase**.
2. Enter a purchase priced above the active per-order cap and evaluate it.
3. Inspect the decline and evidence.
4. Reduce the price and evaluate again. Other restrictions still apply: a lower price does not establish merchant familiarity or product suitability.

The form does not submit a payment or change the spending ledger. To inspect manipulation coverage independently, run:

```sh
node test/injection-battery.test.js
```

The battery introduces attack text into otherwise approvable purchases and checks for intervention, alongside benign-text checks. It is a bounded adversarial suite, not evidence of resistance to every attack.

## 3:00–4:00 — the customer answers

1. Return to **Policy** and append “Deliver before Friday” to the connection-check instruction.
2. Translate, inspect the unresolved question, and activate the policy.
3. Start the connection-check run again.
4. Open **Inbox**, inspect the paused purchase, and choose approval or rejection.

The customer HTTP-flow test covers both answers. Approval rechecks policy, expiry, and relevant budgets; a hard violation cannot be waived through this button. Answer within the displayed window.

## 4:00–5:00 — tighten, revoke, inspect

1. Open **Controls** to inspect monetary, calendar, region, product, and one-purchase restrictions.
2. Open **Activity** to see retained decisions.
3. Open **Proof & devices**, inspect a signed decision, and choose **Verify**.
4. Return to **Policy** and revoke the permission. New runs under that policy should be refused.

Explain: verification checks signed content under the wallet key; it does not prove settlement or delivery.

## Optional: conversational shopping

Open the [shopper](https://viseca-shopper.pixerful.com/) with a permitted account and request a bounded product search. Show the policy card, spending/merchant settings, and customer-signing step. Family controls and account-owned history demonstrate the broader experience.

Agent conversations require the configured OpenClaw/model runtime. Shopper signing controls and the wallet authorization ledger are distinct. A chat response or signed proposal is not evidence of a completed card payment.

## Reproduce verification

From the repository root:

```sh
(cd wallet-control && npm test)
(cd viseca-shopper-ui && npm test)
(cd merchant-trust-data && make setup && make test)
```

Verified on 25 September 2026: **275 wallet checks, 72 shopper tests, 33 data-pipeline tests**. The README links directly to the main test suites, model cards, and quality reports.
