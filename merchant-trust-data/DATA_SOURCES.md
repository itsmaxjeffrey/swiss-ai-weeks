# Data Sources

Every source used by this pipeline, with access method, license, and
redistribution status. **Never ingest a source with unknown license into a
redistributable dataset** — flag it `LICENSE_REVIEW_REQUIRED` and leave it out.

Status legend: ✅ collected · 🟡 interface ready, awaiting credential · ⏳ planned

| source | what it gives us | access | license | raw data redistributable? | status |
|---|---|---|---|---|---|
| OpenPhish community feed | confirmed phishing URLs (active) | `https://openphish.com/feed.txt`, no auth | free for **non-commercial** use, attribution required; commercial use requires paid subscription | non-commercial only; keep derived features + URLs for research, do not resell | ✅ |
| URLhaus (abuse.ch) | malware-distribution URLs + tags | `https://urlhaus.abuse.ch/downloads/csv_recent/`, no auth (API v2 requires free auth key from auth.abuse.ch) | free to use and share; attribution appreciated (abuse.ch, URLhaus) | yes, per abuse.ch terms | ✅ |
| GLEIF LEI records | authoritative legal-entity identity (name, status, address, legal form, LEI, dates) | `https://api.gleif.org/api/v1/lei-records`, no auth, paginated | free and open; GLEIF terms of use (attribution, no warranty) | yes, per GLEIF terms | ✅ |
| Zefix (Swiss central business index) | Swiss registry of commerce: legal name, UID, status, canton | REST API `zefix.ch/ZefixPublicREST/api/v1` — **requires registered (free) API token**; unauthenticated calls return 401 (verified 2026-09-23); token/access requests: **zefix@bj.admin.ch** (official BJ contact, verified on bj.admin.ch 2026-09-23); API docs: zefix.admin.ch/ZefixPublicREST/swagger-ui/index.html | Zefix data (c) Confederation/cantons; API terms apply | review Zefix terms after token; `LICENSE_REVIEW_REQUIRED` until then | 🟡 collector implemented (`collectors/zefix.py`); set `LEASH_ZEFIX_TOKEN`, flip `zefix.enabled` |
| RDAP (rdap.org → registry RDAP) | domain registration: creation/expiry, registrar, nameservers, status | `https://rdap.org/domain/{domain}`, redirects to authoritative registry (rdap.nic.ch for .ch, Verisign for .com); cached per domain, polite sleep | registry factual metadata; per-registry terms | yes (factual registration data; no WHOIS privacy content stored) | ✅ bounded (250 domains/run) |
| DNS | A / MX / TXT existence, NXDOMAIN | dnspython resolver, cached batches | n/a (protocol lookups) | yes | ✅ bounded (400 domains/run) |
| Tranco Top Sites | ranked legitimate top-1M domains (benign reference / reputation baseline) | `https://tranco-list.eu/top-1m.csv.zip` (daily list), no auth | free for research with attribution (tranco-list.eu); kit-excluded data | yes, per Tranco terms (research) | ✅ collected 2026-09-23 |
| Majestic Million | top-1M domains by referring subnets (independent benign reference) | `https://downloads.majestic.com/majestic_million.csv`, no auth | free w/ attribution; commercial use needs license | yes w/ attribution | ✅ collected 2026-09-23 |
| Google Product Taxonomy | category id → full path hierarchy (product normalization, intent mismatch) | `google.com/basepages/producttype/taxonomy-with-ids.en-US.txt`, no auth | free to use for product categorization | yes | ✅ collected 2026-09-23 |
| Viseca public synthetic pack (`Swiss-ai-Weeks/viseca-2026`) | Swiss synthetic authorizations, merchants, cards, customers, LLM-agent shopping scenarios + JSON schemas | repo tarball `codeload.github.com/Swiss-ai-Weeks/viseca-2026/...`, no auth | synthetic test data; license per repo README (SYNTHETIC TEST DATA, no answer key) | yes (synthetic) | ✅ collected 2026-09-23 (sha256 verified vs pack manifest) |
| IBM TabFormer credit-card transactions | 24M synthetic transaction sequences (behavioral transaction-risk training) | git-lfs object via `media.githubusercontent.com/media/IBM/TabFormer/...` (Box fallback: `ibm.box.com/v/tabformer-data`) | synthetic data released for research (IBM/TabFormer) | yes (synthetic; research use) | ✅ collected 2026-09-23 |
| IEEE-CIS Fraud Detection | Vesta transaction/device/identity features + isFraud (device/session-risk modeling) | **unofficial HF mirror** `aliceczr/ieee-fraud-detection` (official Kaggle needs credentials + rule acceptance) | competition data; mirror used for research; verify integrity after download | review before any redistribution | ✅ collected 2026-09-23 (590,540 rows / 20,661 frauds verified) |
| ULB Credit Card Fraud | 284,807 PCA'd transactions, 492 frauds (baseline/benchmark only) | OpenML did 1597 `api.openml.org/data/v1/download/1673544/creditcard.arff`, no auth | CC BY 4.0 (per OpenML/ULB) | yes w/ attribution | ✅ collected 2026-09-23 |
| HackAPrompt | adversarial prompt-hacking inputs + difficulty (prompt-injection detector training) | HF `hackaprompt/hackaprompt-dataset` — **gated (auto-approve)**: needs `LEASH_HF_TOKEN` | MIT | yes once access granted | 🟡 gated; collector token-ready |
| Microsoft BIPIA | indirect prompt-injection benchmark (QA/email/table/code/abstract) | repo tarball `codeload.github.com/microsoft/BIPIA/...`, no auth | MIT (per repo LICENSE/NOTICE) | yes | ✅ collected 2026-09-23 |
| AgentDojo (ETH) | tool-using agent tasks, injection vectors, published attack/utility results | repo tarball `codeload.github.com/ethz-spylab/agentdojo/...`, no auth | MIT (per repo LICENSE) | yes | ✅ collected 2026-09-23 |
| Tensor Trust | 126k+ crowdsource prompt-injection attacks / 46k defenses + robustness benchmarks | targeted files from `HumanCompatibleAI/tensor-trust-data` raw.githubusercontent.com | permissive (per repo README) | yes | ✅ collected 2026-09-23 |
| ThreatFox (abuse.ch) | recent IOCs (domains/IPs/URLs, malware family, confidence) | `https://threatfox.abuse.ch/export/csv/recent/`, no auth | free to use/share, attribution appreciated (abuse.ch ToS) | yes per abuse.ch terms | ✅ collected 2026-09-24 |
| FeodoTracker (abuse.ch) | C2 IP blocklist w/ malware family (Emotet/QakBot/…) | `https://feodotracker.abuse.ch/downloads/ipblocklist.json` (CSV fallback), no auth | free to use/share, attribution appreciated | yes per abuse.ch terms | ✅ collected 2026-09-24 (recent list is small — JSON/CSV variants both tiny) |
| MalwareBazaar (abuse.ch) | malware sample metadata (daily JSON blob / get-recent API) | blob `mbexport.blob.core.windows.net/malwaredata/<date>_malwarebazaar.json`; API `malwarebazaar.abuse.ch/api/v1/` (free auth key) | free, attribution appreciated; API needs free auth key | yes per abuse.ch terms | 🟡 BLOCKED: blob + API both 502 via egress proxy (2026-09-24, probed + retried); collector implemented, records probe |
| UN consolidated sanctions list | designated individuals/entities (names, aliases, listed-on dates) | `https://scsanctions.un.org/resources/xml/en/consolidated.xml` (302 → follow), no auth | public data (c) United Nations; factual sanctions data | yes w/ attribution + UN disclaimer | ✅ collected 2026-09-24 |
| OFAC SDN list | US sanctions designations (names, programs, remarks) | `https://www.treasury.gov/ofac/downloads/sdn.csv`, no auth | US Gov work → public domain | yes w/ Treasury attribution | ✅ collected 2026-09-24 (bonus) |
| SECO Swiss sanctions list | Swiss embargo designations (programs, targets, names) | no stable anonymous bulk URL on seco.admin.ch (verified 2026-09-24) → collected via OpenSanctions mirror `source.xml` (original SECO XML as published) | Swiss public data; mirror CC BY-SA 4.0 | yes w/ attribution (SECO + OpenSanctions) | ✅ collected 2026-09-24 via mirror |
| EU consolidated sanctions list | EU-wide designations | `webgate.ec.europa.eu/fsd/.../sanctions_conso.csv` — **redirects to EU Login** even with `?anonymous=true` (verified 2026-09-24, cookie jar) | EU public data | review after access | 🟡 BLOCKED-needs-login: probe recorded; needs EU Login account or alternate official channel |
| Domain-health enrichment (DNS MX/NS/A/SPF + HTTP liveness/parked-sniff + Wayback CDX first-seen + crt.sh first-seen) | per-threat-domain liveness/age signals | dnspython + polite HEAD/GET + `web.archive.org/cdx/...` + `crt.sh/?output=json` (crt.sh capped ≤500/run) | protocol lookups + public services, factual metadata | yes | ✅ run 2026-09-24 over all confirmed-malicious root domains (resumable JSONL cache) |
| AbuseIPDB | IP reputation (abuse confidence score) | `api.abuseipdb.com/api/v2/check` — **API key required** (401 unauthenticated, probe recorded 2026-09-24) | free tier: non-commercial w/ attribution | `LICENSE_REVIEW_REQUIRED` for raw responses | 🟡 BLOCKED-pending-key: free key at abuseipdb.com/account/api → `LEASH_ABUSEIPDB_KEY`; scaffold key-ready |

## Planned / queued

| source | purpose | blocker |
|---|---|---|
| opendata.swiss (CKAN API) | discover further Swiss open datasets | probe reachable (HTTP 302 → OK); dataset selection pending |
| **Zefix via opendata.swiss SPARQL (Lindas)** | **token-free official Zefix core data**: daily-updated name/seat/domicile of active register-entered legal entities; SPARQL examples linked from the dataset page | verified to exist 2026-09-23 (opendata.swiss dataset "Zefix – Zentraler Firmenindex"); collector TODO |
| Companies House (UK) | UK registry | free API key requires account signup |
| OpenCorporates | multi-country registry aggregation | API key required; license restricts redistribution — `LICENSE_REVIEW_REQUIRED` |
| SEC EDGAR | US company identities | free, no key; queued for Phase 3 |
| UID-Register (uid.admin.ch) | Swiss UID validation | API registration required |
| Reddit / consumer complaints | reputation signals (low weight, aggregates only) | Phase 3; official interfaces only, no scraping of restricted surfaces |
| Cloudflare Radar Domain Rankings | 3rd maintained benign popularity baseline next to Tranco/Majestic; CSV downloads (global/per-country, up to 1M) | free, no auth (radar.cloudflare.com/domains); collector TODO |
| Curlie (DMOZ successor) Shopping directory | human-curated shopping-site directory incl. regional categories → whitelist expansion candidates; RDF dump via curlie.org/download | open license; dump is large → prune, then gate by Tranco rank or RDAP domain age |
| Wikidata SPARQL (query.wikidata.org) | CC0; retail/e-commerce/marketplace companies + `official website` → domain candidates with industry labels | query + normalization work only |
| Swiss Online Garantie (HANDELSVERBAND.swiss trustmark) | 400+ certified Swiss online shops → highest-signal CH whitelist source; verified directory exists 2026-09-24 (swiss-online-garantie.ch/onlineshops/) | no bulk export → polite scrape; `LICENSE_REVIEW_REQUIRED` |
| Trusted Shops public API (api.trustedshops.com) | per-domain quality-seal/review lookup to *annotate* whitelist candidates (not bulk enumeration) | ToS review for bulk use |
| Google Safe Browsing Lookup API | free negative validation: confirm whitelist candidates are not blocklisted | API key; responses non-redistributable |
| Trustpilot public API | review-score annotation per domain (trust signal) | free key required; ToS review |
| National EU trustmark directories (FEVAD FR, Thuiswinkel NL, Ecommerce Europe network) | certified-shop domains per country → cross-border whitelist coverage | per-trustmark scraping/ToS review |

## Notes

- Switzerland-first: the Phase-1 Swiss subset comes from the GLEIF
  `filter[entity.legalAddress.country]=CH` slice (28,215 CH-registered LEI
  records exist; we sample). Bias: LEI population skews financial/large
  firms — documented, and Zefix will broaden coverage once the token exists.
- Threat-intel sources are treated as *evidence*, not absolute truth: every
  row keeps `threat_sources`, `threat_first_seen/last_seen`, and sample URLs
  so labels stay traceable and reversible.
- `PROGRESS.md` tracks per-source run status, counts, and errors.
