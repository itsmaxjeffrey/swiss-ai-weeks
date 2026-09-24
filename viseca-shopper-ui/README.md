# Viseca Shopper UI

A chat interface for the **viseca-shopper** OpenClaw agent — a personal shopping
concierge styled as a Swiss editorial sheet: warm paper, ink hairlines, Swiss red,
and a serif "concierge voice" for agent replies.

![stack](https://img.shields.io/badge/deps-zero-b30015) ![node](https://img.shields.io/badge/node-%E2%89%A518-17150f)

```
┌──────────────┐   POST /api/chat   ┌───────────────┐   openclaw agent …   ┌──────────────┐
│  Browser UI  │ ─────────────────▶ │  server.js    │ ───────────────────▶ │  OpenClaw    │
│  (public/)   │ ◀───────────────── │  (no deps)    │ ◀─────────────────── │  Gateway     │
└──────────────┘   JSON reply       └───────────────┘   --json stdout      └──────────────┘
                                                                              │
                                                                       agent: viseca-shopper
                                                                       session: webui (persistent)
```

The browser never talks to the Gateway directly — the bridge keeps the Gateway
off the network surface entirely.

## Quick start

```bash
npm start            # or: node server.js
# open http://127.0.0.1:8794
```

Requires the `openclaw` CLI on `PATH`, logged into a Gateway that has the
`viseca-shopper` agent configured.

## Configuration (environment)

| Variable              | Default          | Purpose                                   |
| --------------------- | ---------------- | ----------------------------------------- |
| `PORT`                | `8794`           | HTTP port                                 |
| `HOST`                | `127.0.0.1`      | Bind address (keep loopback unless you know) |
| `OPENCLAW_AGENT`      | `viseca-shopper` | Any OpenClaw agent id works               |
| `OPENCLAW_SESSION`    | `webui`          | Session-key suffix — keeps conversation history across reloads |
| `OPENCLAW_BIN`        | `openclaw`       | CLI binary                                |
| `OPENCLAW_TIMEOUT_MS` | `300000`         | Max agent turn duration                   |

Because the agent id and session key are configurable, this bridge fronts
**any** OpenClaw agent:

```bash
OPENCLAW_AGENT=my-agent OPENCLAW_SESSION=dashboard PORT=8800 node server.js
```

## API

| Endpoint            | Method | Description                                                                 |
| ------------------- | ------ | --------------------------------------------------------------------------- |
| `/api/health`       | GET    | `{ ok, agent, session, bridge, busy }`                                      |
| `/api/chat`         | POST   | `{ message }` → `{ reply, agent, session }` — one turn at a time (409 when busy) |

Messages are forwarded as a single agent turn via
`openclaw agent --agent <id> --session-key <key> --json -m "<message>"`.
The reply is read from the CLI JSON output (`finalAssistantVisibleText`).
Agent markdown (headings, lists, bold, links, code) is rendered in the UI.

## Notes

- The agent session persists across server restarts (stable session key), so
  the conversation continues where it left off.
- One agent turn runs at a time; the composer disables while the agent works.
- Serve through a reverse proxy or an SSH tunnel if you need remote access —
  the server itself only authenticates nothing by design and is meant for
  loopback use.

## Order Policy Gate

Every purchase runs under a fixed, signed, time-bound **order policy**:

1. The agent drafts the policy from the customer's request and posts it in a
   ```policy-json fenced block — the UI renders it as an **approval card**.
2. The customer presses **Approve & Sign** → the bridge validates completeness
   and signs the canonical JSON with its **Ed25519 authority key**
   (`keys/policy-authority.private.pem`, mode 0600, held OUTSIDE the agent
   workspace). The signed envelope lands in the agent workspace as
   `policies/<policy_id>.signed.json`.
3. The agent must pass `node scripts/policy.js check` (signature + completeness
   + time window) before searching, before checkout, and before payment. Any
   edit to a signed policy breaks the signature; expired `order_by` /
   `deliver_by` windows fail the gate. Incomplete policies are refused with
   HTTP 422 + the missing-field list — the agent must ask, never guess.

Bridge config (env): `POLICY_AGENT_WS`, `POLICY_SCRIPT`, `POLICY_DIR`,
`POLICY_KEYS_DIR`, `POLICY_PUB_OUT`. `GET /api/policy/pubkey` exposes the
verification key; `POST /api/policy/sign {policy}` is the only signing path.
