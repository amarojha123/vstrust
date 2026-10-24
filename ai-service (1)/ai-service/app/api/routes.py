from __future__ import annotations

import asyncio
import hashlib

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from app.core.container import Container
from app.core.errors import ProviderError
from app.core.security import require_service_auth
from app.schemas import (AnalysisResult, AnalyzeAccepted, AnalyzeRequest, ApprovedChunk, ApprovedFact,
                         ExtractRequest, ExtractResponse, FactsRequest, IndexRequest, IndexResponse, Layers,
                         Rule, RuleType, RulesRequest, Scope, SearchRequest, SearchResponse, Severity,
                         TaskResponse, ToneRequest)
from app.services.extraction import ExtractionError, extract_base64

public = APIRouter()
router = APIRouter(prefix="/api/v1", dependencies=[Depends(require_service_auth)])
_scan_keys: dict[str, tuple[str, str, str]] = {}
_scan_guideline_ids: dict[str, set[str]] = {}
_scan_lock = asyncio.Lock()


class ScanContent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-fA-F0-9]{24}$")
    revisionId: str = Field(pattern=r"^[a-fA-F0-9]{24}$")
    title: str = Field(max_length=500)
    body: str = Field(max_length=2_000_000)


class BrandSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-fA-F0-9]{24}$")
    name: str = Field(max_length=120)
    voice: str = Field(max_length=2000)
    tone: str = Field(max_length=2000)
    audience: str = Field(max_length=2000)
    description: str = Field(max_length=10000)


class GuidelineSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-fA-F0-9]{24}$")
    title: str = Field(max_length=200)
    description: str = Field(max_length=10000)
    category: str = Field(max_length=80)
    severity: str


class FactSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-fA-F0-9]{24}$")
    title: str = Field(max_length=200)
    statement: str = Field(max_length=10000)
    sourceUrl: str | None = None


class TerminologySnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-fA-F0-9]{24}$")
    term: str = Field(max_length=200)
    replacement: str = Field(max_length=500)
    description: str = Field(max_length=4000)
    caseSensitive: bool


class ChunkSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-fA-F0-9]{24}$")
    documentId: str = Field(pattern=r"^[a-fA-F0-9]{24}$")
    text: str = Field(max_length=4000)
    page: int | None = Field(default=None, ge=1)


class ScanKnowledge(BaseModel):
    model_config = ConfigDict(extra="forbid")
    brandProfile: BrandSnapshot | None = None
    guidelines: list[GuidelineSnapshot] = Field(default_factory=list, max_length=1000)
    approvedFacts: list[FactSnapshot] = Field(default_factory=list, max_length=1000)
    terminologyRules: list[TerminologySnapshot] = Field(default_factory=list, max_length=1000)
    chunks: list[ChunkSnapshot] = Field(default_factory=list, max_length=2000)


class ScanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    organizationId: str = Field(pattern=r"^[a-fA-F0-9]{24}$")
    content: ScanContent
    knowledge: ScanKnowledge


def _scan_result(result: AnalysisResult, guideline_ids: set[str]) -> dict:
    findings = []
    for item in result.findings:
        evidence = []
        rule_type = None
        for source in item.supporting_evidence:
            if source.rule_id:
                evidence.append({"sourceId": source.rule_id, "quote": source.passage})
                rule_type = "terminologyRule"
            elif source.fact_id:
                evidence.append({"sourceId": source.fact_id, "quote": source.passage})
            elif source.chunk_id and source.document_id and source.document_id in guideline_ids:
                evidence.append({"sourceId": source.document_id, "quote": source.passage})
            elif source.chunk_id and source.document_id:
                evidence.append({"sourceId": source.document_id, "chunkId": source.chunk_id, "quote": source.passage})
        rule_id = next((e["sourceId"] for e in evidence if e["sourceId"] in {r.rule_id for r in item.supporting_evidence if r.rule_id}), None)
        findings.append({
            "id": item.finding_id,
            "category": item.category.value,
            "severity": item.severity.value,
            "message": item.explanation,
            **({"suggestion": item.suggested_correction} if item.suggested_correction is not None else {}),
            "start": item.start_offset,
            "end": item.end_offset,
            **({"ruleId": rule_id, "ruleType": rule_type} if rule_id else {}),
            "evidence": evidence,
        })
    return {"findings": findings}


def _to_analysis(req: ScanRequest, request_id: str) -> AnalyzeRequest:
    org = req.organizationId
    rules = [Rule(
        id=r.id, organization_id=org,
        type=RuleType.PREFERRED_TERM if r.replacement else RuleType.PROHIBITED_WORD,
        name=r.term, terms=[r.term], replacement=r.replacement or None,
        severity=Severity("medium"), case_sensitive=r.caseSensitive,
        message=r.description or None,
    ) for r in req.knowledge.terminologyRules]
    facts = [ApprovedFact(id=f.id, organization_id=org, subject=f.title,
                          keywords=f.title.lower().split(), statement=f.statement, status="approved",
                          text_value=None) for f in req.knowledge.approvedFacts]
    chunks = [ApprovedChunk(chunk_id=c.id, organization_id=org, document_id=c.documentId,
                            document_version="snapshot", status="published", approved=True, text=c.text)
              for c in req.knowledge.chunks]
    chunks.extend(ApprovedChunk(chunk_id=g.id, organization_id=org, document_id=g.id,
                                document_version="snapshot", status="published", approved=True,
                                text=f"{g.title}\n{g.description}", guideline_ref=g.title)
                  for g in req.knowledge.guidelines if g.description)
    return AnalyzeRequest(request_id=request_id, scope=Scope(organization_id=org), content=req.content.body,
                          rules=rules, facts=facts, evidence_chunks=chunks, use_llm=True, async_mode=True,
                          layers=Layers(rules=True, facts=True, guidelines=bool(chunks), tone=False, accessibility=True))


@router.post("/scans")
async def create_scan(req: ScanRequest, request: Request,
                      idempotency_key: str = Header(min_length=8, max_length=128, alias="Idempotency-Key")):
    c = container(request)
    body_hash = hashlib.sha256(req.model_dump_json().encode()).hexdigest()
    async with _scan_lock:
        existing = _scan_keys.get(idempotency_key)
        if existing:
            old_hash, task_id, organization_id = existing
            if old_hash != body_hash:
                raise HTTPException(409, "idempotency key reused with different scan input")
            if organization_id != req.organizationId:
                raise HTTPException(409, "idempotency key belongs to another organization")
            task = c.tasks.get(task_id, organization_id)
            if task:
                status = {"pending": "queued", "running": "running", "completed": "completed", "failed": "failed"}[task.status.value]
                return {"id": task_id, "status": status}
        if len(_scan_keys) >= 1000:
            oldest_key = next(iter(_scan_keys))
            _, expired_id, _ = _scan_keys.pop(oldest_key)
            _scan_guideline_ids.pop(expired_id, None)
        task = c.tasks.create(req.organizationId)
        _scan_keys[idempotency_key] = (body_hash, task.task_id, req.organizationId)
        _scan_guideline_ids[task.task_id] = {g.id for g in req.knowledge.guidelines}
    asyncio.create_task(_run_task(c, task.task_id, _to_analysis(req, task.task_id)))
    return {"id": task.task_id, "status": "queued"}


@router.get("/scans/{scan_id}")
async def get_scan(request: Request, scan_id: str, organization_id: str = Query(alias="organizationId", min_length=1)):
    task = container(request).tasks.get(scan_id, organization_id)
    if task is None:
        raise HTTPException(404, "scan not found")
    status_map = {"pending": "queued", "running": "running", "completed": "completed", "failed": "failed"}
    return {"id": scan_id, "status": status_map[task.status.value]}


@router.get("/scans/{scan_id}/results")
async def get_scan_results(request: Request, scan_id: str, organization_id: str = Query(alias="organizationId", min_length=1)):
    task = container(request).tasks.get(scan_id, organization_id)
    if task is None:
        raise HTTPException(404, "scan not found")
    if task.status.value in ("pending", "running"):
        raise HTTPException(503, "scan is still processing")
    if task.status.value == "failed" or task.result is None:
        raise HTTPException(502, "scan processing failed")
    guideline_ids = _scan_guideline_ids.get(scan_id)
    if guideline_ids is None:
        raise HTTPException(503, "scan source snapshot is unavailable")
    return _scan_result(task.result, guideline_ids)


def container(request: Request) -> Container:
    return request.app.state.container


@public.get("/health")
async def health():
    return {"status": "ok"}


@public.get("/ready")
async def ready(c: Container = Depends(container)):
    ok = c.provider is not None and c.embedder is not None and c.store is not None
    if not ok:
        raise HTTPException(503, "not ready")
    return {"status": "ready", "llm_provider": c.provider.name, "vector_store": type(c.store).__name__}


@router.post("/extract", response_model=ExtractResponse)
async def extract(req: ExtractRequest):
    try:
        ex = extract_base64(req.content_base64, req.filename, req.mime_type)
    except ExtractionError as e:
        raise HTTPException(422, str(e))
    return ExtractResponse(filename=req.filename, mime_type=ex.mime_type, text=ex.text, page_count=ex.page_count,
                           char_count=len(ex.text), warnings=ex.warnings, injection_signals=ex.injection_signals)


@router.post("/knowledge/index", response_model=IndexResponse)
async def knowledge_index(req: IndexRequest, c: Container = Depends(container)):
    try:
        return await c.retrieval.index(req)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ProviderError:
        raise HTTPException(503, "embedding provider unavailable")


@router.post("/knowledge/search", response_model=SearchResponse)
async def knowledge_search(req: SearchRequest, c: Container = Depends(container)):
    try:
        return await c.retrieval.search(req)
    except ProviderError:
        raise HTTPException(503, "embedding provider unavailable")


async def _run_task(c: Container, task_id: str, req: AnalyzeRequest):
    c.tasks.set_running(task_id)
    try:
        c.tasks.complete(task_id, await c.pipeline.run(req))
    except Exception as e:  # noqa: BLE001 - task boundary; never leak details
        c.tasks.fail(task_id, type(e).__name__)


@router.post("/analyze", response_model=AnalysisResult | AnalyzeAccepted)
async def analyze(req: AnalyzeRequest, c: Container = Depends(container)):
    if req.async_mode:
        t = c.tasks.create(req.scope.organization_id)
        asyncio.create_task(_run_task(c, t.task_id, req))
        return AnalyzeAccepted(task_id=t.task_id, status=t.status)
    return await c.pipeline.run(req)


@router.post("/analyze/rules", response_model=AnalysisResult)
async def analyze_rules(req: RulesRequest, c: Container = Depends(container)):
    full = AnalyzeRequest(request_id=req.request_id, scope=req.scope, content=req.content, rules=req.rules,
                          use_llm=False, layers=Layers(rules=True, facts=False, guidelines=False, tone=False,
                                                       accessibility=False))
    return await c.pipeline.run(full)


@router.post("/analyze/facts", response_model=AnalysisResult)
async def analyze_facts(req: FactsRequest, c: Container = Depends(container)):
    full = AnalyzeRequest(request_id=req.request_id, scope=req.scope, content=req.content, facts=req.facts,
                          use_llm=False, layers=Layers(rules=False, facts=True, guidelines=False, tone=False,
                                                       accessibility=False))
    res = await c.pipeline.run(full)
    if req.use_llm:
        res.warnings.append("Fact verification is deterministic; use_llm has no effect on this endpoint.")
    return res


@router.post("/analyze/tone", response_model=AnalysisResult)
async def analyze_tone_ep(req: ToneRequest, c: Container = Depends(container)):
    full = AnalyzeRequest(request_id=req.request_id, scope=req.scope, content=req.content,
                          tone_profile=req.tone_profile, use_llm=req.use_llm,
                          layers=Layers(rules=False, facts=False, guidelines=False, tone=True, accessibility=False))
    return await c.pipeline.run(full)


@router.get("/tasks/{task_id}", response_model=TaskResponse)
async def get_task(task_id: str, organization_id: str = Query(min_length=1), c: Container = Depends(container)):
    t = c.tasks.get(task_id, organization_id)
    if t is None:
        raise HTTPException(404, "task not found")
    return t
