#!/usr/bin/env python3
"""Build the labeled prompt-injection training/eval corpus from collected sources.

v2 — negative-corpus redesign. v1 trained attacks vs TensorTrust-defenses only,
which taught the model "instruction-like text = benign" — the exact inverse of
the deployment need (injections ARE instructions; benign product text is not).
v2 therefore mixes several BENIGN text families from the gathered data:

  positives (train):
    - tensortrust raw dump attacks (attacker_input, filtered + deduped)
  negatives (train):
    - tensortrust raw dump defenses (legitimate system-prompt style instructions)
    - GLEIF CH legal company names (benign business-name strings)
    - Tranco top-1M domains (benign short domain strings, sampled)
    - Google product taxonomy categories (benign label strings)
    - AgentDojo clean-run tool outputs + user task text (benign agent-context text)
  eval-only (never trained on):
    - bipia attack texts, hand-partitioned into directive-attacks vs benign-looking tasks
    - viseca pack item/merchant text (deployment-domain benign text, FPR measurement)

Split policy: deterministic md5(text) bucket -> train ~93% / val ~3.5% / test ~3.5%
(TensorTrust only). Benign auxiliary sources keep ~same split for val honesty;
eval-only sources always land in the eval set.

Output: data/intermediate/prompt_injection/{train,val,test,eval}.jsonl.gz
        fields: {"text": str, "label": 0|1, "source": str}
"""
from __future__ import annotations

import bz2
import csv
import glob
import gzip
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw"
EXPORTS = ROOT / "data" / "exports" / "external"
PACK = ROOT.parent / "wallet-control" / "data" / "pack"
OUT = ROOT / "data" / "intermediate" / "prompt_injection"

TOKEN_RE = re.compile(r"[a-z0-9']+")

MIN_CHARS = 20   # drop short password-guess attacks ("avocado12345")
MIN_TOKENS = 5

# BIPIA families whose texts read as ordinary user tasks, not output directives.
# They are injected off-topic tasks in BIPIA's threat model, but for our deployment
# (scanning untrusted product text) they MUST NOT be treated as attacks.
BIPIA_BENIGN_FAMILIES = {
    "Information Retrieval",
    "Learning and Tutoring",
    "Programming Help",
    "Research Assistance",
    "Sentiment Analysis",
    "Business Intelligence",
    "Conversational Agent",
    "Content Creation",
    "Language Translation",
}

TRANCO_KEEP_MOD = 40  # keep ~2.5% of 1M domains ≈ 25k benign strings

seen = set()
counts = Counter()

writers: dict = {}


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def split_of(text: str) -> str:
    h = int(hashlib.md5(text.encode("utf-8")).hexdigest()[:2], 16)
    if h < 238:
        return "train"
    if h < 248:
        return "val"
    return "test"


def out_writer(name: str):
    if name not in writers:
        f = gzip.open(OUT / f"{name}.jsonl.gz", "wt", encoding="utf-8")
        writers[name] = f
    return writers[name]


def emit(text: str, label: int, source: str, force_eval: bool = False,
         min_filter: bool = True) -> None:
    text = norm(text)
    if not text:
        return
    key = text.lower()
    if key in seen:
        return
    if min_filter and label == 1 and (len(text) < MIN_CHARS or
                                      len(TOKEN_RE.findall(text.lower())) < MIN_TOKENS):
        counts["dropped_positive_filter"] += 1
        return
    seen.add(key)
    split = "eval" if force_eval else split_of(text)
    out_writer(split).write(
        json.dumps({"text": text, "label": label, "source": source}, ensure_ascii=False) + "\n")
    counts[f"{split}:{source}:{'pos' if label else 'neg'}"] += 1


def build() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    # -- positives: TensorTrust raw attacks --------------------------------------
    p = RAW / "tensortrust" / "raw-data__v2__raw_dump_attacks.jsonl.bz2"
    with bz2.open(p, "rt", encoding="utf-8") as f:
        for line in f:
            emit(json.loads(line).get("attacker_input") or "", 1, "tensortrust_raw")
    print("raw attacks done", file=sys.stderr)

    # -- negatives: TensorTrust defenses ------------------------------------------
    p = RAW / "tensortrust" / "raw-data__v2__raw_dump_defenses.jsonl.bz2"
    with bz2.open(p, "rt", encoding="utf-8") as f:
        for line in f:
            d = json.loads(line)
            emit(d.get("opening_defense") or "", 0, "tensortrust_defense")
            emit(d.get("closing_defense") or "", 0, "tensortrust_defense")
    print("defenses done", file=sys.stderr)

    # -- negatives: GLEIF CH legal names (benign business strings) -----------------
    for page in sorted(glob.glob(str(RAW / "gleif" / "gleif_ch_c*.json"))):
        try:
            d = json.load(open(page, encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        arr = d if isinstance(d, list) else d.get("data") or d.get("results") or []
        for rec in arr:
            name = ((rec.get("attributes") or {}).get("entity") or {}).get("legalName") or {}
            emit(name.get("name") or "", 0, "gleif_company", min_filter=False)
    print("gleif done", file=sys.stderr)

    # -- negatives: Tranco domains (benign short strings, sampled) ------------------
    p = EXPORTS / "tranco" / "tranco_top1m.csv.gz"
    with gzip.open(p, "rt", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            dom = row.get("domain") or ""
            if int(hashlib.md5(dom.encode()).hexdigest()[:8], 16) % TRANCO_KEEP_MOD == 0:
                emit(dom, 0, "tranco_domain", min_filter=False)
    print("tranco done", file=sys.stderr)

    # -- negatives: Google product taxonomy categories -------------------------------
    p = EXPORTS / "google_taxonomy" / "google_product_taxonomy.csv"
    if p.exists():
        with open(p, encoding="utf-8") as f:
            sample = f.read(2048)
        f = open(p, encoding="utf-8")
        if "," in sample.splitlines()[0] and len(sample.splitlines()[0].split(",")) >= 2:
            for row in csv.DictReader(f):
                vals = [v for v in row.values() if v]
                emit(vals[-1], 0, "google_taxonomy", min_filter=False)
        else:
            for line in f:
                emit(line.strip(), 0, "google_taxonomy", min_filter=False)
        f.close()
    print("taxonomy done", file=sys.stderr)

    # -- negatives: AgentDojo clean-run tool outputs + user tasks --------------------
    adojo_texts: list[str] = []
    n_adojo = 0
    for fjson in sorted(glob.glob(str(RAW / "agentdojo" / "extracted" /
                                         "agentdojo-main" / "runs" / "*" / "*" / "*" / "*" / "none.json"))):
        try:
            d = json.load(open(fjson, encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for msg in d.get("messages") or []:
            role = msg.get("role")
            content = msg.get("content")
            if role in ("tool", "user") and isinstance(content, str) and content.strip():
                adojo_texts.append(content)
                emit(content, 0, "agentdojo_context", min_filter=False)
                n_adojo += 1
    print(f"agentdojo done ({n_adojo} msgs)", file=sys.stderr)

    # -- synthetic mixture positives: attacks embedded in benign text ----------------
    # Deployment reality (LEASH pack): manipulation clauses hide inside mostly-
    # benign product text. Pure TT attacks are whole-input; mixtures teach the
    # model to fire on attack n-grams at deployment-like ratios (~25% attack
    # tokens). Mixture benign sources deliberately EXCLUDE viseca_pack (stays
    # pure-unseen so its eval FPR is honest) and bipia (eval-only).
    benign_pool = [t for t in adojo_texts if len(t) >= 40]
    for page in sorted(glob.glob(str(RAW / "gleif" / "gleif_ch_c*.json"))):
        try:
            d = json.load(open(page, encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        arr = d if isinstance(d, list) else d.get("data") or d.get("results") or []
        for rec in arr:
            name = ((rec.get("attributes") or {}).get("entity") or {}).get("legalName") or {}
            if name.get("name"):
                benign_pool.append(name["name"])
    if (EXPORTS / "google_taxonomy" / "google_product_taxonomy.csv").exists():
        with open(EXPORTS / "google_taxonomy" / "google_product_taxonomy.csv", encoding="utf-8") as f:
            lines = f.read().splitlines()
        benign_pool.extend(x.strip() for x in lines if x.strip())
    benign_pool = list(dict.fromkeys(benign_pool))  # dedupe, keep order

    connectors = ["", "System: ", "NOTE: ", "Important: ", "P.S. ", "(internal note: "]

    def mixture_sample(attack: str) -> str | None:
        h = int(hashlib.md5(("mix" + attack).encode()).hexdigest()[:8], 16)
        if h % 100 >= 55:            # ~55% of attacks get a mixture variant
            return None
        benign = benign_pool[h % len(benign_pool)]
        conn = connectors[(h >> 8) % len(connectors)]
        variant = h % 3
        tail = ")" if conn.endswith("(") else ""
        if variant == 0:
            return f"{benign} {conn}{attack}{tail}"
        if variant == 1:
            return f"{conn}{attack}{tail} {benign}"
        return f"{benign[: max(20, len(benign) // 2)]} {conn}{attack}{tail} {benign[len(benign) // 2:]}"

    # requires a second pass over raw attacks (streamed, cheap relative to bz2)
    with bz2.open(RAW / "tensortrust" / "raw-data__v2__raw_dump_attacks.jsonl.bz2",
                  "rt", encoding="utf-8") as f:
        for line in f:
            attack = norm(json.loads(line).get("attacker_input") or "")
            if len(attack) < MIN_CHARS or len(TOKEN_RE.findall(attack.lower())) < MIN_TOKENS:
                continue
            mix = mixture_sample(attack)
            if mix and mix.lower() not in seen:
                seen.add(mix.lower())
                split = split_of(mix)
                out_writer(split).write(json.dumps(
                    {"text": mix, "label": 1, "source": "tensortrust_mixture"},
                    ensure_ascii=False) + "\n")
                counts[f"{split}:tensortrust_mixture:pos"] += 1
    print("mixtures done", file=sys.stderr)

    # -- eval-only: BIPIA (partitioned) ----------------------------------------------
    p = EXPORTS / "bipia" / "bipia_attack_texts.csv.gz"
    with gzip.open(p, "rt", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            fam = row["attack_type"]
            benign = fam in BIPIA_BENIGN_FAMILIES
            emit(row["text"], 0 if benign else 1,
                 "bipia_benign_tasks" if benign else "bipia_directive", force_eval=True)
    print("bipia done", file=sys.stderr)

    # -- eval-only: Viseca pack benign deployment-domain text -------------------------
    def emit_pack(path: str, fields: list) -> None:
        with open(PACK / path, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                for fld in fields:
                    emit((row.get(fld) or "").strip(), 0, "viseca_pack",
                         force_eval=True, min_filter=False)

    emit_pack("items.csv", ["item_name", "item_description"])
    emit_pack("merchants.csv", ["merchant_name", "merchant_city"])
    emit_pack("purchase_attempts.csv", ["purchase_description"])
    emit_pack("customers.csv", ["persona_name", "background", "shopping_preferences"])
    print("viseca pack done", file=sys.stderr)

    for w in writers.values():
        w.close()

    for k, v in sorted(counts.items()):
        print(f"{k}\t{v}")
    total = sum(v for k, v in counts.items() if ":" in k)
    (OUT / "corpus_stats.json").write_text(json.dumps(
        {"rows": total, "counts": dict(counts)}, indent=2))


if __name__ == "__main__":
    build()
