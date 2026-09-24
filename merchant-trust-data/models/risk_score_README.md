# Linear risk score (0-100), interpretable spec

risk = clip(100 * (b0 + sum(c_i * x_i)), 0, 100)

Encoding: booleans 1=True / 0=False / 0.5=unknown; numeric missing ->
median impute + `_missing`=1.

## Path A — registry data available (companies)
b0 = 40
  company_age_days_missing: +80 points (no registry record)
  registry_found:           -40 points (registered company)
Univariate-only signal in this dataset; behavioral features earned no
weight because no legitimate domain-only merchants exist to teach them.

## Path B — behavioral (registry-free; use when entity is domain-only
or registry unknown)
b0 = 40, ridge alpha 0.1, test AUC 0.98 (mal median 93.4, legit 1.7)
  urlhaus_hit:                  +165.6 (clip makes this a hard flag -> 100)
  domain_age_days_missing:       -72.6 (no RDAP record -> slightly safer
                                 here, artifact of feed composition; treat
                                 as 0 in production)
  dns_txt_exists:                +24.0
  dns_mx_exists:                 +21.4
  possible_brand_impersonation:  +15.6
  domain_typo_score (0-1):       +8.7 per unit
  brand_name_similarity (0-1):   -8.7 per unit
  dns_a_exists:                   -5.2

Known artifacts: negative openphish_hit (feed composition) and the
domain_age_days_missing negative weight are dataset quirks, not real
protective effects. Recommend hard floor: any threat-intel hit -> risk >= 90.

Root cause of quirks: zero legitimate domain-only merchants in training
data. Fix by collecting legit domains (Tranco top sites) and retraining.
