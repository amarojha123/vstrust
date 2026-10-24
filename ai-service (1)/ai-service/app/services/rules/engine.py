"""Layer 1: deterministic rule engine."""
from __future__ import annotations

import re
from typing import Iterable, List, Optional, Tuple

from app.schemas import (Category, Evidence, EvidenceSourceType, Finding, Rule, RuleType, Scope, Severity)

_CATEGORY = {
    RuleType.PROHIBITED_WORD: Category.PROHIBITED_TERM,
    RuleType.REQUIRED_PHRASE: Category.REQUIRED_PHRASE,
    RuleType.PREFERRED_TERM: Category.PREFERRED_TERM,
    RuleType.TRADEMARK: Category.TRADEMARK,
    RuleType.FORMATTING: Category.FORMATTING,
    RuleType.REGEX: Category.REGEX,
}
_MAX_PATTERN = 500


def _flags(rule: Rule) -> int:
    return 0 if rule.case_sensitive else re.IGNORECASE


def _safe_compile(pattern: str, flags: int) -> Optional[re.Pattern]:
    if len(pattern) > _MAX_PATTERN:
        return None
    # Reject nested-quantifier shapes commonly behind catastrophic backtracking.
    if re.search(r"\([^)]*[+*][^)]*\)[+*{]", pattern):
        return None
    try:
        return re.compile(pattern, flags)
    except re.error:
        return None


def rule_applies(rule: Rule, scope: Scope) -> bool:
    return (rule.active and rule.organization_id == scope.organization_id
            and (rule.brand_id is None or rule.brand_id == scope.brand_id))


def _term_pattern(term: str, flags: int) -> re.Pattern:
    esc = re.escape(term.strip())
    left = r"\b" if term[:1].isalnum() else ""
    right = r"\b" if term[-1:].isalnum() else ""
    return re.compile(f"{left}{esc}{right}", flags)


def _excepted(rule: Rule, content: str, s: int, e: int) -> bool:
    """A match is exempt if an exception phrase overlaps it within the same line/sentence window."""
    if not rule.exceptions:
        return False
    lo = max(0, content.rfind("\n", 0, s) + 1, content.rfind(". ", 0, s) + 2 if content.rfind(". ", 0, s) != -1 else 0)
    hi_n = content.find("\n", e)
    hi = len(content) if hi_n == -1 else hi_n
    window_start = lo
    window = content[window_start:hi]
    for ex in rule.exceptions:
        pat = _term_pattern(ex, 0 if rule.case_sensitive else re.IGNORECASE)
        for m in pat.finditer(window):
            ms, me = window_start + m.start(), window_start + m.end()
            if ms <= e and me >= s:  # exception span overlaps the match
                return True
    return False


def _evidence(rule: Rule) -> Evidence:
    passage = rule.message or rule.name or f"Rule {rule.id}"
    return Evidence(source_type=EvidenceSourceType.RULE, organization_id=rule.organization_id,
                    rule_id=rule.id, document_id=rule.document_id, document_version=rule.document_version,
                    guideline_ref=rule.guideline_ref, passage=passage[:4000])


def _finding(rule: Rule, content: str, s: int, e: int, explanation: str, correction: Optional[str]) -> Finding:
    return Finding(
        category=_CATEGORY[rule.type], severity=rule.severity, confidence=1.0,
        quoted_text=content[s:e], start_offset=s, end_offset=e, explanation=explanation,
        guideline_references=[rule.guideline_ref] if rule.guideline_ref else [],
        supporting_evidence=[_evidence(rule)], suggested_correction=correction,
        requires_human_review=rule.severity in (Severity.HIGH, Severity.CRITICAL) or rule.type == RuleType.TRADEMARK,
        layer="rules")


def run_rules(content: str, rules: Iterable[Rule], scope: Scope) -> Tuple[List[Finding], List[str]]:
    findings: List[Finding] = []
    warnings: List[str] = []
    for rule in rules:
        if not rule_applies(rule, scope):
            continue
        fl = _flags(rule)
        msg = rule.message or rule.name or "Brand rule violation"
        if rule.type in (RuleType.PROHIBITED_WORD, RuleType.PREFERRED_TERM, RuleType.TRADEMARK):
            for term in rule.terms:
                if not term.strip():
                    continue
                for m in _term_pattern(term, fl).finditer(content):
                    s, e = m.span()
                    if _excepted(rule, content, s, e):
                        continue
                    if rule.type == RuleType.TRADEMARK and rule.replacement and content.startswith(rule.replacement, s):
                        continue  # already in the canonical form (e.g. with the ™ symbol)
                    corr = rule.replacement or None
                    findings.append(_finding(rule, content, s, e,
                                             f"{msg}: '{content[s:e]}' is not allowed." if rule.type == RuleType.PROHIBITED_WORD
                                             else f"{msg}: use '{rule.replacement}' instead of '{content[s:e]}'." if rule.replacement
                                             else f"{msg}: '{content[s:e]}'.", corr))
        elif rule.type == RuleType.REQUIRED_PHRASE:
            missing = [t for t in rule.terms if t.strip() and not _term_pattern(t, fl).search(content)]
            if missing:
                # Document-level finding anchored to the first character span (offsets must stay valid).
                end = min(len(content), 1)
                findings.append(_finding(rule, content, 0, end,
                                         f"{msg}: required phrase not found: {', '.join(repr(m) for m in missing)}.",
                                         f"Add: {missing[0]}"))
        elif rule.type in (RuleType.REGEX, RuleType.FORMATTING):
            if not rule.pattern:
                warnings.append(f"rule {rule.id}: missing pattern")
                continue
            pat = _safe_compile(rule.pattern, fl | re.MULTILINE)
            if pat is None:
                warnings.append(f"rule {rule.id}: pattern rejected (invalid or unsafe)")
                continue
            for m in pat.finditer(content):
                s, e = m.span()
                if s == e or _excepted(rule, content, s, e):
                    continue
                corr = None
                if rule.replacement is not None:
                    try:
                        corr = pat.sub(rule.replacement, content[s:e], count=1)
                    except (re.error, IndexError):
                        corr = None
                findings.append(_finding(rule, content, s, e, f"{msg}: '{content[s:e]}'.", corr))
    return dedupe(findings), warnings


def dedupe(findings: List[Finding]) -> List[Finding]:
    """Collapse findings with identical (category, span, rule/fact source)."""
    seen = {}
    for f in findings:
        src = tuple(sorted((e.rule_id or e.fact_id or e.chunk_id or "") for e in f.supporting_evidence))
        key = (f.category, f.start_offset, f.end_offset, src or f.explanation)
        if key not in seen or f.confidence > seen[key].confidence:
            seen[key] = f
    return sorted(seen.values(), key=lambda x: (x.start_offset, x.end_offset))
