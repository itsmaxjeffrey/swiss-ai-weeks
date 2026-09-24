"""Reproducible fetch/update pipeline for every LEASH data source.

One command re-fetches everything the dataset was built from (threat feeds,
GLEIF registry slice, domain rankings, external ML/security datasets,
enrichment lookups) and rebuilds all derived artifacts, so a fresh clone
reproduces the data with:

    make setup && make update

Weekly auto-update is opt-in (default OFF):

    make weekly-on       # the scheduled runner picks this flag up (Mon 06:00)
    make weekly-off
    make weekly-status

Freshness model
---------------
- Dated feed files (openphish, urlhaus, threatfox, feodotracker, sanctions,
  malwarebazaar, tranco, majestic all use {today} filenames): same-day reruns
  are served from cache; the next day fetches fresh automatically.
- GLEIF page cache is undated, so a normal update clears data/raw/gleif/
  page files and re-pulls the CH slice (new LEIs appear weekly). Disable via
  config/update.json policy.refresh_gleif=false.
- Static research archives (TabFormer, IEEE-CIS, ULB, BIPIA, AgentDojo,
  TensorTrust, HackAPrompt, Viseca, Google taxonomy): request-key cached
  forever; pass --refresh-all to force re-download (large).
- Enrichment (rdap/dns via build_dataset enrich, domain_health): resume-safe
  per-domain caches; only unseen domains cost network.

Blocked/gated sources (Zefix, AbuseIPDB, MalwareBazaar-while-proxied, EU
sanctions, HF-gated sets without token) are recorded per run as
status=blocked/disabled and never fail the whole update.

Usage:
  python -m processing.update_all                     # full update
  python -m processing.update_all --dry-run           # plan only, no network
  python -m processing.update_all --refresh-all       # + re-download archives
  python -m processing.update_all --sources threatfox,feodotracker
  python -m processing.update_all --skip-clean --skip-report
  python -m processing.update_all --weekly on|off|status
"""

from __future__ import annotations

import argparse
import datetime
import importlib
import json
import pathlib
import sys
import time

from collectors import common

ROOT = common.ROOT
UPDATE_CONFIG_PATH = ROOT / "config" / "update.json"
RUNS_DIR = ROOT / "reports" / "update_runs"
KEEP_RUN_REPORTS = 52

DEFAULT_UPDATE_CONFIG: dict = {
    "auto_update": {
        "enabled": False,
        "day_of_week": "mon",
        "hour": 6,
        "minute": 0,
        "timezone": "Europe/Zurich",
    },
    "policy": {
        "refresh_gleif": True,
        "refresh_static_archives": False,
    },
}

# Direct collectors with the (path, meta, cached) contract. openphish/urlhaus/
# gleif/zefix run inside build_dataset.step_collect (core phase) instead.
FEED_SOURCES = ["threatfox", "feodotracker", "malwarebazaar", "sanctions", "tranco", "majestic"]
STATIC_SOURCES = [
    "google_taxonomy", "viseca", "bipia", "agentdojo", "tensortrust",
    "ulb_creditcard", "ieee_cis", "tabformer", "hackaprompt",
]
ENRICHMENT_SOURCES = ["domain_health", "abuseipdb"]
# Collectors that stay out of plans until their key/config is provided and
# flipped on (config/sources.json enabled=false keeps them 'disabled').

# collector name -> clean_external.CLEANERS keys to rebuild after fresh data
CLEANER_FOR: dict[str, list[str]] = {
    "threatfox": ["threatfox"],
    "feodotracker": ["feodotracker"],
    "malwarebazaar": ["malwarebazaar"],
    "sanctions": ["sanctions_un", "sanctions_ofac", "sanctions_seco", "sanctions_eu"],
    "tranco": ["tranco"],
    "majestic": ["majestic"],
    "domain_health": ["domain_health"],
    "abuseipdb": ["abuseipdb"],
    "google_taxonomy": ["google_taxonomy"],
    "viseca": ["viseca"],
    "bipia": ["bipia"],
    "agentdojo": ["agentdojo"],
    "tensortrust": ["tensortrust"],
    "ulb_creditcard": ["ulb_creditcard"],
    "ieee_cis": ["ieee_cis"],
    "tabformer": ["tabformer"],
    "hackaprompt": ["hackaprompt"],
}

BLOCKED_EXC_NAMES = {"Blocked", "MissingCredential"}


# --------------------------------------------------------------- weekly toggle

def load_update_config(path: pathlib.Path = UPDATE_CONFIG_PATH) -> dict:
    cfg: dict = {}
    if path.exists():
        try:
            cfg = json.loads(path.read_text())
        except Exception:
            cfg = {}
    merged = json.loads(json.dumps(DEFAULT_UPDATE_CONFIG))  # deep copy
    for section in ("auto_update", "policy"):
        if isinstance(cfg.get(section), dict):
            merged[section].update(cfg[section])
    return merged


def set_weekly(enabled: bool, path: pathlib.Path = UPDATE_CONFIG_PATH) -> dict:
    cfg = load_update_config(path)
    cfg["auto_update"]["enabled"] = enabled
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cfg, indent=2) + "\n")
    return cfg


def weekly_status(path: pathlib.Path = UPDATE_CONFIG_PATH) -> dict:
    a = load_update_config(path)["auto_update"]
    sched = f"{a['day_of_week']} {a['hour']:02d}:{a['minute']:02d} {a['timezone']}"
    return {
        "enabled": bool(a["enabled"]),
        "schedule": sched,
        "config": str(path),
        "runner": "OpenClaw automation leash-weekly-data-update (checks this flag before running)",
    }


# ------------------------------------------------------------------- planning

def _enabled(name: str) -> bool:
    cfg = common.CONFIG.get(name) or {}
    return cfg.get("enabled") is not False


def build_plan(refresh_all: bool = False, only: list[str] | None = None,
               skip_core: bool = False, skip_clean: bool = False,
               skip_report: bool = False) -> dict:
    if only:
        known = FEED_SOURCES + STATIC_SOURCES + ENRICHMENT_SOURCES
        sources = [s for s in only if s in known and _enabled(s)]
        unknown = [s for s in only if s not in known]
        disabled = [s for s in only if s in known and not _enabled(s)]
        return {
            "mode": "subset",
            "sources": sources,
            "disabled": disabled,
            "unknown_sources": unknown,
            "clean": [] if skip_clean else [c for s in sources for c in CLEANER_FOR.get(s, [])],
            "core": [],
            "report": False,
        }
    update_cfg = load_update_config()
    refresh_gleif = update_cfg["policy"].get("refresh_gleif", True)
    refresh_static = refresh_all or update_cfg["policy"].get("refresh_static_archives") is True
    feed = [s for s in FEED_SOURCES if _enabled(s)]
    static = [s for s in STATIC_SOURCES if _enabled(s)]
    enrich = [s for s in ENRICHMENT_SOURCES if _enabled(s)]
    core = [] if skip_core else [
        "invalidate_gleif_cache" if refresh_gleif else "gleif_cache_kept (policy.refresh_gleif=false)",
        "build_dataset.collect (openphish, urlhaus, gleif CH, zefix probe)",
        "build_dataset.enrich (rdap+dns, resume-safe)",
        "build_dataset.build (parquet datasets)",
    ]
    clean = []
    if not skip_clean:
        clean += [c for s in feed for c in CLEANER_FOR.get(s, [])]
        clean += [c for s in enrich for c in CLEANER_FOR.get(s, [])]
        if refresh_static:
            clean += [c for s in static for c in CLEANER_FOR.get(s, [])]
    return {
        "mode": "refresh-all" if refresh_all else "update",
        "sources": {"feeds": feed, "static": static, "enrichment": enrich},
        "static_refresh": refresh_static,
        "core": core,
        "clean": sorted(set(clean)),
        "report": not skip_report,
    }


# ------------------------------------------------------------------ execution

def run_source(name: str) -> dict:
    cfg = common.CONFIG.get(name) or {}
    if cfg.get("enabled") is False:
        return {"source": name, "status": "disabled"}
    t0 = time.time()
    try:
        mod = importlib.import_module(f"collectors.{name}")
        out = mod.collect()
        _pathish, meta, cached = out  # shared collector contract
        return {
            "source": name,
            "status": "cached" if cached else "fresh",
            "retrieved_at": (meta or {}).get("retrieved_at"),
            "seconds": round(time.time() - t0, 1),
        }
    except Exception as e:  # noqa: BLE001 — record and continue
        status = "blocked" if type(e).__name__ in BLOCKED_EXC_NAMES else "error"
        return {"source": name, "status": status,
                "error": f"{type(e).__name__}: {e}",
                "seconds": round(time.time() - t0, 1)}


def invalidate_source_meta(source: str) -> int:
    """Delete provenance sidecars so the next get() re-downloads (files kept)."""
    d = common.raw_dir(source)
    n = 0
    for meta in d.glob("*.meta.json"):
        meta.unlink(missing_ok=True)
        n += 1
    return n


def invalidate_gleif() -> int:
    """GLEIF pages are cursor/page-number cached without dates: clear for re-pull."""
    d = common.raw_dir("gleif")
    n = 0
    for p in list(d.glob("gleif_*_c*.json")) + list(d.glob("gleif_*_c*.json.meta.json")):
        p.unlink(missing_ok=True)
        n += 1
    return n


def run_core(refresh_gleif: bool) -> list[dict]:
    from processing import build_dataset, quality_report

    results: list[dict] = []
    if refresh_gleif:
        n = invalidate_gleif()
        results.append({"core_step": "invalidate_gleif_cache", "status": "ok", "files_removed": n})
    for step in ("collect", "enrich", "build"):
        t0 = time.time()
        getattr(build_dataset, f"step_{step}")()
        results.append({"core_step": f"build_dataset.{step}", "status": "ok",
                        "seconds": round(time.time() - t0, 1)})
    quality_report.main()
    results.append({"core_step": "quality_report", "status": "ok"})
    return results


def run_clean(cleaners: list[str]) -> list[dict]:
    from processing import clean_external

    results: list[dict] = []
    for src in cleaners:
        t0 = time.time()
        try:
            st = clean_external.CLEANERS[src]()
            status = st.get("status", "ok")
        except Exception as e:  # noqa: BLE001
            st = {"status": "error", "error": f"{type(e).__name__}: {e}"}
            status = "error"
        clean_external.STATS.mkdir(parents=True, exist_ok=True)
        (clean_external.STATS / f"{src}.json").write_text(json.dumps(st, indent=2, default=str))
        results.append({"clean": src, "status": status, "seconds": round(time.time() - t0, 1)})
    return results


def regenerate_external_report() -> str:
    """Rebuild EXTERNAL_QUALITY_REPORT.md from all stats files (no re-cleaning)."""
    from processing import clean_external

    all_stats: dict = {}
    if clean_external.STATS.exists():
        for p in clean_external.STATS.glob("*.json"):
            all_stats[p.stem] = json.loads(p.read_text())
    clean_external.write_report(all_stats)
    return str(clean_external.EXPORTS / "EXTERNAL_QUALITY_REPORT.md")


def write_report(report: dict) -> pathlib.Path:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = RUNS_DIR / f"update_{stamp}.json"
    path.write_text(json.dumps(report, indent=2))
    (RUNS_DIR / "latest.json").write_text(json.dumps(report, indent=2))
    runs = sorted(RUNS_DIR.glob("update_*.json"))
    for old in runs[:-KEEP_RUN_REPORTS]:
        old.unlink(missing_ok=True)
    return path


# ------------------------------------------------------------------------ CLI

def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="update_all", description=__doc__.splitlines()[0])
    ap.add_argument("--refresh-all", action="store_true",
                    help="also re-download cached static archives (large)")
    ap.add_argument("--sources", help="comma-separated collector subset (skips core/report)")
    ap.add_argument("--dry-run", action="store_true", help="print the plan, fetch nothing")
    ap.add_argument("--skip-core", action="store_true", help="skip build_dataset + quality report")
    ap.add_argument("--skip-clean", action="store_true", help="skip clean_external rebuilds")
    ap.add_argument("--skip-report", action="store_true",
                    help="skip regenerating EXTERNAL_QUALITY_REPORT.md")
    ap.add_argument("--weekly", choices=["on", "off", "status"], help="weekly auto-update toggle")
    args = ap.parse_args(argv)

    if args.weekly:
        if args.weekly == "status":
            print(json.dumps(weekly_status(), indent=2))
        else:
            cfg = set_weekly(args.weekly == "on")
            print(json.dumps({"auto_update_enabled": cfg["auto_update"]["enabled"],
                              "schedule": weekly_status()["schedule"]}))
        return 0

    only = [s.strip() for s in args.sources.split(",")] if args.sources else None
    plan = build_plan(args.refresh_all, only, args.skip_core, args.skip_clean, args.skip_report)

    if args.dry_run:
        print(json.dumps({"dry_run": True, "plan": plan}, indent=2))
        return 0
    if plan.get("unknown_sources"):
        print(json.dumps({"error": "unknown sources", "unknown": plan["unknown_sources"]}),
              file=sys.stderr)
        return 2

    t_start = time.time()
    report: dict = {"started_at": common.utcnow(), "mode": plan["mode"], "plan": plan,
                    "sources": [], "core": [], "clean": []}

    if only:
        to_run: list[str] = plan["sources"]
    else:
        to_run = list(plan["sources"]["feeds"])
        if plan["static_refresh"]:
            to_run += plan["sources"]["static"]
        to_run += plan["sources"]["enrichment"]

    for src in to_run:
        r = run_source(src)
        report["sources"].append(r)
        print(json.dumps(r), file=sys.stderr, flush=True)

    if not only and plan["core"]:
        report["core"] = run_core(refresh_gleif=load_update_config()["policy"].get("refresh_gleif", True))
        for r in report["core"]:
            print(json.dumps(r), file=sys.stderr, flush=True)

    if plan["clean"]:
        report["clean"] = run_clean(plan["clean"])
        for r in report["clean"]:
            print(json.dumps(r), file=sys.stderr, flush=True)
        if plan.get("report"):
            report["report"] = regenerate_external_report()

    report["finished_at"] = common.utcnow()
    report["total_seconds"] = round(time.time() - t_start, 1)
    report["summary"] = {
        s: sum(1 for r in report["sources"] if r["status"] == s)
        for s in ("fresh", "cached", "blocked", "error", "disabled")
    }
    path = write_report(report)
    print(json.dumps({"run_report": str(path), "summary": report["summary"],
                      "total_seconds": report["total_seconds"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
