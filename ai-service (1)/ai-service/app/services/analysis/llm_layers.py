"""LLM-assisted layers: guideline compliance (RAG), tone, accessibility.

The model never supplies offsets, document ids, versions or organization ids.
It supplies a verbatim quote and chunk_id references; everything else is
rebuilt server-side from the evidence registry.
"""
from __future__ import annotations

import json
from typing import Dict, List, Literal, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.core.errors import InvalidModelResponse
from app.prompts import ACCESSIBILITY_SYSTEM, GUIDELINE_SYSTEM, TONE_SYSTEM
from app.schemas import (Category, Evidence, EvidenceSourceType, Finding, Severity, ToneProfile)
from app.services.llm import LLMProvider
from app.services.validation import EvidenceRegistry, neutralize, validate_finding, wrap_untrusted


class LLMEvidenceRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    chunk_id: str
    passage: str


class LLMFinding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    category: Literal["guideline", "tone", "accessibility"]
    severity: Severity
    confidence: float = Field(ge=0.0, le=1.0)
    quoted_text: str = Field(min_length=1, max_length=2000)
    explanation: str = Field(min_length=1, max_length=2000)
    evidence: List[LLMEvidenceRef] = Field(default_factory=list, max_length=5)
    suggested_correction: Optional[str] = Field(default=None, max_length=2000)


class LLMOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    findings: List[LLMFinding] = Field(default_factory=list, max_length=50)


def _evidence_block(reg: EvidenceRegistry, chunk_ids: Optional[List[str]] = None) -> str:
    parts = []
    for cid, c in reg.chunks.items():
        if chunk_ids is not None and cid not in chunk_ids:
            continue
        parts.append(f"<approved_evidence chunk_id=\"{cid}\" guideline_ref=\"{c.guideline_ref or ''}\">\n"
                     f"{neutralize(c.text)}\n</approved_evidence>")
    return "\n".join(parts) if parts else "(no approved evidence available)"


def _locate(content: str, quote: str) -> Optional[Tuple[int, int]]:
    i = content.find(quote)
    return (i, i + len(quote)) if i != -1 else None


async def _call(provider: LLMProvider, system: str, user: str):
    data, resp = await provider.complete_json(system, user)
    try:
        return LLMOutput.model_validate(data), resp
    except ValidationError as e:
        raise InvalidModelResponse("model output failed schema validation") from e


def _convert(out: LLMOutput, content: str, reg: EvidenceRegistry, layer: str, require_evidence: bool,
             tone_profile: Optional[ToneProfile] = None) -> Tuple[List[Finding], int, List[str]]:
    findings: List[Finding] = []
    rejected = 0
    notes: List[str] = []
    for lf in out.findings:
        span = _locate(content, lf.quoted_text)
        if span is None:
            rejected += 1
            notes.append("LLM finding dropped: quote not found in content")
            continue
        evs: List[Evidence] = []
        for ref in lf.evidence:
            c = reg.chunks.get(ref.chunk_id)
            if c is None:
                notes.append(f"LLM referenced unknown chunk_id '{ref.chunk_id[:40]}'")
                continue
            evs.append(Evidence(source_type=EvidenceSourceType.APPROVED_GUIDELINE, organization_id=c.organization_id,
                                document_id=c.document_id, chunk_id=c.chunk_id, document_version=c.document_version,
                                guideline_ref=c.guideline_ref, passage=ref.passage[:4000] or c.text[:200]))
        cat = Category(lf.category)
        sev, conf = lf.severity, lf.confidence
        subjective = cat in (Category.TONE, Category.ACCESSIBILITY)
        if subjective:
            sev = sev if sev in (Severity.INFO, Severity.LOW, Severity.MEDIUM) else Severity.MEDIUM
            conf = min(conf, 0.8)
        refs = [e.guideline_ref for e in evs if e.guideline_ref]
        f = Finding(category=cat, severity=sev, confidence=conf, quoted_text=lf.quoted_text,
                    start_offset=span[0], end_offset=span[1], explanation=lf.explanation,
                    guideline_references=refs, supporting_evidence=evs,
                    suggested_correction=lf.suggested_correction, requires_human_review=True,
                    is_subjective=subjective, layer=layer)
        vf, reasons = validate_finding(f, content, reg, require_evidence=require_evidence)
        notes.extend(reasons)
        if vf is None:
            rejected += 1
            continue
        if require_evidence and not vf.supporting_evidence:
            # Guideline claims with no verifiable evidence are not reported as violations.
            rejected += 1
            notes.append("guideline finding dropped: no valid approved evidence")
            continue
        findings.append(vf)
    return findings, rejected, notes


async def guideline_layer(provider: LLMProvider, content: str, reg: EvidenceRegistry,
                          retrieved_chunk_ids: Optional[List[str]] = None):
    user = (f"{_evidence_block(reg, retrieved_chunk_ids)}\n\n{wrap_untrusted('content_under_review', content)}\n\n"
            "Return the JSON object now.")
    out, resp = await _call(provider, GUIDELINE_SYSTEM, user)
    return _convert(out, content, reg, "guidelines.llm", True), resp


async def tone_layer(provider: LLMProvider, content: str, profile: ToneProfile, reg: EvidenceRegistry):
    prof = wrap_untrusted("brand_tone_profile", profile.model_dump_json(exclude={"document_id", "document_version"}))
    user = f"{prof}\n\n{wrap_untrusted('content_under_review', content)}\n\nReturn the JSON object now."
    out, resp = await _call(provider, TONE_SYSTEM, user)
    return _convert(out, content, reg, "tone.llm", False, profile), resp


async def accessibility_layer(provider: LLMProvider, content: str, reg: EvidenceRegistry):
    user = f"{wrap_untrusted('content_under_review', content)}\n\nReturn the JSON object now."
    out, resp = await _call(provider, ACCESSIBILITY_SYSTEM, user)
    return _convert(out, content, reg, "accessibility.llm", False), resp
