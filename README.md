# LEASH — customer-controlled AI shopping

Hackathon monorepo for the Swiss AI Weeks Viseca challenge. The shopping agent proposes purchases; a separate wallet evaluates permissions and asks the customer when evidence is incomplete.

## Applications

| Directory | Purpose |
| --- | --- |
| `viseca-shopper-ui/` | Conversational shopping UI, account-aware backend, shopping permissions and OpenClaw bridge |
| `wallet-control/` | Policy compiler, authorization engine, review inbox, standing limits, device signing, decision proofs and purchase trials |
| `merchant-trust-data/` | Data collectors, provenance, curated datasets, training code, model artifacts and evaluation reports |

Live shopper: https://viseca-shopper.pixerful.com/ · Wallet: https://viseca-shopper.pixerful.com/wallet/

## Run the wallet locally

Requires Node.js 20 or later. No npm dependencies are required for the wallet.

```sh
cd wallet-control
npm test
LEASH_MODE=offline LEASH_DEVICE_AUTH=off npm start
```

Open http://127.0.0.1:8790. The explicit device-auth override is restricted to offline mode; do not use it for a public deployment. The bundled `data/offline-pack/` provides a coherent replay pack. Read `wallet-control/docs/wallet-upgrade.md` for secure browser enrollment and control behavior.

The shopper backend requires an independently configured OpenClaw instance and environment configuration described in `viseca-shopper-ui/README.md`. Real account records, payment vaults, sessions and credentials are not bundled.

```sh
cd viseca-shopper-ui
npm test
npm start
```

## Gathered data and models

Curated data is in `merchant-trust-data/data/exports/`, feature tables in `data/processed/`, model artifacts in `models/`, and application-ready indexes in `wallet-control/data/`. Merchant discovery data is included under `viseca-shopper-ui/data/`.

Larger collected source snapshots are bundled under `merchant-trust-data/data/snapshots/`. `manifest.json` records archive parts, sizes and SHA-256 hashes. Archives are split into ordinary Git files below GitHub's per-file limit, so Git LFS is not required. To restore a source, concatenate its parts in the manifest order, verify the SHA-256, and extract the resulting `.tar.gz` into `merchant-trust-data/data/raw/`. Extracted vendor trees are not duplicated when their original archive is available.

Read `merchant-trust-data/DATA_SOURCES.md` and `LICENSE_NOTES.md` for attribution, source-specific terms and limitations. Raw collections flagged for redistribution review remain outside this distribution; their collectors and provenance remain available. Private runtime state, caches, environments and agent memory are excluded.

## Verification

The wallet includes scenario, security, model-parity and customer-flow tests. The shopper includes backend, policy-review and reliability tests. For the Python data pipeline:

```sh
cd merchant-trust-data
make setup
make test
```

The wallet's defaults use offline scenarios. A running UI or signed receipt does not establish that an issuer or merchant executed a payment.
