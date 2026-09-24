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
| `OPENCLAW_SESSION`    | `webui`          | Base session-key suffix — each account gets `<base>-u<id>` |
| `OPENCLAW_BIN`        | `openclaw`       | CLI binary                                |
| `OPENCLAW_MODEL`      | *(agent default)* | Model override passed as `--model` to every agent turn (e.g. `swissai/apertus-70b`) |
| `OPENCLAW_TIMEOUT_MS` | `600000`         | Max agent turn duration                   |
| `AGENT_MAX_CONCURRENT`| `2`              | Global agent-turn slots across all users  |
| `PUBLIC_BASE_URL`     | derived          | Base URL in plugin manifest/OpenAPI (falls back to `x-forwarded-*`) |
| `REGISTRATION_OPEN`   | `true`           | `false` closes signup                     |
| `PLANS_JSON`          | built-in         | Override plan caps, e.g. `{"free":{"daily":2}}` |
| `ACCOUNTS_DATA_DIR`   | `./data`         | Where accounts/sessions JSON lives        |
| `DEMO_MODE`           | `true`           | `false` disables the seeded demo account  |
| `DEMO_EMAIL` / `DEMO_PLAN` | `demo@pixerful.com` / `plus` | Demo account identity + plan |
| `DEMO_PASSWORD`       | *(random, logged once)* | Private demo password — **rotated onto the account on every boot when set** |

Because the agent id and session key are configurable, this bridge fronts
**any** OpenClaw agent:

```bash
OPENCLAW_AGENT=my-agent OPENCLAW_SESSION=dashboard PORT=8800 node server.js
```

## API

| Endpoint                      | Method | Auth          | Description                                                                 |
| ----------------------------- | ------ | ------------- | --------------------------------------------------------------------------- |
| `/api/health`                 | GET    | —             | `{ ok, agent, session, plans, registrationOpen, … }`                        |
| `/api/auth/register`          | POST   | —             | `{ email, password, name? }` → session cookie                               |
| `/api/auth/login`             | POST   | —             | `{ email, password }` → session cookie                                      |
| `/api/auth/logout`            | POST   | cookie        | clears the session                                                          |
| `/api/auth/me`                | GET    | cookie/key    | account + plan + today's usage                                              |
| `/api/account/plan`           | POST   | cookie/key    | `{ plan: "free\|plus\|premium" }` — instant switch (billing not wired)      |
| `/api/account/keys`           | GET    | cookie/key    | list API keys (masked)                                                      |
| `/api/account/keys`           | POST   | cookie/key    | `{ name }` → full `vsk_…` key, **shown only once**                          |
| `/api/account/keys/revoke`    | POST   | cookie/key    | `{ id }` — key stops working immediately                                    |
| `/api/chat`                   | POST   | cookie/key    | `{ message }` → SSE stream (`start`/`progress`/`done`/`error`)              |
| `/api/v1/chat`                | POST   | key/cookie    | `{ message }` → plain JSON `{ reply, usage }` — for ChatGPT Actions & skills |
| `/api/v1/account`             | GET    | key/cookie    | plan + daily usage                                                          |
| `/.well-known/ai-plugin.json` | GET    | —             | ChatGPT plugin manifest                                                     |
| `/openapi.json`               | GET    | —             | OpenAPI 3.0.3 spec for GPT Action import                                    |
| `/api/policy/pubkey`          | GET    | —             | order-policy verification key                                               |
| `/api/policy/sign`            | POST   | **cookie only** | signs/freeses an order policy (signed-in customers only)                  |
| `/api/account/shopping`       | GET    | cookie/key    | spend cap, whitelist, masked payment methods                                 |
| `/api/account/shopping/cap`   | PUT    | cookie/key    | `{ capChf: number\|null }` — max budget the agent may sign per order         |
| `/api/account/shopping/whitelist` | POST | cookie/key  | `{ domain }` — whitelist a website (normalizes URLs → bare domain)           |
| `/api/account/shopping/whitelist/remove` | POST | cookie/key | `{ domain }` — remove a whitelist entry                               |
| `/api/account/shopping/sites` | GET    | cookie/key    | `?q=` — search shops for the whitelist (curated catalog + optional web)      |
| `/api/account/shopping/methods` | POST | cookie/key    | `{ holder, number, exp, cvc }` — save a Visa/Mastercard (Luhn-checked)       |
| `/api/account/shopping/methods/default` | POST | cookie/key | `{ id }` — set the default card                                       |
| `/api/account/shopping/methods/delete` | POST | cookie/key | `{ id }` — remove a card                                              |

## Accounts & subscription plans

Every visitor registers (email + password, scrypt-hashed, cookie sessions) and
gets their own OpenClaw session — conversations never mix between accounts.

| Plan    | Daily messages | Price     |
| ------- | -------------- | --------- |
| Free    | 10             | CHF 0     |
| Plus    | 100            | CHF 9/mo  |
| Premium | 500 (fair use) | CHF 29/mo |

Plans are self-serve in the UI (Account → Subscription). Billing is **not
wired** — switching is instant and free until a payment provider exists.
Limits reset at midnight UTC; over-limit requests get HTTP 429 with plan info.

### Demo account (private)

For pitches and testing the bridge seeds one demo account on boot
(`DEMO_EMAIL`, default `demo@pixerful.com`, plan `DEMO_PLAN`, default `plus`).
Credentials are deliberately **not** in this repo — distribution is controlled
via `DEMO_PASSWORD`:

- set `DEMO_PASSWORD` and it is **rotated onto the account on every boot** —
  change the env, restart, and previously shared passwords stop working;
- leave it unset and first seed generates a random password, logged once to
  the server log;
- `DEMO_MODE=false` skips the account entirely.

There is no public demo-login endpoint — sign-in goes through the normal
login form. The account carries a `demo` badge in the UI.

## Add it to ChatGPT (plugin / GPT Action)

The bridge speaks the ChatGPT plugin protocol and modern GPT Actions:

- **GPT Action (recommended — plugins are retired):** in the GPT editor →
  Actions → import from URL: `https://<host>/openapi.json`. Authentication →
  API key → Bearer, paste an API key created in Account → API keys.
- **Classic plugin:** serve `/.well-known/ai-plugin.json` (done automatically);
  install via the plugin store with the bare domain.

Tell the model to relay shopping requests **verbatim** to `sendChatMessage` —
the manifest's `description_for_model` already says this, plus the long-turn
and 409/429 semantics.

## Add it to Claude / OpenClaw (skill)

`integrations/skills/viseca-shopper/SKILL.md` is a drop-in skill that teaches
any Claude- or OpenClaw-based agent to call the concierge over HTTP:

```bash
cp -r integrations/skills/viseca-shopper ~/.claude/skills/     # Claude Code/Desktop
cp -r integrations/skills/viseca-shopper ~/.openclaw/skills/   # OpenClaw
```

then set `VISECA_SHOPPER_URL` and `VISECA_SHOPPER_API_KEY` in that agent's
environment. The skill covers the long-turn timeout, the error table
(401/409/429/502/503) and quota checks via `/api/v1/account`.

## Tests

```bash
npm test    # 21 end-to-end tests: auth, plans, SSE chat, keys, /api/v1, plugin manifest
```

Runs against a stub OpenClaw CLI (`test/stub-openclaw.js`) and an isolated
accounts dir — no Gateway or agent needed.

## Notes

- Each account gets its own agent session (`<OPENCLAW_SESSION>-u<id>`) that
  persists across restarts — conversation history is private per user.
- One agent turn per account at a time (409 while busy); a global cap of
  `AGENT_MAX_CONCURRENT` turns protects the host (503 when saturated).
- The policy-signing path is cookie-auth-only — an API key can never freeze a
  spending mandate.

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

## Shopping controls (spend cap · website whitelist · card vault)

Every account has three purchase controls under **Account → Shopping settings**:

1. **Maximum spend per order** — a signed policy's `budget.max_total` may never
   exceed this cap. `null` (default) = unrestricted.
2. **Whitelisted websites** — search real shops (`/api/account/shopping/sites?q=`,
   curated Swiss catalog with optional web enrichment, `SHOPPING_WEB_SEARCH=0`
   disables it), click to whitelist. Once the whitelist is non-empty, a policy
   must declare `merchant.allowed_domains` and every domain must sit inside the
   whitelist (subdomains included). Empty whitelist = unrestricted.
3. **Payment method (Visa / Mastercard)** — cards are Luhn-checked, brand-locked
   (Visa/Mastercard only), and stored in `data/vault.json` (chmod 0600,
   gitignored). The API never returns full numbers — only brand + last4.

**How the agent pays:** cap and whitelist are enforced at `POST /api/policy/sign`
(refusal → HTTP 422 with a `violations` list the UI renders). On success the
bridge files the customer's card as `policies/<policy_id>.payment.json` in the
agent workspace (gitignored) — the agent reads it at the payment phase and
checks out with that card. Card data never passes through the model context,
and the agent is instructed to reference it only as "<brand> ••<last4>".
Signing before saving a card files a `card: null` note; saving a card later
backfills all still-unpaid policies so they don't need re-signing.

## Conversation history & Purchases view

- Every completed turn (user message, agent reply, error text) is stored per
  account under `data/history/<userId>.json` — capped at the last 100 entries.
  Reloading the page (or signing in from another browser) restores the chat;
  policy cards from stored history render **read-only** so a past policy can
  never be re-approved. `GET /api/history` / `DELETE /api/history` power this
  and the **clear** button in the stage header (the agent's own session memory
  is untouched by a clear).
- On a successful sign the bridge records `policy_id → account` in
  `data/policy-owners.json`; `GET /api/policies` then lists the account's own
  signed policies with receipt status (the agent files
  `policies/<policy_id>.receipt.json` after checkout). Shown under
  **Account → Purchases**. Policies are strictly per-account.
