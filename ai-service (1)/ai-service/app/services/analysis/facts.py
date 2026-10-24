"""Layer 2: approved-fact verification (deterministic claim extraction + comparison).

Verdicts:
  verified               claim agrees with an approved fact
  verified_contradiction claim conflicts with an approved fact
  unsupported            performance/superlative claim with no approved fact
  inconclusive           a related fact exists but cannot decide (or fact expired)
"""
from __future__ import annotations

import math
import re
from datetime import date
from typing import Dict, List, Optional, Tuple

from app.schemas import (ApprovedFact, Category, ClaimCheck, Evidence, EvidenceSourceType, FactVerdict, Finding,
                         Scope, Severity, UNABLE_TO_VERIFY)

_UNITS = {
    "%": "%", "percent": "%", "hour": "hours", "hours": "hours", "hr": "hours", "hrs": "hours",
    "day": "days", "days": "days", "gb": "gb", "mb": "mb", "tb": "tb", "mah": "mah", "mm": "mm", "cm": "cm",
    "kg": "kg", "g": "g", "w": "w", "mp": "mp", "hz": "hz", "ghz": "ghz", "x": "x", "min": "minutes",
    "minutes": "minutes", "minute": "minutes", "year": "years", "years": "years", "month": "months",
    "months": "months", "$": "$", "usd": "$", "users": "users", "customers": "customers",
}
_MULT = {"k": 1e3, "thousand": 1e3, "million": 1e6, "m": 1e6, "billion": 1e9, "b": 1e9}
_NUM = re.compile(
    r"(?P<cur>[$€£])?(?P<num>\d{1,3}(?:,\d{3})+|\d+)(?P<dec>\.\d+)?\s*"
    r"(?P<mult>thousand|million|billion|k|m|b)?\s*"
    r"(?P<unit>%|percent|hours?|hrs?|days?|gb|mb|tb|mah|mm|cm|kg|g|w|mp|ghz|hz|x|minutes?|min|years?|months?|users|customers)?\b",
    re.I)
_MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
     "november", "december"], 1)}
_DATE_RES = [
    re.compile(r"\b(?P<y>\d{4})-(?P<m>\d{2})-(?P<d>\d{2})\b"),
    re.compile(r"\b(?P<mon>" + "|".join(_MONTHS) + r")\s+(?P<d>\d{1,2})(?:st|nd|rd|th)?,?\s+(?P<y>\d{4})\b", re.I),
    re.compile(r"\b(?P<d>\d{1,2})(?:st|nd|rd|th)?\s+(?P<mon>" + "|".join(_MONTHS) + r"),?\s+(?P<y>\d{4})\b", re.I),
    re.compile(r"\b(?P<mon>" + "|".join(_MONTHS) + r"),?\s+(?P<y>\d{4})\b", re.I),
]
_YEAR = re.compile(r"\b(19|20)\d{2}\b")
_PERF = re.compile(
    r"(?<!\w)(?:fastest|best|#1|number one|leading|guaranteed?|never fails?|always"
    r"|\d+(?:\.\d+)?\s*(?:%|x)\s*(?:faster|better|more|less|cheaper|lower|higher)"
    r"|faster than|outperforms?|unbeatable|industry[- ]leading|zero (?:risk|downtime)|100%)(?!\w)", re.I)
_STOP = {"the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "with", "is", "are", "our", "your", "its"}


def split_sentences(content: str) -> List[Tuple[int, int]]:
    spans, start = [], 0
    for m in re.finditer(r"[.!?](?=\s|$)|\n\s*\n", content):
        end = m.end()
        if content[start:end].strip():
            spans.append((start, end))
        start = end
    if content[start:].strip():
        spans.append((start, len(content)))
    out = []
    for s, e in spans:
        seg = content[s:e]
        s += len(seg) - len(seg.lstrip())
        e -= len(seg) - len(seg.rstrip())
        if e > s:
            out.append((s, e))
    return out


def _unit(u: Optional[str], cur: Optional[str]) -> Optional[str]:
    if cur:
        return "$"
    return _UNITS.get(u.lower()) if u else None


def content_text(m: "re.Match") -> str:
    return m.group().strip()


def parse_numbers(sentence: str) -> List[dict]:
    res = []
    for m in _NUM.finditer(sentence):
        val = float(m.group("num").replace(",", "") + (m.group("dec") or ""))
        mult = m.group("mult")
        if mult:
            val *= _MULT[mult.lower()]
        unit = _unit(m.group("unit"), m.group("cur"))
        s, e = m.span()
        e -= len(m.group()) - len(m.group().rstrip())  # exclude trailing whitespace from the span
        res.append({"value": val, "unit": unit, "span": (s, e), "text": content_text(m),
                    "is_year": unit is None and bool(re.fullmatch(r"(19|20)\d{2}", m.group("num"))
                                                     and not m.group("dec"))})
    return res


def parse_dates(s: str) -> List[dict]:
    out, taken = [], []
    for pat in _DATE_RES:
        for m in pat.finditer(s):
            if any(m.start() < b and m.end() > a for a, b in taken):
                continue
            g = m.groupdict()
            mon = int(g["m"]) if g.get("m") else (_MONTHS[g["mon"].lower()] if g.get("mon") else None)
            out.append({"y": int(g["y"]), "m": mon, "d": int(g["d"]) if g.get("d") else None,
                        "span": m.span(), "text": m.group()})
            taken.append(m.span())
    return out


def _tokens(s: str) -> set:
    return {t for t in re.findall(r"[a-z0-9]+", s.lower()) if t not in _STOP}


def match_fact(sentence: str, facts: List[ApprovedFact]) -> Optional[ApprovedFact]:
    low = sentence.lower()
    toks = _tokens(sentence)
    best, best_score = None, 0.0
    for f in facts:
        if f.keywords:
            hit = sum(1 for k in f.keywords if k.lower() in low)
            need = max(1, math.ceil(len(f.keywords) * 0.6))
            score = hit / len(f.keywords) if hit >= need else 0
        else:
            st = _tokens(f.subject)
            hit = len(st & toks)
            score = hit / len(st) if st and hit >= min(2, len(st)) else 0
        if score > best_score:
            best, best_score = f, score
    return best


def _fmt(f: ApprovedFact) -> str:
    if f.value is not None:
        v = f"{f.value:g}"
        return f"{v}{f.unit}" if f.unit in ("%",) else (f"{v} {f.unit}" if f.unit else v)
    return f.text_value or f.statement


def _evidence(f: ApprovedFact) -> Evidence:
    return Evidence(source_type=EvidenceSourceType.APPROVED_FACT, organization_id=f.organization_id,
                    fact_id=f.id, document_id=f.document_id, document_version=f.document_version,
                    passage=f.statement)


def _norm_unit(u: Optional[str]) -> Optional[str]:
    return _UNITS.get(u.lower(), u.lower()) if u else None


def verify_facts(content: str, facts: List[ApprovedFact], scope: Scope,
                 today: Optional[date] = None) -> Tuple[List[Finding], List[ClaimCheck]]:
    today = today or date.today()
    usable = [f for f in facts if f.status == "approved" and f.organization_id == scope.organization_id
              and (f.brand_id in (None, scope.brand_id) or scope.brand_id is None)
              and (not scope.locale or f.locale in (None, scope.locale))]
    findings: List[Finding] = []
    checks: List[ClaimCheck] = []

    def add(s, e, sev, conf, expl, verdict, fact=None, corr=None, category=Category.FACT):
        f = Finding(category=category, severity=sev, confidence=conf, quoted_text=content[s:e], start_offset=s,
                    end_offset=e, explanation=expl, supporting_evidence=[_evidence(fact)] if fact else [],
                    suggested_correction=corr, requires_human_review=True, fact_verdict=verdict, layer="facts",
                    verification_note=None if fact else UNABLE_TO_VERIFY)
        findings.append(f)

    for ss, se in split_sentences(content):
        sent = content[ss:se]
        nums = [n for n in parse_numbers(sent)]
        dates = parse_dates(sent)
        fact = match_fact(sent, usable)
        has_claim = bool(nums or dates)
        perf = _PERF.search(sent)
        if fact is None:
            if perf:
                checks.append(ClaimCheck(claim_text=sent, start_offset=ss, end_offset=se,
                                         verdict=FactVerdict.UNSUPPORTED, note=UNABLE_TO_VERIFY))
                add(ss, se, Severity.MEDIUM, 0.6,
                    f"Performance or superlative claim with no matching approved fact. {UNABLE_TO_VERIFY}",
                    FactVerdict.UNSUPPORTED, corr="Remove the claim or cite an approved, substantiated source.")
            continue
        if not has_claim:
            continue
        # Expired approved fact: cannot be used to verify or contradict.
        if fact.valid_until and fact.valid_until < today:
            checks.append(ClaimCheck(claim_text=sent, start_offset=ss, end_offset=se, verdict=FactVerdict.INCONCLUSIVE,
                                     fact_id=fact.id, note=f"Approved fact expired {fact.valid_until}."))
            add(ss, se, Severity.LOW, 0.4, f"The matching approved fact expired on {fact.valid_until}; "
                f"the claim cannot be verified until it is re-approved.", FactVerdict.INCONCLUSIVE, fact)
            continue
        verdict, note, span, corr = FactVerdict.INCONCLUSIVE, "", (ss, se), None
        if fact.value is not None:
            fu = _norm_unit(fact.unit)
            cands = [n for n in nums if not n["is_year"] and (n["unit"] == fu or (fu is None and n["unit"] is None))]
            if not cands:
                note = "Related approved fact found but no comparable figure in the claim."
            elif any(math.isclose(c["value"], fact.value, rel_tol=0.005) for c in cands):
                verdict, note = FactVerdict.VERIFIED, "Matches approved fact."
            else:
                c = cands[0]
                verdict = FactVerdict.CONTRADICTION
                span = (ss + c["span"][0], ss + c["span"][1])
                corr = _fmt(fact)
                old = [y for y in _YEAR.findall(sent)]
                yrs = [int(m.group()) for m in _YEAR.finditer(sent)]
                outdated = bool(fact.as_of and yrs and max(yrs) < fact.as_of.year)
                note = (f"Claim states {c['text']} but the approved figure is {_fmt(fact)}"
                        f" (as of {fact.as_of})." if fact.as_of else
                        f"Claim states {c['text']} but the approved figure is {_fmt(fact)}.")
                if outdated:
                    note += " The statistic references an earlier year and appears outdated."
        elif fact.text_value:
            fdates = parse_dates(fact.text_value)
            if fdates and dates:
                fd, cd = fdates[0], dates[0]
                same = fd["y"] == cd["y"] and (fd["m"] is None or cd["m"] is None or fd["m"] == cd["m"]) \
                    and (fd["d"] is None or cd["d"] is None or fd["d"] == cd["d"])
                if same:
                    verdict, note = FactVerdict.VERIFIED, "Date matches approved fact."
                else:
                    verdict = FactVerdict.CONTRADICTION
                    span = (ss + cd["span"][0], ss + cd["span"][1])
                    corr = fact.text_value
                    note = f"Claim states {cd['text']} but the approved date is {fact.text_value}."
            elif re.search(r"(?<![\w-])" + re.escape(fact.text_value.lower()) + r"(?![\w-])", sent.lower()):
                verdict, note = FactVerdict.VERIFIED, "Matches approved fact."
            else:
                note = "Related approved fact found but the claim could not be compared."
        checks.append(ClaimCheck(claim_text=content[span[0]:span[1]], start_offset=span[0], end_offset=span[1],
                                 verdict=verdict, fact_id=fact.id, note=note))
        if verdict == FactVerdict.CONTRADICTION:
            add(span[0], span[1], Severity.HIGH, 0.95, note, verdict, fact, corr)
        elif verdict == FactVerdict.INCONCLUSIVE:
            add(span[0], span[1], Severity.LOW, 0.4, note, verdict, fact)
    return findings, checks
