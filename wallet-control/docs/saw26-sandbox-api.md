# SAW26 Sandbox API Reference

Team sandbox for the Swiss AI Weeks 26 "Agent on a Leash" challenge (Viseca).
Source of truth: https://github.com/Swiss-ai-Weeks/viseca-2026/blob/main/technical_details.md

## Connection

- **Base URL:** `https://saw26api.ashyground-364e1d07.switzerlandnorth.azurecontainerapps.io`
- **Auth:** `Authorization: Bearer <TEAM_API_KEY>` on every endpoint except `/healthz`.
- Working key file (owner-approved plaintext fallback after the egress-proxy path failed): `wallet-control/.saw26-key` (chmod 600, gitignored). Call the sandbox DIRECT (`curl --noproxy '*'`) — never through the OpenClaw egress proxy (502s on CONNECT to this host; see 2026-09-25 memory). Verified 200 `/v1/bootstrap`, team33, 2026-09-25.
- The team key is stored in the OpenClaw secrets store as `VISECA_GITHUB_REPO_SANDBOX_TOKEN`
  (name is historical; it is the SAW26 sandbox API key, not a GitHub token),
  with `allowedHosts` pinned to the sandbox host above.
- Local data pack mirror: `merchant-trust-data/data/raw/viseca/extracted/viseca-2026-main/data/` (`pack_version: saw26`).

## Endpoints

| Call | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/healthz` | GET | no | Service health + version. |
| `/v1/bootstrap` | GET | key | Team settings: API/data versions, scenarios, timeouts, limits, features. |
| `/v1/reference-data` | GET | key | Catalogues: scenarios, fixed FX rates, history-file metadata. |
| `/v1/reference-data/authorization-history.csv` | GET | key | Historical activity CSV. |
| `/v1/mandates` | POST | key | Create draft mandate (`instruction`, `hard_rules`, `uncertainty_policy`, `guidance`, `open_questions`) → `draft_id`. |
| `/v1/mandates/{draft_id}/confirm` | POST | key | Confirm draft `{"confirmed":true}` → `mandate_id`. |
| `/v1/mandates/{mandate_id}` | GET/PATCH/DELETE | key | Read / tighten (add-only rules, `ask`/`approve`→`decline` only) / revoke. |
| `/v1/scenario-runs` | POST | key | Start run `{"scenario_id","mandate_id"}` → `run_id` (mandate is snapshotted per run). |
| `/v1/decision-requests/next?wait=25` | GET | key | Long-poll next purchase; 200 = event in `data`, 204 = none yet. |
| `/v1/authorizations/{authorization_id}/decision` | POST | key | Submit `approve` / `decline` / `step_up` (+ optional `reason_codes`, `customer_message`, `evidence`, `engine_version`). |
| `/v1/authorizations/{authorization_id}/resolve` | POST | key | Record the human's answer after `step_up` (never a second automated decision). |
| `/v1/team/reset` | POST | key | Clear mandates/runs/decisions/cursor. Disabled during judging. |

## Timing rules

- Decision deadline: **8 s** from queueing (read real values from `/v1/bootstrap`; `data.deadline_at` per event).
- Human `step_up` window: **120 s** default.
- Long-poll wait up to 25 s; `204` ≠ run finished — check progress and re-poll.
- Spending windows use simulated purchase time; deadlines use the real clock.
- Repeated delivery: dedupe by live `authorization_id`.

## Gotchas learned here

- A gateway-host exec run captures one store snapshot on its first exec; host-list edits on the
  secret entry do NOT refresh an already-started run's proxy authorization → run the call from a
  fresh run (new turn or subagent) after changing `allowedHosts`. (docs/tools/secrets.md#L161)
- Even a fresh run is not enough if the egress proxy process itself predates the host binding —
  `secrets.egressProxy` policy refresh needs a Gateway restart. (docs/gateway/config-secrets-env.md#L61)
- The connection-check scenario is `SCEN0000` (one purchase, `AU0001`); fixture at
  `data/scenario_fixtures/connection_check.json` is a readable copy, not a live event.
- API errors come back as JSON under `error`; always check HTTP status first.
