# Wallet permissions and purchase review

The wallet adds controls that apply across its recorded runs, durable purchase activity, signed policy and decision records, browser approval, and isolated purchase previews.

## Controls

Pause spending immediately, set a per-purchase CHF maximum, or set day, week and month totals. Calendar limits use Europe/Zurich dates; weeks start Monday. Daily order counts include accepted purchases from other runs. Purchases received out of chronological order still count against the same calendar bucket. A late human approval is also checked against rolling policy windows ending at later accepted purchases.

Further restrictions cover merchant country and city, weekdays, returnable or cancellable items, delivery days, item identifiers, sizes and total quantity. Missing required evidence requests review instead of being treated as permission. One-purchase permission closes after its first accepted purchase. Changing controls uses a version check, so an older browser cannot silently overwrite a newer change.

## Review and activity

Purchase identity and policy facts are bound together before processing. Changed facts under an existing authorization require fresh review. Human approval rechecks current permissions, spending and expiry. Resolution is serialized: conflicting answers cannot both reach the platform. Revoking a policy closes its pending reviews. Accepted decisions and spending survive restart. Pending submissions reserve their amount until their outcome can be reconciled.

The activity view collects decisions across runs. Explanations include applicable controls and next steps such as supplying missing evidence, reducing a basket or creating a new permission after an errand completes. These suggestions do not override a confirmed limit.

## Try a purchase and policy replay

The purchase form accepts an item, merchant, amount, quantity and supporting terms, then runs the same decision engine against the current policy or a signed draft. No payment is made and no live ledger entry is created. Customer history is not assumed for a purchase preview.

Policy replay evaluates up to 250 retained purchase events chronologically. Each replay builds its own spending ledger from its new decisions; previous answers and supplied prior-spend counters do not determine the new outcome. Only retained events containing the required purchase facts are replayable. Historical evidence can be incomplete, in which case review remains appropriate.

## Signed records

The wallet signs policy and decision documents with its private Ed25519 authority. The public verification endpoint checks a record against this wallet's signing key, including the entire document. Editing its payload invalidates its signature. Signed receipts show which policy and decision were issued; they do not independently establish that a merchant fulfilled an order. Audit entries form a hash chain checked when durable storage loads.

## Browser enrollment

The browser creates a P-256 key and requests enrollment. An authorized browser can approve or revoke another browser. Requests bind the HTTP method, URL, timestamp, nonce and body digest to the enrolled key. Reusing a request is rejected during its validity window.

For the first browser, submit its pairing request in the interface and obtain its displayed device ID. An operator on the wallet host can approve that exact ID using the private pairing credential at `data/.wallet-private/pairing-key`. Send an authenticated local `POST /api/internal/devices/DEVICE_ID/approve` to the wallet listener, loading the file directly into the request's bearer header. Never print the credential, paste it into chat, put it in browser code or commit it. When `LEASH_STATE_FILE` is customized, the private directory is `.wallet-private` beside that state file. Confirm the ID and browser name before approval.

Only isolated offline tests may set `LEASH_MODE=offline` with `LEASH_DEVICE_AUTH=off`. Live operation requires enrollment. Keep the private directory owner-readable only and excluded from version control.

## Operational boundaries

This is a single-host, single-writer wallet. A process lock prevents another wallet process from issuing decisions against the same private directory. State writes use a temporary file, fsync and rename; corrupt state or a failed write stops spending rather than starting an empty ledger. The health endpoint reports writer, storage, platform and unresolved-submission status. Reservations with uncertain upstream outcomes require reconciliation before their spending allowance is released.

Controls apply to the wallet's recorded activity; purchases bypassing this wallet are not automatically imported. Hash chaining detects changed local journal entries but does not provide an external timestamp service. A host administrator with the private signing key controls the signing authority. Browser enrollment protects wallet API access; it is not a replacement for host security or separate account isolation.

## Verification

`npm test` includes calendar/DST boundaries, cross-run and late spending limits, missing evidence, malformed baskets, version conflicts, corrupt storage, signed-document tampering, device request replay, preview isolation, expired human approvals and conflicting resolutions.
