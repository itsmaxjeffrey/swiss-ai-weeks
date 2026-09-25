# Dieci shopper incident and repair — 25 September 2026

## Confirmed failure chain
The request started at 10:21:01 CEST. At 10:25 the shopper found the browser unavailable. A browser start appeared to succeed, but opening Dieci failed with a gateway transport timeout. The agent followed its browser-cli-fallback workshop skill and invoked shared plugin reload and then enable. Both failed during drain, leaving the browser plugin unavailable. It spent the remaining time trying raw HTTP inspection of Dieci delivery branches.

At 10:31:12 the underlying OpenClaw run reached its 599,996 ms deadline and ended without a final response. The bridge allowed 890 seconds but did not pass an agent timeout, so OpenClaw used its 600-second default. The UI exposed only the no-reply symptom. A later pickup failed because the agent runtime was unavailable.

The trace contains no cart addition, checkout, payment, or merchant confirmation. The request was still at branch discovery. The original gateway transport slowdown coincided with delayed heartbeats and SQLite stalls; the evidence does not establish one exclusive cause for that first timeout. The failed plugin replacement and deadline mismatch are directly established.

## Repairs applied
- Restarted the failed gateway through its existing user service and verified its ready/listening state. Started the browser through the operator path after gateway recovery.
- Denied the shopper agent the plugin and gateway administration tools; verified both absent from its effective tool list.
- Corrected the two workshop skills and workspace instructions: policy approval comes before shopping/feasibility browsing, infrastructure failure must end the turn, and shoppers must not reload shared services or reconstruct checkout APIs.
- Added a browser CLI wrapper with a 20-second deadline and marked-process cleanup. It reports BROWSER_UNAVAILABLE for hangs and plugin faults.
- Passed an explicit agent deadline from every bridge call, with response-delivery headroom. The deployed 890-second bridge budget now gives the agent 880 seconds.
- Applied exact environment-marker cleanup to bridge timeout handling, covering supervised/detached CLI children.
- Disabled automatic retry and model-driven late pickup by default. This avoids silently restarting an interrupted purchase. Legacy opt-in paths remain explicitly documented.
- Added clearer runtime/timeout messages directing customers to establish order status before retrying.
- Deployed bridge build `shopper-reliability-1`; preserved all pre-existing uncommitted project work and kept rollback copies.

## Verification
- Full configured shopper suite: 72 tests passed, zero failures.
- Companion browser-wrapper failure test: passed. Exercises a hang, plugin failure, successful response, and refused destructive lifecycle command.
- Bridge failure tests exercise deadline forwarding, runtime classification, detached child cleanup, no automatic resubmission, and capacity recovery for the next request.
- Live shopper test with browser stopped: returned an honest blocker in 28.245 seconds and attempted no service/plugin repair.
- Browser navigation: bounded helper successfully opened https://webshop.dieci.ch/de/ with title Dieci. A subsequent ARIA snapshot succeeded with the default 20-second bound. During verification the agent used the unsupported shorthand `snapshot t1`; the wrapper now normalizes that to `snapshot --target-id t1`, and command errors are distinguished from infrastructure outages. The wrapper regression test was rerun successfully after this fix.
- Public shopper health reports the deployed build; public browser UI loads and reports connected.

## Changed areas
`viseca-shopper-ui/server.js`, `turn-reliability.js`, `package.json`, `README.md`, and reliability/browser-wrapper tests; an explicit opt-in was added to the existing legacy late-delivery test.

Companion agent: `scripts/browser-safe.js`, `AGENTS.md`, and the checkout-feasibility/browser-cli-fallback workshop skills. OpenClaw config: only the viseca-shopper agent tool deny list was extended.

## Limits
These changes prevent the observed plugin-reload path through the shopper's administrative tools and bound the instructed browser workflow. They are not full OS isolation: the shopper still has exec, and instruction-level restrictions are not equivalent to a sandbox. The precise initial gateway slowdown may recur; the shopper should then return a blocker instead of spending ten minutes on repairs. Process cleanup cannot prove a merchant-side payment was cancelled. No real order or payment was placed during verification. No shared Git changes were committed or pushed.
