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
