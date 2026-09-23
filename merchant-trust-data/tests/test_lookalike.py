from processing.lookalike_detection import analyze_domain
from processing.labeling import label_gleif, label_threat


def test_typosquat_detected():
    r = analyze_domain("paypa1.com")
    assert r["closest_known_brand"] == "paypal"
    assert r["possible_brand_impersonation"] is True
    assert r["domain_typo_score"] < 0.25


def test_own_brand_not_flagged():
    r = analyze_domain("paypal.com")
    assert r["possible_brand_impersonation"] is False


def test_suspicious_subdomain():
    r = analyze_domain("paypal.secure-login.example.com")
    assert r["suspicious_subdomain_pattern"] is True
    assert r["possible_brand_impersonation"] is True


def test_benign_domain():
    r = analyze_domain("example.ch")
    assert r["possible_brand_impersonation"] is False
    assert r["brand_name_similarity"] is not None and r["brand_name_similarity"] < 0.8


def test_labels_conservative():
    lbl, conf, src, _ = label_threat({"openphish", "urlhaus"})
    assert lbl == "confirmed_malicious" and conf >= 0.95
    lbl, conf, _, reason = label_gleif("ACTIVE")
    assert lbl == "likely_legitimate" and conf < 0.8
    assert "not" in reason or "Phase 2" in reason  # never claims full verification
    lbl, conf, _, _ = label_gleif("INACTIVE")
    assert lbl == "unknown"
