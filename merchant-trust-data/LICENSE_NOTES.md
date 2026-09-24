# License Notes

Legal/practical analysis of what this repo may store and redistribute.
Applies a conservative rule: **if a license is unclear, the source is flagged
`LICENSE_REVIEW_REQUIRED` and its data is not treated as redistributable**
(until resolved, derived internal use only).

## Summary table

| source | license (as documented 2026-09-23) | store raw? | redistribute raw? | store derived features? | notes |
|---|---|---|---|---|---|
| OpenPhish community feed | free for non-commercial use w/ attribution; commercial needs subscription | yes (research) | non-commercial research only | yes | commercial productization ⇒ buy the commercial feed; do not ship community-feed URLs in a commercial product |
| URLhaus (abuse.ch) | free to use/share, attribution appreciated | yes | yes (per abuse.ch terms) | yes | API v2 needs free auth key; legacy `/downloads/` used and working 2026-09-23 |
| GLEIF LEI data | free and open, GLEIF terms of use (attribution, no warranty) | yes | yes, with attribution | yes | include attribution line: "Data © 2026 GLEIF, licensed under GLEIF terms" |
| Zefix | (c) Confederation/cantons; API terms on registration | blocked until token | `LICENSE_REVIEW_REQUIRED` | `LICENSE_REVIEW_REQUIRED` | review terms when registering for the free token |
| RDAP responses | factual registration metadata, per-registry terms | yes (parsed fields only) | yes | yes | we store only factual fields; no registrant personal data is intentionally stored |
| DNS lookups | n/a | yes | yes | yes | factual existence signals |
| Tranco Top Sites | free for research with attribution | yes | yes (research, w/ attribution) | yes | daily list; cite Tranco + list date in any publication |
| Majestic Million | free w/ attribution; commercial use needs license | yes | research use w/ attribution | yes | commercial productization ⇒ Majestic license |
| Google Product Taxonomy | free for product categorization | yes | yes | yes | snapshot dated in sidecar |
| Viseca synthetic pack | SYNTHETIC TEST DATA per repo (no real persons/transactions) | yes | yes per repo terms | yes | sha256-verified vs pack manifest at clean time |
| IBM TabFormer | synthetic, IBM research release | yes (research) | synthetic ⇒ low risk; keep IBM attribution | yes | do not present as real transactions |
| IEEE-CIS (via HF mirror) | Kaggle competition data; mirror is unofficial | yes (research) | `LICENSE_REVIEW_REQUIRED` for redistribution (competition rules govern) | yes | integrity-checked 590,540/20,661; official source needs Kaggle account |
| ULB Credit Card (OpenML 1597) | CC BY 4.0 | yes | yes w/ attribution | yes | benchmark/baseline only per project brief |
| HackAPrompt | MIT but gated access | once tokenized | yes (MIT) w/ access terms | yes | `LEASH_HF_TOKEN` via env only; never commit |
| Microsoft BIPIA | MIT | yes | yes, keep LICENSE/NOTICE | yes | |
| AgentDojo | MIT | yes | yes, keep LICENSE | yes | runs/ results included as published |
| Tensor Trust | permissive (per repo README) | yes | yes w/ attribution | yes | raw dumps contain anonymized player content |
| ThreatFox (abuse.ch) | free to use/share, attribution appreciated; non-commercial spirit per abuse.ch ToS (threatfox.abuse.ch/faq/#tos) | yes | yes per abuse.ch terms | yes | recent IOC export; API v2 would need free auth key |
| FeodoTracker (abuse.ch) | free to use/share, attribution appreciated; non-commercial per abuse.ch ToS | yes | yes per abuse.ch terms | yes | C2 IP blocklist (JSON preferred, CSV fallback) |
| MalwareBazaar (abuse.ch) | free, attribution appreciated; API needs free auth key | once reachable | yes per abuse.ch terms | yes | blob + API both 502 via egress proxy 2026-09-24 — BLOCKED; if unblocked, register free key at auth.abuse.ch (env `LEASH_ABUSECH_KEY`) |
| UN consolidated list | public data, (c) United Nations; no explicit reuse license — factual sanctions data | yes (research) | with attribution + UN disclaimer | yes | consolidated.xml streamed; keep "nor necessarily endorsed by the UN" style disclaimer on publication |
| OFAC SDN list | US Government work → public domain | yes | yes (keep Treasury attribution) | yes | legacy CSV with `-0-` placeholders |
| SECO Swiss sanctions | Swiss public data; collected via OpenSanctions mirror (source.xml as published); mirror adds CC BY-SA 4.0 | yes | mirror copy: CC BY-SA 4.0 w/ attribution (OpenSanctions + SECO) | yes | SECO site has no stable anonymous bulk URL (verified 2026-09-24); we store the original source.xml via OpenSanctions |
| EU consolidated list | EU public data | blocked | `LICENSE_REVIEW_REQUIRED` (needs EU Login) | — | bulk CSV redirects to EU Login even with `?anonymous=true` (verified 2026-09-24); probe recorded |
| AbuseIPDB | free tier: non-commercial w/ attribution; responses not for redistribution as-is | once keyed | `LICENSE_REVIEW_REQUIRED` for raw responses | derived features yes | API key required (401 unauthenticated, probe recorded 2026-09-24); env `LEASH_ABUSEIPDB_KEY` |
| Domain-health lookups (DNS/HTTP/Wayback CDX/crt.sh) | protocol lookups + public services, factual metadata | yes | yes | yes | Wayback/crt.sh used politely: bounded, cached, resumable; crt.sh capped at ≤500 domains/run |

## Provenance requirements

- Every dataset row carries `sources`, `source_urls`, `collected_at`,
  `data_license`, `collector_version` — attribution travels with the data.
- Raw copies live in `data/raw/<source>/` with `.meta.json` sidecars
  (URL, timestamp, sha256) so any dataset can be re-derived and audited.
- `data/raw/` and `data/processed/` are git-ignored: large downloads are not
  committed; they are reproducible via `make collect && make enrich && make build`.

## Open questions (do not silently resolve)

1. **OpenPhish redistribution wording** — the exact redistribution clause of
   the community feed should be re-verified against OpenPhish's current terms
   before any external publication of raw URLs. Flag: `LICENSE_REVIEW_REQUIRED`
   for *redistribution* (internal research use is within the free tier).
2. **Zefix terms** — read the API terms during token registration; confirm
   whether UID-level merchant records may be stored in a training dataset and
   under what attribution. Flag: `LICENSE_REVIEW_REQUIRED`.
3. **abuse.ch auth key** — if we move to API v2 downloads, the auth key is
   personal; the key itself must never be committed (env var only).
4. **Swiss personality/data-protection angle** — registered company data is
   public in CH, but combine conservatively: no personal-data enrichment
   (owners, representatives) without a separate legal review.

## Rule of thumb going forward

Authoritative registries + openly licensed threat feeds ⇒ safe core.
Anything scraped from platforms (social, reviews) ⇒ official APIs or
explicitly permitted access only; when in doubt, `LICENSE_REVIEW_REQUIRED`.
