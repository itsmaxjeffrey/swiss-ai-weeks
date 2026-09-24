"""Tests for Phase-3 external collectors/parsers (threatfox, feodotracker,
sanctions, domain_health). Parsers are pure functions fed with fixture text —
no network access."""

from __future__ import annotations

import json
import pathlib

import pandas as pd
import pytest

from processing.clean_external import _host_from_ioc, _read_comment_csv
from collectors.domain_health import crtsh_first_seen, wayback_first_seen  # noqa: F401  (import check)


# ------------------------------------------------------------- threatfox

THREATFOX_SAMPLE = """\
################################################################
# ThreatFox IOCs: recent additions - CSV format                #
################################################################
#
# "first_seen_utc","ioc_id","ioc_value","ioc_type","threat_type","fk_malware","malware_alias","malware_printable","last_seen_utc","confidence_level","is_compromised","reference","tags","anonymous","reporter"
"2026-09-24 09:30:35", "1932212", "https://www.cedipay.cash/", "url", "payload_delivery", "unknown", "None", "Unknown malware", "", "90", "False", "https://example.com/ref", "ClickFix", "0", "CarsonWilliams"
"2026-09-24 09:11:10", "1932209", "155.103.71.242:14643", "ip:port", "botnet_cc", "win.remcos", "None", "Remcos", "", "100", "False", "None", "c2", "0", "Bitsight"
"2026-09-24 09:11:11", "1932208", "xnjwhp5s.arayemek.com", "domain", "payload_delivery", "js.clearfake", "None", "ClearFake", "", "100", "False", "None", "ClearFake", "1", "anonymous"
"""


def test_read_comment_csv_extracts_header_from_hash_comments(tmp_path: pathlib.Path):
    p = tmp_path / "threatfox.csv"
    p.write_text(THREATFOX_SAMPLE)
    df = _read_comment_csv(p)
    assert "ioc_value" in df.columns
    assert len(df) == 3
    assert df.iloc[0]["ioc_value"].strip() == "https://www.cedipay.cash/"


def test_host_from_ioc_variants():
    assert _host_from_ioc("https://WWW.Example.com/path", "url") == "www.example.com"
    assert _host_from_ioc("Sub.Evil.CH", "domain") == "sub.evil.ch"
    assert _host_from_ioc("196.251.107.252:22063", "ip:port") == "196.251.107.252"
    assert _host_from_ioc("9.9.9.9", "ip") == "9.9.9.9"
    assert _host_from_ioc("", "url") is None
    assert _host_from_ioc("not a url", "unknown_type") is None


# ----------------------------------------------------------- feodotracker

FEODO_SAMPLE = [
    {"ip_address": "162.243.103.246", "port": 8080, "status": "offline",
     "hostname": None, "as_number": 14061, "as_name": "DIGITALOCEAN-ASN",
     "country": "US", "first_seen": "2022-06-04 21:24:53",
     "last_online": "2026-03-07", "malware": "Emotet"},
    {"ip_address": "162.243.103.246", "port": 8080, "status": "online",
     "hostname": None, "as_number": 14061, "as_name": "DIGITALOCEAN-ASN",
     "country": "US", "first_seen": "2022-06-04 21:24:53",
     "last_online": None, "malware": "Emotet"},
    {"ip_address": "50.16.16.211", "port": 443, "status": "online",
     "hostname": None, "as_number": 14618, "as_name": "AMAZON-AES",
     "country": "US", "first_seen": "2024-01-02 10:00:00",
     "last_online": None, "malware": "QakBot"},
]


def test_feodotracker_frame_dedupe():
    df = pd.DataFrame(FEODO_SAMPLE)
    df["ip_address"] = df["ip_address"].astype("string").str.strip().str.lower()
    df = df.drop_duplicates(["ip_address", "port", "malware"])
    assert len(df) == 2
    assert set(df["malware"]) == {"Emotet", "QakBot"}


# ------------------------------------------------------------- ofac parse

OFAC_SAMPLE = (
    '36,"AEROCARIBBEAN AIRLINES",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- \n'
    '173,"ANGLO-CARIBBEAN CO., LTD.",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"a.k.a. \'BNC\'."\n'
)

_OFAC_COLS = ["ent_num", "sdn_name", "sdn_type", "program", "title", "call_sign",
              "vessel_type", "tonnage", "grt", "vessel_flag", "vessel_owner", "remarks"]


def test_ofac_dash_zero_becomes_null():
    df = pd.read_csv(__import__("io").StringIO(OFAC_SAMPLE), header=None,
                     names=_OFAC_COLS, dtype="string", skipinitialspace=True)
    for c in df.columns:
        df[c] = df[c].str.strip().str.strip('"').replace("-0-", None)
    assert df.loc[0, "program"] == "CUBA"
    assert df.loc[0, "sdn_type"] is None or pd.isna(df.loc[0, "sdn_type"])
    assert df.loc[1, "sdn_name"] == "ANGLO-CARIBBEAN CO., LTD."
    assert df.loc[1, "remarks"] == "a.k.a. 'BNC'."


# ---------------------------------------------------------- domain_health

def test_domain_health_jsonl_merge_semantics(tmp_path: pathlib.Path):
    """Two JSONL records for the same domain merge (dns run + crt.sh run)."""
    recs = [
        {"domain": "a.com", "dns_a_exists": True, "http_live": False},
        {"domain": "a.com", "crtsh_first_seen": "2021-01-01T00:00:00"},
        {"domain": "b.com", "dns_a_exists": None, "dns_error": "nxdomain"},
    ]
    merged: dict[str, dict] = {}
    for r in recs:
        d = r.pop("domain")
        merged.setdefault(d, {}).update(r)
    assert merged["a.com"]["dns_a_exists"] is True
    assert merged["a.com"]["crtsh_first_seen"] == "2021-01-01T00:00:00"
    assert merged["b.com"]["dns_error"] == "nxdomain"


def test_domain_health_wayback_parse():
    """CDX returns space-separated cols; first-seen is column 2."""
    line = "com,example 20210101000000 http://example.com/ 200 text/html - -"
    ts = line.strip().split()[1]
    assert ts == "20210101000000"
