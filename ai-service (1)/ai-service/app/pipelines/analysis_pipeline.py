"""Orchestrates all layers. Layer failures are isolated: deterministic results
are always returned even if an LLM provider is down."""
from __future__ import annotations

import time
import uuid
from datetime import date
from typing import List, Optional

from app.config import Settings
from app.core.errors import ProviderError
from app.schemas import (AnalysisResult, AnalyzeRequest, ApprovedChunk, Category, Finding, LayerStatus, Layers,
                         Severity, UNABLE_TO_VERIFY, UsageStats)
from app.services.analysis.accessibility import check_accessibility
from app.services.analysis.facts import verify_facts
from app.services.analysis.llm_layers import accessibility_layer, guideline_layer, tone_layer
from app.services.analysis.tone import analyze_tone
from app.services.embeddings import Embedder
from app.services.llm import LLMProvider
from app.services.retrieval import VectorStore
from app.services.rules import run_rules
from app.services.validation import EvidenceRegistry, detect_injection, validate_finding

_SEV = {Severity.INFO: 0, Severity.LOW: 1, Severity.MEDIUM: 2, Severity.HIGH: 3, Severity.CRITICAL: 4}


def merge_findings(findings: List[Finding]) -> List[Finding]:
    """Collapse duplicates: same category and overlapping/identical span -> keep the strongest."""
    findings = sorted(findings, key=lambda f: (f.start_offset, f.end_offset))
    merged: List[Finding] = []
    for f in findings:
        dup = next((m for m in merged if m.category == f.category and m.start_offset < f.end_offset
                    and f.start_offset < m.end_offset
                    and (m.start_offset, m.end_offset) == (f.start_offset, f.end_offset)
                    or (m.category == f.category and m.layer != f.layer and m.start_offset <= f.start_offset
                        and f.end_offset <= m.end_offset and m.category in (Category.TONE, Category.ACCESSIBILITY))), None)
        if dup is None:
            merged.append(f)
            continue
        keep, drop = (f, dup) if (_SEV[f.severity], f.confidence) > (_SEV[dup.severity], dup.confidence) else (dup, f)
        # Preserve deterministic findings' evidence if the stronger one lacks it.
        if not keep.supporting_evidence and drop.supporting_evidence:
            keep = keep.model_copy(update={"supporting_evidence": drop.supporting_evidence,
                                           "guideline_references": drop.guideline_references})
        merged[merged.index(dup)] = keep
    return merged


class AnalysisPipeline:
    def __init__(self, settings: Settings, provider: LLMProvider, embedder: Embedder, store: VectorStore):
        self.settings, self.provider, self.embedder, self.store = settings, provider, embedder, store

    async def _retrieve(self, req: AnalyzeRequest, reg: EvidenceRegistry) -> List[ApprovedChunk]:
        """Backend-supplied chunks are used as-is (after filtering). If none supplied, query the tenant-scoped index."""
        if req.evidence_chunks:
            return list(reg.chunks.values())
        qv = await self.embedder.embed_one(req.content[:2000])
        hits = self.store.search(qv, req.scope.organization_id, 5, req.scope.brand_id, req.scope.locale)
        chunks = [ApprovedChunk(chunk_id=h.chunk.chunk_id, organization_id=h.chunk.organization_id,
                                brand_id=h.chunk.brand_id, locale=h.chunk.locale, document_id=h.chunk.document_id,
                                document_version=h.chunk.document_version, status=h.chunk.status,
                                approved=h.chunk.approved, text=h.chunk.text, guideline_ref=h.chunk.guideline_ref)
                  for h in hits]
        for c in chunks:
            reg.chunks[c.chunk_id] = c
        return chunks

    async def run(self, req: AnalyzeRequest, today: Optional[date] = None) -> AnalysisResult:
        t0 = time.perf_counter()
        rid = req.request_id or f"req_{uuid.uuid4().hex[:10]}"
        content = req.content[: self.settings.max_content_chars]
        res = AnalysisResult(request_id=rid, organization_id=req.scope.organization_id)
        if len(req.content) > len(content):
            res.warnings.append("Content truncated to MAX_CONTENT_CHARS.")
        res.injection_signals = detect_injection(content)
        if res.injection_signals:
            res.warnings.append("Content contains instruction-like text; treated strictly as data.")
        reg = EvidenceRegistry.build(req.scope, req.evidence_chunks, req.facts, req.rules)
        for r in reg.refused:
            res.warnings.append(f"Excluded from evidence: {r}")
        usage = UsageStats()
        all_f: List[Finding] = []
        L: Layers = req.layers

        def status(name, ran, n=0, rej=0, reason=None):
            res.layers.append(LayerStatus(layer=name, ran=ran, finding_count=n, rejected_count=rej,
                                          skipped_reason=reason))

        def track(resp):
            usage.llm_calls += 1
            usage.input_tokens += resp.input_tokens
            usage.output_tokens += resp.output_tokens

        # Layer 1
        if L.rules:
            f, w = run_rules(content, reg.rules.values(), req.scope)
            res.warnings += w
            all_f += f
            status("rules", True, len(f))
        else:
            status("rules", False, reason="disabled")
        # Layer 2
        if L.facts:
            f, checks = verify_facts(content, list(reg.facts.values()), req.scope, today)
            res.claim_checks = checks
            all_f += f
            status("facts", True, len(f))
        else:
            status("facts", False, reason="disabled")
        # Layer 5 deterministic
        if L.accessibility:
            f = check_accessibility(content, req.content_format)
            all_f += f
            status("accessibility.deterministic", True, len(f))
        # Layer 4 deterministic
        if L.tone and req.tone_profile:
            f, m = analyze_tone(content, req.tone_profile, req.scope)
            res.metrics["tone"] = m
            all_f += f
            status("tone.deterministic", True, len(f))
        elif L.tone:
            status("tone.deterministic", False, reason="no tone profile supplied")

        # LLM layers (isolated)
        if req.use_llm:
            if L.guidelines:
                try:
                    chunks = await self._retrieve(req, reg)
                    if not chunks:
                        status("guidelines.llm", False, reason=UNABLE_TO_VERIFY + " No approved guideline evidence available.")
                    else:
                        (f, rej, notes), resp = await guideline_layer(self.provider, content, reg)
                        track(resp)
                        res.warnings += sorted(set(notes))
                        all_f += f
                        status("guidelines.llm", True, len(f), rej)
                except ProviderError as e:
                    res.warnings.append(f"guideline layer unavailable: {type(e).__name__}")
                    status("guidelines.llm", False, reason=type(e).__name__)
            if L.tone and req.tone_profile:
                try:
                    (f, rej, notes), resp = await tone_layer(self.provider, content, req.tone_profile, reg)
                    track(resp)
                    all_f += f
                    status("tone.llm", True, len(f), rej)
                except ProviderError as e:
                    res.warnings.append(f"tone layer unavailable: {type(e).__name__}")
                    status("tone.llm", False, reason=type(e).__name__)
            if L.accessibility:
                try:
                    (f, rej, notes), resp = await accessibility_layer(self.provider, content, reg)
                    track(resp)
                    all_f += f
                    status("accessibility.llm", True, len(f), rej)
                except ProviderError as e:
                    res.warnings.append(f"accessibility layer unavailable: {type(e).__name__}")
                    status("accessibility.llm", False, reason=type(e).__name__)

        # Final validation pass over EVERY finding (including deterministic ones).
        final: List[Finding] = []
        for f in all_f:
            vf, reasons = validate_finding(f, content, reg, require_evidence=f.category in (Category.FACT, Category.GUIDELINE))
            if vf is None:
                res.warnings.append("A finding failed final validation and was dropped.")
                continue
            final.append(vf)
        res.findings = merge_findings(final)
        usage.latency_ms = int((time.perf_counter() - t0) * 1000)
        if self.settings.cost_per_1k_input or self.settings.cost_per_1k_output:
            usage.estimated_cost_usd = round(usage.input_tokens / 1000 * self.settings.cost_per_1k_input
                                             + usage.output_tokens / 1000 * self.settings.cost_per_1k_output, 6)
        res.usage = usage
        res.warnings = list(dict.fromkeys(res.warnings))
        return res
