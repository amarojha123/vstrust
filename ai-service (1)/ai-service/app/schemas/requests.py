"""Request/response contracts exchanged with the Node backend."""
from __future__ import annotations

from datetime import date
from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .findings import AnalysisResult, Category, Severity


class Scope(BaseModel):
    """Tenant scope. The backend is responsible for authorizing it."""
    model_config = ConfigDict(extra="forbid")

    organization_id: str = Field(min_length=1)
    brand_id: Optional[str] = None
    locale: Optional[str] = None


class RuleType(str, Enum):
    PROHIBITED_WORD = "prohibited_word"
    REQUIRED_PHRASE = "required_phrase"
    PREFERRED_TERM = "preferred_term"
    TRADEMARK = "trademark"
    FORMATTING = "formatting"
    REGEX = "regex"


class Rule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    organization_id: str
    brand_id: Optional[str] = None  # None = org-wide
    type: RuleType
    name: str = ""
    terms: List[str] = Field(default_factory=list)  # words/phrases (or canonical form)
    pattern: Optional[str] = None  # regex for REGEX/FORMATTING
    replacement: Optional[str] = None  # preferred/correct form
    severity: Severity = Severity.MEDIUM
    active: bool = True
    case_sensitive: bool = False
    exceptions: List[str] = Field(default_factory=list)  # phrases/regexes that exempt a match
    message: Optional[str] = None
    guideline_ref: Optional[str] = None
    document_id: Optional[str] = None
    document_version: Optional[str] = None


class ApprovedFact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    organization_id: str
    brand_id: Optional[str] = None
    locale: Optional[str] = None
    subject: str  # e.g. "Acme Phone X battery life"
    keywords: List[str] = Field(default_factory=list)  # tokens used to match claims
    statement: str  # canonical statement
    value: Optional[float] = None
    unit: Optional[str] = None
    text_value: Optional[str] = None  # e.g. date string "2021-03-01" or "USB-C"
    as_of: Optional[date] = None
    valid_until: Optional[date] = None  # after this the fact is outdated
    status: Literal["approved", "draft", "retired"] = "approved"
    document_id: Optional[str] = None
    document_version: Optional[str] = None
    source_passage: Optional[str] = None


class ToneProfile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    formality: int = Field(default=3, ge=1, le=5)
    confidence: int = Field(default=3, ge=1, le=5)
    personality: List[str] = Field(default_factory=list)
    avoid: List[str] = Field(default_factory=list)  # e.g. ["slang", "hype"]
    informal_markers: List[str] = Field(default_factory=list)
    hype_markers: List[str] = Field(default_factory=list)
    hedging_markers: List[str] = Field(default_factory=list)
    max_avg_sentence_words: int = 28
    guideline_ref: Optional[str] = None
    document_id: Optional[str] = None
    document_version: Optional[str] = None


class ApprovedChunk(BaseModel):
    """Evidence chunk supplied by the backend (already authorized + approved)."""
    model_config = ConfigDict(extra="forbid")

    chunk_id: str
    organization_id: str
    brand_id: Optional[str] = None
    locale: Optional[str] = None
    document_id: str
    document_version: str
    status: str = "published"
    approved: bool = False
    text: str
    guideline_ref: Optional[str] = None


class Layers(BaseModel):
    rules: bool = True
    facts: bool = True
    guidelines: bool = True
    tone: bool = True
    accessibility: bool = True


class AnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: Optional[str] = None
    scope: Scope
    content: str = Field(min_length=1)
    content_format: Literal["text", "html"] = "text"
    rules: List[Rule] = Field(default_factory=list)
    facts: List[ApprovedFact] = Field(default_factory=list)
    tone_profile: Optional[ToneProfile] = None
    evidence_chunks: List[ApprovedChunk] = Field(default_factory=list)
    layers: Layers = Field(default_factory=Layers)
    use_llm: bool = True
    async_mode: bool = False


class RulesRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: Optional[str] = None
    scope: Scope
    content: str = Field(min_length=1)
    rules: List[Rule]


class FactsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: Optional[str] = None
    scope: Scope
    content: str = Field(min_length=1)
    facts: List[ApprovedFact]
    use_llm: bool = False


class ToneRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: Optional[str] = None
    scope: Scope
    content: str = Field(min_length=1)
    tone_profile: ToneProfile
    use_llm: bool = False


class ExtractRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    filename: str
    content_base64: str
    mime_type: Optional[str] = None


class ExtractResponse(BaseModel):
    filename: str
    mime_type: str
    text: str
    page_count: Optional[int] = None
    char_count: int
    warnings: List[str] = Field(default_factory=list)
    injection_signals: List[str] = Field(default_factory=list)


class IndexRequest(BaseModel):
    """Index an *approved, published* guideline document."""
    model_config = ConfigDict(extra="forbid")

    scope: Scope
    document_id: str
    document_version: str
    status: str
    approved: bool
    text: str = Field(min_length=1)
    guideline_ref: Optional[str] = None
    replace_existing: bool = True


class IndexResponse(BaseModel):
    document_id: str
    document_version: str
    chunks_indexed: int
    chunks_quarantined: int = 0
    injection_signals: List[str] = Field(default_factory=list)


class SearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scope: Scope
    query: str = Field(min_length=1)
    top_k: int = Field(default=5, ge=1, le=20)
    document_ids: Optional[List[str]] = None


class SearchHit(BaseModel):
    chunk_id: str
    document_id: str
    document_version: str
    organization_id: str
    guideline_ref: Optional[str] = None
    score: float
    text: str


class SearchResponse(BaseModel):
    hits: List[SearchHit]


class TaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class TaskResponse(BaseModel):
    task_id: str
    organization_id: str
    status: TaskStatus
    result: Optional[AnalysisResult] = None
    error: Optional[str] = None


class AnalyzeAccepted(BaseModel):
    task_id: str
    status: TaskStatus


__all__ = [n for n in dir() if not n.startswith("_")]
