from processing.normalize_company import normalize_company_name
from processing.normalize_domain import is_punycode, normalize_domain, root_domain


def test_company_name_variants_converge():
    a = normalize_company_name("ACME Electronics GmbH")
    b = normalize_company_name("Acme Electronics")
    c = normalize_company_name("ACME ELECTRONICS GMBH")
    assert a == b == c == "acme electronics"


def test_company_name_accents_and_legal_forms():
    assert normalize_company_name("Café Müller Sàrl") == "cafe muller"
    assert normalize_company_name("Nestlé S.A.") == "nestle"
    assert normalize_company_name("The Example Company Limited") == "example"


def test_normalize_domain_from_url():
    assert normalize_domain("https://WWW.Example.com/path?x=1#frag") == "example.com"
    assert normalize_domain("http://user:pw@sub.Example.ch:8080/x") == "sub.example.ch"
    assert normalize_domain(None) is None
    assert normalize_domain("") is None


def test_root_domain():
    assert root_domain("paypal.com") == "paypal.com"
    assert root_domain("secure.paypal.com") == "paypal.com"
    assert root_domain("example.b.co.uk") == "b.co.uk"
    assert root_domain("something.co.uk") == "something.co.uk"


def test_punycode_flag():
    assert is_punycode("xn--80ak6aa92e.com")
    assert not is_punycode("example.ch")
