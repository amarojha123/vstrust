"""Evidence validation: the trust boundary for every finding.

Evidence is accepted only if it matches a server-side registry built from
backend-supplied approved material or the tenant-partitioned vector store.
Anything the LLM asserts that cannot be matched is rejected, and the finding
is either dropped or downgraded to the explicit "unable to verify" state.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from app.schemas import (ApprovedChunk, ApprovedFact, Evidence, EvidenceSourceType, Finding, Rule, Scope,
                         UNABLE_TO_VERIFY)


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


@dataclass
class EvidenceRegistry:
    """Ground truth of what evidence exists for ONE organization/request."""
    organization_id: str
    chunks: Dict[str, ApprovedChunk] = field(default_factory=dict)
    facts: Dict[str, ApprovedFact] = field(default_factory=dict)
    rules: Dict[str, Rule] = field(default_factory=dict)
    refused: List[str] = field(default_factory=list)  # reasons items were excluded

    @classmethod
    def build(cls, scope: Scope, chunks: List[ApprovedChunk], facts: List[ApprovedFact],
              rules: List[Rule]) -> "EvidenceRegistry":
        reg = cls(organization_id=scope.organization_id)
        for c in chunks:
            if c.organization_id != scope.organization_id:
                reg.refused.append(f"chunk {c.chunk_id}: organization mismatch")
            elif not c.approved or c.status != "published":
                reg.refused.append(f"chunk {c.chunk_id}: not approved/published")
            elif scope.brand_id and c.brand_id not in (None, scope.brand_id):
                reg.refused.append(f"chunk {c.chunk_id}: brand mismatch")
            elif scope.locale and c.locale not in (None, scope.locale):
                reg.refused.append(f"chunk {c.chunk_id}: locale mismatch")
            else:
                reg.chunks[c.chunk_id] = c
        for f in facts:
            if f.organization_id != scope.organization_id:
                reg.refused.append(f"fact {f.id}: organization mismatch")
            elif f.status != "approved":
                reg.refused.append(f"fact {f.id}: not approved")
            elif scope.brand_id and f.brand_id not in (None, scope.brand_id):
                reg.refused.append(f"fact {f.id}: brand mismatch")
            else:
                reg.facts[f.id] = f
        for r in rules:
            if r.organization_id != scope.organization_id:
                reg.refused.append(f"rule {r.id}: organization mismatch")
            elif scope.brand_id and r.brand_id not in (None, scope.brand_id):
                continue  # scoping, not an error
            else:
                reg.rules[r.id] = r
        return reg

    def has_any_evidence(self) -> bool:
        return bool(self.chunks or self.facts or self.rules)


@dataclass
class EvidenceCheck:
    ok: bool
    reason: str = ""


def validate_evidence(ev: Evidence, reg: EvidenceRegistry) -> EvidenceCheck:
    if ev.organization_id != reg.organization_id:
        return EvidenceCheck(False, "organization mismatch")
    if ev.source_type == EvidenceSourceType.APPROVED_GUIDELINE:
        if not ev.chunk_id or not ev.document_id:
            return EvidenceCheck(False, "guideline evidence requires chunk_id and document_id")
        chunk = reg.chunks.get(ev.chunk_id)
        if chunk is None:
            return EvidenceCheck(False, "unknown chunk_id")
        if chunk.document_id != ev.document_id:
            return EvidenceCheck(False, "document_id does not own chunk")
        if ev.document_version is not None and ev.document_version != chunk.document_version:
            return EvidenceCheck(False, "document version mismatch")
        if ev.guideline_ref and chunk.guideline_ref and _norm(ev.guideline_ref) != _norm(chunk.guideline_ref):
            return EvidenceCheck(False, "guideline_ref does not match chunk")
        if _norm(ev.passage) not in _norm(chunk.text):
            return EvidenceCheck(False, "passage not found verbatim in chunk")
        return EvidenceCheck(True)
    if ev.source_type == EvidenceSourceType.APPROVED_FACT:
        fact = reg.facts.get(ev.fact_id or "")
        if fact is None:
            return EvidenceCheck(False, "unknown fact_id")
        if ev.document_id and fact.document_id and ev.document_id != fact.document_id:
            return EvidenceCheck(False, "document_id does not own fact")
        if ev.document_version and fact.document_version and ev.document_version != fact.document_version:
            return EvidenceCheck(False, "document version mismatch")
        allowed = _norm(fact.statement) + " " + _norm(fact.source_passage or "")
        if _norm(ev.passage) not in allowed:
            return EvidenceCheck(False, "passage not found in approved fact")
        return EvidenceCheck(True)
    if ev.source_type == EvidenceSourceType.RULE:
        rule = reg.rules.get(ev.rule_id or "")
        if rule is None:
            return EvidenceCheck(False, "unknown rule_id")
        if not rule.active:
            return EvidenceCheck(False, "rule inactive")
        return EvidenceCheck(True)
    return EvidenceCheck(False, "unknown source type")


def validate_finding(f: Finding, content: str, reg: EvidenceRegistry,
                     require_evidence: bool = True) -> Tuple[Optional[Finding], List[str]]:
    """Return (finding or None, rejection reasons).

    - Offsets/quote must match the submitted content exactly.
    - Invalid evidence items are removed; if none remain and evidence is
      required, the finding becomes explicitly unverifiable and is forced to
      human review at low confidence — never presented as supported.
    """
    reasons: List[str] = []
    if f.end_offset > len(content) or content[f.start_offset:f.end_offset] != f.quoted_text:
        return None, ["quoted_text/offsets do not match content"]
    good: List[Evidence] = []
    for ev in f.supporting_evidence:
        chk = validate_evidence(ev, reg)
        if chk.ok:
            good.append(ev)
        else:
            reasons.append(f"evidence rejected: {chk.reason}")
    f = f.model_copy(update={"supporting_evidence": good})
    allowed_refs = {_norm(e.guideline_ref) for e in good if e.guideline_ref}
    for c in reg.chunks.values():
        if any(e.chunk_id == c.chunk_id for e in good) and c.guideline_ref:
            allowed_refs.add(_norm(c.guideline_ref))
    for r in good:
        if r.rule_id and reg.rules.get(r.rule_id) and reg.rules[r.rule_id].guideline_ref:
            allowed_refs.add(_norm(reg.rules[r.rule_id].guideline_ref))
    refs = [r for r in f.guideline_references if _norm(r) in allowed_refs]
    if len(refs) != len(f.guideline_references):
        reasons.append("guideline reference(s) not backed by validated evidence removed")
    f = f.model_copy(update={"guideline_references": refs})
    if require_evidence and not good:
        expl = f.explanation if UNABLE_TO_VERIFY in f.explanation else f"{f.explanation} {UNABLE_TO_VERIFY}"
        f = f.model_copy(update={
            "confidence": min(f.confidence, 0.3),
            "requires_human_review": True,
            "verification_note": UNABLE_TO_VERIFY,
            "explanation": expl.strip()[:2000],
        })
    return f, reasons
