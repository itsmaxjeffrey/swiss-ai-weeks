# LEASH merchant-trust-data — Data Quality Report

_Generated from dataset_features.parquet at build time._

## Row counts
- rows: **11484**
- unique merchant_id: **11484**
- unique entity_key: **11484**
- unique companies (registry_id): **6000**
- unique root domains: **5484**

## Entity type distribution
- company: 6000
- domain: 5484

## Label distribution
- likely_legitimate: 5926
- confirmed_malicious: 5484
- unknown: 74

## Country distribution (top)
- CH: 5968
- (unknown): 5484
- US: 7
- DE: 5
- LU: 4
- GB: 3
- LI: 3
- VG: 3
- NL: 1
- CO: 1
- IT: 1
- AT: 1

## Source distribution
- gleif: 6000
- urlhaus: 5322
- openphish: 167

## Missingness (key columns)
| column | missing % |
|---|---|
| registry_id | 47.8% |
| legal_company_name | 47.8% |
| domain | 52.2% |
| domain_creation_date | 98.9% |
| registrar | 99.0% |
| dns_a_exists | 98.6% |
| dns_mx_exists | 98.6% |
| company_status | 47.8% |
| incorporation_date | 47.8% |
| label_confidence | 0.0% |

_Note: missing = unknown/not-collected (three-state convention), never negative evidence._

## Duplicates: 0 duplicate entity_key rows

## Enrichment coverage
- rdap_available: known for 153/11484 rows (1.3%)
- dns_a_exists: known for 164/11484 rows (1.4%)
- dns_mx_exists: known for 164/11484 rows (1.4%)
