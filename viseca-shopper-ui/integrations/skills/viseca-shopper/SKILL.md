---
name: viseca-shopper
description: Shop with the Viseca Shopper concierge (Swiss online shops) over its HTTP API. Use when the user asks this agent to find, compare, or buy products via Viseca Shopper, or explicitly mentions the Viseca Shopper concierge. Requires VISECA_SHOPPER_URL and VISECA_SHOPPER_API_KEY.
---

# Viseca Shopper — concierge API

A live personal-shopping agent for Swiss online shops (find products, compare
prices, plan purchases, propose order policies). This skill calls its HTTP API
on behalf of a human account.

## Setup (check before first call)

- `VISECA_SHOPPER_URL` — base URL, e.g. `https://viseca-shopper.pixerful.com`
- `VISECA_SHOPPER_API_KEY` — key in the form `vsk_<id>_<secret>` (Account →
  API keys in the web UI). The key inherits that account's subscription plan
  and daily message limits.

If either is missing, tell the user exactly which env vars to set — never
guess a URL or reuse another service's key.

## Calling

One conversational turn per call (POST). The agent really browses shops, so a
reply can take **several minutes** — always allow a long client timeout:

```sh
curl -sS --max-time 900 "$VISECA_SHOPPER_URL/api/v1/chat" \
  -H "Authorization: Bearer $VISECA_SHOPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message": "<the user'"'"'s shopping request, verbatim>"}'
```

Success `200`:

```json
{ "reply": "…markdown answer with product links…", "usage": { "used": 3, "limit": 100, "remaining": 97 } }
```

Pass the user's request **verbatim** — do not paraphrase or pre-filter it. The
concierge decides how to search. Relay `reply` to the user as-is (it is
markdown); add nothing of your own unless the user asks for commentary.

Check remaining quota any time:

```sh
curl -sS "$VISECA_SHOPPER_URL/api/v1/account" -H "Authorization: Bearer $VISECA_SHOPPER_API_KEY"
```

## Error handling

| Status | Meaning | What to do |
| --- | --- | --- |
| 401 | Key missing/invalid/revoked | Tell the user; do not retry |
| 409 | This account's previous turn is still running | Wait ~30 s, retry once; then report |
| 429 | Daily plan limit exhausted | Report the limit; user upgrades in the web UI (Account → Subscription) |
| 502 | The agent turn failed | Report the `error` text; a retry consumes another message |
| 503 | All agent slots busy | Wait ~30 s, retry once |

Never fabricate products, prices, or links when the API fails — say the
concierge could not answer. One turn = one message from the account's daily
allowance; do not loop retries.
