"""Tests for the reproducible update pipeline (processing/update_all.py).

Pure-logic coverage only: toggle roundtrip, plan building, cleaner mapping
integrity, run-report retention. No network access.
"""

from __future__ import annotations

import json
import pathlib

import pytest

from processing import update_all


# ------------------------------------------------------------ weekly toggle

def test_weekly_toggle_roundtrip(tmp_path: pathlib.Path):
    cfg_path = tmp_path / "update.json"
    assert update_all.load_update_config(cfg_path)["auto_update"]["enabled"] is False  # default OFF

    update_all.set_weekly(True, cfg_path)
    on = update_all.weekly_status(cfg_path)
    assert on["enabled"] is True
    assert "mon" in on["schedule"]

    update_all.set_weekly(False, cfg_path)
    assert update_all.weekly_status(cfg_path)["enabled"] is False


def test_load_update_config_merges_over_defaults(tmp_path: pathlib.Path):
    cfg_path = tmp_path / "update.json"
    cfg_path.write_text(json.dumps({"policy": {"refresh_gleif": False}}))
    cfg = update_all.load_update_config(cfg_path)
    assert cfg["policy"]["refresh_gleif"] is False
    assert cfg["policy"]["refresh_static_archives"] is False  # default preserved
    assert cfg["auto_update"]["enabled"] is False  # default preserved


def test_corrupt_config_falls_back_to_defaults(tmp_path: pathlib.Path):
    cfg_path = tmp_path / "update.json"
    cfg_path.write_text("{not json")
    assert update_all.load_update_config(cfg_path)["auto_update"]["enabled"] is False


# ----------------------------------------------------------------- planning

def test_plan_subset_respects_enabled_flag(monkeypatch):
    monkeypatch.setitem(update_all.common.CONFIG, "tranco", {"enabled": True})
    monkeypatch.setitem(update_all.common.CONFIG, "abuseipdb", {"enabled": False})
    plan = update_all.build_plan(only=["tranco", "abuseipdb", "nope"])
    assert plan["mode"] == "subset"
    assert plan["sources"] == ["tranco"]
    assert "abuseipdb" in plan["disabled"]
    assert plan["unknown_sources"] == ["nope"]
    assert plan["clean"] == ["tranco"]  # from CLEANER_FOR mapping


def test_plan_full_mode_groups_and_skips_static_by_default():
    plan = update_all.build_plan()
    assert plan["mode"] == "update"
    assert "threatfox" in plan["sources"]["feeds"]
    assert "tabformer" in plan["sources"]["static"]
    assert plan["static_refresh"] is False
    assert any("build_dataset.collect" in step for step in plan["core"])
    # static cleaners must NOT be in the clean list unless refresh_static
    assert "tabformer" not in plan["clean"]
    assert "threatfox" in plan["clean"]


def test_plan_refresh_all_includes_static_cleaners():
    plan = update_all.build_plan(refresh_all=True)
    assert plan["static_refresh"] is True
    assert "tabformer" in plan["clean"]
    assert "ieee_cis" in plan["clean"]


def test_every_mapped_cleaner_exists_in_clean_external():
    from processing import clean_external

    for src, cleaners in update_all.CLEANER_FOR.items():
        assert cleaners, f"{src} maps to no cleaners"
        for c in cleaners:
            assert c in clean_external.CLEANERS, f"{src}: cleaner {c} missing from CLEANERS"


def test_all_declared_sources_have_collectors():
    for src in update_all.FEED_SOURCES + update_all.STATIC_SOURCES + update_all.ENRICHMENT_SOURCES:
        import importlib

        importlib.import_module(f"collectors.{src}")  # raises if a name rots


# --------------------------------------------------------------- run report

def test_write_report_keeps_recent_only(tmp_path, monkeypatch):
    import datetime as _dt

    monkeypatch.setattr(update_all, "RUNS_DIR", tmp_path)

    class _AdvancingDT:  # one second per now() call: unique stamps, ordered
        t = 0
        timezone = _dt.timezone

        class datetime:
            @classmethod
            def now(cls, tz=None):
                _AdvancingDT.t += 1
                return _dt.datetime(2026, 9, 24, 0, 0, _AdvancingDT.t, tzinfo=_dt.timezone.utc)

    monkeypatch.setattr(update_all, "datetime", _AdvancingDT)
    for i in range(update_all.KEEP_RUN_REPORTS + 5):
        update_all.write_report({"n": i})
    runs = sorted(tmp_path.glob("update_*.json"))
    assert len(runs) == update_all.KEEP_RUN_REPORTS
    assert (tmp_path / "latest.json").exists()
    assert json.loads(runs[-1].read_text())["n"] == update_all.KEEP_RUN_REPORTS + 4
