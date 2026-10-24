"""Evaluation harness.

Usage (from ai-service/):  python -m eval.run_eval [--provider mock|configured] [--out eval/report.json]

Measures, over the labelled dataset:
  precision, recall, false-positive rate (clean/harmless documents flagged),
  false-negative rate, evidence validity, correction match rate, latency, cost.
Nothing here is an accuracy claim about production data: the dataset is small
and synthetic (see dataset.json _meta). "Correction usefulness" cannot be
measured automatically; we report only how often a suggested correction
exactly matches the labelled correction, plus presence rate.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
from datetime import date
from pathlib import Path

from app.config import Settings
from app.core.container import build_container
from app.schemas import AnalyzeRequest, ApprovedFact, Layers, Rule, Scope, ToneProfile
from app.services.llm import MockProvider
from app.services.validation import EvidenceRegistry, validate_evidence

HERE = Path(__file__).parent
TODAY = date(2026, 10, 24)


def _spans(content, quote):
    out, i = [], content.find(quote)
    if i != -1:
        out.append((i, i + len(quote)))
    return out


def _overlap(a, b):
    return a[0] < b[1] and b[0] < a[1]


def _build_request(ds, case):
    rules = [Rule(**ds["rules"][r]) for r in case.get("rules", [])]
    facts = [ApprovedFact(**f) for f in ds["facts"]] if case.get("facts") else []
    tone = ToneProfile(**ds["tone_profiles"][case["tone"]]) if case.get("tone") else None
    return AnalyzeRequest(scope=Scope(**ds["scope"]), content=case["content"],
                          content_format=case.get("content_format", "text"), rules=rules, facts=facts,
                          tone_profile=tone, use_llm=False,
                          layers=Layers(rules=True, facts=True, guidelines=False, tone=True, accessibility=True))


async def evaluate(provider_mode: str):
    ds = json.loads((HERE / "dataset.json").read_text())
    settings = Settings(service_auth_token="eval", llm_provider="mock" if provider_mode == "mock" else Settings().llm_provider)
    container = build_container(settings, provider=MockProvider() if provider_mode == "mock" else None)
    tp = fp = fn = 0
    clean_total = clean_flagged = 0
    ev_total = ev_valid = 0
    corr_expected = corr_exact = corr_present = 0
    latencies, cost, per_case = [], 0.0, []
    for case in ds["cases"]:
        req = _build_request(ds, case)
        if provider_mode != "mock":
            req.use_llm = True
        res = await container.pipeline.run(req, TODAY)
        latencies.append(res.usage.latency_ms)
        cost += res.usage.estimated_cost_usd or 0.0
        content = case["content"]
        exp = [(e, _spans(content, e["quoted_text"])) for e in case["expected"]]
        matched_pred = set()
        case_tp = case_fn = 0
        for e, spans in exp:
            hit = next((i for i, f in enumerate(res.findings) if f.category.value == e["category"]
                        and any(_overlap((f.start_offset, f.end_offset), s) for s in spans) and i not in matched_pred), None)
            if hit is None:
                case_fn += 1
            else:
                matched_pred.add(hit)
                case_tp += 1
                if "correction" in e:
                    corr_expected += 1
                    sc = res.findings[hit].suggested_correction
                    corr_present += bool(sc)
                    corr_exact += (sc == e["correction"])
        case_fp = len(res.findings) - len(matched_pred)
        if case["kind"] != "ambiguous":  # ambiguous cases are reported but excluded from headline metrics
            tp, fp, fn = tp + case_tp, fp + case_fp, fn + case_fn
            if not case["expected"]:
                clean_total += 1
                clean_flagged += bool(res.findings)
        inj_ok = (not case.get("expect_injection_signal")) or bool(res.injection_signals)
        reg = EvidenceRegistry.build(Scope(**ds["scope"]), [], req.facts, req.rules)
        for f in res.findings:
            for ev in f.supporting_evidence:
                ev_total += 1
                ev_valid += validate_evidence(ev, reg).ok
        per_case.append({"id": case["id"], "kind": case["kind"], "tp": case_tp, "fp": case_fp, "fn": case_fn,
                         "injection_signal_ok": inj_ok, "findings": len(res.findings)})
    def ratio(a, b):
        return round(a / b, 4) if b else None
    lat = sorted(latencies)
    return {
        "provider_mode": provider_mode, "n_cases": len(ds["cases"]),
        "caveat": ds["_meta"]["description"],
        "counts": {"tp": tp, "fp": fp, "fn": fn},
        "precision": ratio(tp, tp + fp), "recall": ratio(tp, tp + fn),
        "false_negative_rate": ratio(fn, tp + fn),
        "false_positive_rate_clean_docs": ratio(clean_flagged, clean_total),
        "evidence_validity": ratio(ev_valid, ev_total), "evidence_items": ev_total,
        "correction_exact_match_rate": ratio(corr_exact, corr_expected),
        "correction_presence_rate": ratio(corr_present, corr_expected),
        "correction_usefulness": "not measured (requires human review)",
        "latency_ms": {"p50": statistics.median(lat), "p95": lat[int(0.95 * (len(lat) - 1))], "max": lat[-1]},
        "cost_per_scan_usd": round(cost / len(latencies), 6) if cost else "not measurable (mock/no pricing configured)",
        "prompt_injection_cases_signalled": all(c["injection_signal_ok"] for c in per_case),
        "per_case": per_case,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", choices=["mock", "configured"], default="mock")
    ap.add_argument("--out", default=str(HERE / "report.json"))
    a = ap.parse_args()
    report = asyncio.run(evaluate(a.provider))
    Path(a.out).write_text(json.dumps(report, indent=2))
    print(json.dumps({k: v for k, v in report.items() if k != "per_case"}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
