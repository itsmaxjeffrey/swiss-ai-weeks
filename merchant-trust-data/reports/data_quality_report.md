# LEASH merchant-trust-data — Data Quality Report

_Generated from dataset_features.parquet at build time._

## Row counts
- rows: **33706**
- unique merchant_id: **33706**
- unique entity_key: **33706**
- unique companies (registry_id): **28222**
- unique root domains: **5484**

## Entity type distribution
- company: 28222
- domain: 5484

## Label distribution
- likely_legitimate: 25606
- confirmed_malicious: 5484
- unknown: 2616

## Country distribution (top)
- CH: 27952
- (unknown): 5484
- US: 65
- DE: 50
- GB: 35
- LU: 16
- FR: 14
- SE: 11
- NL: 10
- LI: 8
- IT: 7
- VG: 7

## Source distribution
- gleif: 28222
- urlhaus: 5322
- openphish: 167

## Missingness (key columns)
| column | missing % |
|---|---|
| registry_id | 16.3% |
| legal_company_name | 16.3% |
| domain | 83.7% |
| domain_creation_date | 98.6% |
| registrar | 98.6% |
| dns_a_exists | 98.3% |
| dns_mx_exists | 98.3% |
| company_status | 16.3% |
| incorporation_date | 16.3% |
| label_confidence | 0.0% |

_Note: missing = unknown/not-collected (three-state convention), never negative evidence._

## Duplicates: 0 duplicate entity_key rows

## Enrichment coverage
- rdap_available: known for 1197/33706 rows (3.6%)
- dns_a_exists: known for 568/33706 rows (1.7%)
- dns_mx_exists: known for 569/33706 rows (1.7%)
