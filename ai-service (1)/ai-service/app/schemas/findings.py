"""Strict finding/evidence schemas shared by every analysis layer."""
from __future__ import annotations

import uuid
from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

UNABLE_TO_VERIFY = "Unable to verify this claim against the available approved sources."


class Category(str, Enum):
    PROHIBITED_TERM = "prohibited_term"
    REQUIRED_PHRASE = "required_phrase"
    PREFERRED_TERM = "preferred_term"
    TRADEMARK = "trademark"
    FORMATTING = "formatting"
    REGEX = "regex"
    FACT = "fact"
    GUIDELINE = "guideline"
    TONE = "tone"
    ACCESSIBILITY = "accessibility"


class Severity(str, Enum):
    INFO = "info"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class FactVerdict(str, Enum):
    VERIFIED = "verified"
    CONTRADICTION = "verified_contradiction"
    UNSUPPORTED = "unsupported"
    INCONCLUSIVE = "inconclusive"


class EvidenceSourceType(str, Enum):
    APPROVED_GUIDELINE = "approved_guideline"
    APPROVED_FACT = "approved_fact"
    RULE = "rule"


class ReviewStatus(str, Enum):
    PENDING = "pending_review"
    AUTO_ACCEPTED = "auto_accepted"  # only for deterministic, info-level results


class Evidence(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_type: EvidenceSourceType
    organization_id: str
    document_id: Optional[str] = None
    chunk_id: Optional[str] = None
    fact_id: Optional[str] = None
    rule_id: Optional[str] = None
    document_version: Optional[str] = None
    guideline_ref: Optional[str] = None
    passage: str = Field(min_length=1, max_length=4000)


class Finding(BaseModel):
    model_config = ConfigDict(extra="forbid")

    finding_id: str = Field(default_factory=lambda: f"fnd_{uuid.uuid4().hex[:12]}")
    category: Category
    severity: Severity
    confidence: float = Field(ge=0.0, le=1.0)
    quoted_text: str
    start_offset: int = Field(ge=0)
    end_offset: int = Field(ge=0)
    explanation: str = Field(min_length=1, max_length=2000)
    guideline_references: List[str] = Field(default_factory=list)
    supporting_evidence: List[Evidence] = Field(default_factory=list)
    suggested_correction: Optional[str] = Field(default=None, max_length=2000)
    review_status: ReviewStatus = ReviewStatus.PENDING
    requires_human_review: bool = True
    fact_verdict: Optional[FactVerdict] = None
    layer: str = "unknown"
    verification_note: Optional[str] = None
    is_subjective: bool = False

    @model_validator(mode="after")
    def _check_offsets(self) -> "Finding":
        if self.end_offset < self.start_offset:
            raise ValueError("end_offset must be >= start_offset")
        if self.end_offset - self.start_offset != len(self.quoted_text):
            raise ValueError("offset span does not match quoted_text length")
        return self


class LayerStatus(BaseModel):
    layer: str
    ran: bool
    skipped_reason: Optional[str] = None
    finding_count: int = 0
    rejected_count: int = 0


class UsageStats(BaseModel):
    llm_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    estimated_cost_usd: Optional[float] = None
    latency_ms: int = 0


class ClaimCheck(BaseModel):
    """Outcome for one extracted factual claim (including verified ones)."""
    claim_text: str
    start_offset: int
    end_offset: int
    verdict: FactVerdict
    fact_id: Optional[str] = None
    note: str = ""


class AnalysisResult(BaseModel):
    request_id: str
    organization_id: str
    findings: List[Finding] = Field(default_factory=list)
    claim_checks: List[ClaimCheck] = Field(default_factory=list)
    metrics: dict = Field(default_factory=dict)
    layers: List[LayerStatus] = Field(default_factory=list)
    usage: UsageStats = Field(default_factory=UsageStats)
    warnings: List[str] = Field(default_factory=list)
    injection_signals: List[str] = Field(default_factory=list)
