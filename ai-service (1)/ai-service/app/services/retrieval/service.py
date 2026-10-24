"""Index + search orchestration."""
from __future__ import annotations

import re
from typing import List

from app.schemas import IndexRequest, IndexResponse, SearchHit, SearchRequest, SearchResponse
from app.services.embeddings import Embedder
from app.services.validation.injection import detect_injection
from .chunking import chunk_text
from .store import StoredChunk, VectorStore


class RetrievalService:
    def __init__(self, store: VectorStore, embedder: Embedder):
        self.store = store
        self.embedder = embedder

    async def index(self, req: IndexRequest) -> IndexResponse:
        # Only approved + published documents may become evidence.
        if not req.approved or req.status != "published":
            raise PermissionError("only approved, published documents can be indexed as evidence")
        org = req.scope.organization_id
        # Quarantine instruction-like paragraphs BEFORE chunking so only the offending paragraph is lost.
        # Blanking (same length) keeps every other character offset stable.
        text = req.text
        signals: List[str] = []
        quarantined = 0
        for m in list(re.finditer(r"\S[\s\S]*?(?=\n\s*\n|\Z)", req.text)):
            sig = detect_injection(m.group())
            if sig:
                quarantined += 1
                signals.extend(sig)
                blank = re.sub(r"\S", " ", m.group())
                text = text[:m.start()] + blank + text[m.end():]
        kept = chunk_text(text, org, req.document_id, req.document_version)
        vecs = await self.embedder.embed([c.text for c in kept])
        stored = [StoredChunk(
            chunk_id=c.chunk_id, organization_id=org, brand_id=req.scope.brand_id, locale=req.scope.locale,
            document_id=req.document_id, document_version=req.document_version, status=req.status,
            approved=req.approved, text=c.text, guideline_ref=req.guideline_ref or c.heading or None, vector=v,
        ) for c, v in zip(kept, vecs)]
        self.store.upsert(stored, replace_document=req.replace_existing)
        return IndexResponse(document_id=req.document_id, document_version=req.document_version,
                             chunks_indexed=len(stored), chunks_quarantined=quarantined,
                             injection_signals=sorted(set(signals)))

    async def search(self, req: SearchRequest) -> SearchResponse:
        qv = await self.embedder.embed_one(req.query)
        res = self.store.search(qv, req.scope.organization_id, req.top_k, req.scope.brand_id,
                               req.scope.locale, req.document_ids)
        return SearchResponse(hits=[SearchHit(
            chunk_id=r.chunk.chunk_id, document_id=r.chunk.document_id, document_version=r.chunk.document_version,
            organization_id=r.chunk.organization_id, guideline_ref=r.chunk.guideline_ref, score=r.score,
            text=r.chunk.text) for r in res])
