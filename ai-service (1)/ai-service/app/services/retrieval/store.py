"""Tenant-isolated vector store.

InMemoryVectorStore is a brute-force cosine index (numpy) for local dev/CI,
interchangeable with a FAISS or MongoDB Atlas Vector Search implementation
behind the same `VectorStore` interface. Tenant, brand, locale, status and
version filters are applied BEFORE scoring, never after.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Dict, List, Optional

import numpy as np


@dataclass
class StoredChunk:
    chunk_id: str
    organization_id: str
    brand_id: Optional[str]
    locale: Optional[str]
    document_id: str
    document_version: str
    status: str
    approved: bool
    text: str
    guideline_ref: Optional[str]
    vector: np.ndarray


@dataclass
class ScoredChunk:
    chunk: StoredChunk
    score: float


class VectorStore(ABC):
    @abstractmethod
    def upsert(self, chunks: List[StoredChunk], replace_document: bool = True) -> None: ...

    @abstractmethod
    def search(self, vector: np.ndarray, organization_id: str, top_k: int = 5,
               brand_id: Optional[str] = None, locale: Optional[str] = None,
               document_ids: Optional[List[str]] = None) -> List[ScoredChunk]: ...

    @abstractmethod
    def get(self, organization_id: str, chunk_id: str) -> Optional[StoredChunk]: ...

    @abstractmethod
    def count(self) -> int: ...


class InMemoryVectorStore(VectorStore):
    def __init__(self):
        self._by_org: Dict[str, Dict[str, StoredChunk]] = {}

    def upsert(self, chunks: List[StoredChunk], replace_document: bool = True) -> None:
        if not chunks:
            return
        for key in {(c.organization_id, c.document_id) for c in chunks}:
            if replace_document:
                org, doc = key
                bucket = self._by_org.get(org, {})
                for cid in [i for i, c in bucket.items() if c.document_id == doc]:
                    del bucket[cid]
        for c in chunks:
            self._by_org.setdefault(c.organization_id, {})[c.chunk_id] = c

    def search(self, vector, organization_id, top_k=5, brand_id=None, locale=None, document_ids=None):
        pool = self._by_org.get(organization_id, {})  # hard tenant partition
        cands = []
        for c in pool.values():
            if not c.approved or c.status != "published":
                continue
            if brand_id and c.brand_id not in (None, brand_id):
                continue
            if locale and c.locale not in (None, locale):
                continue
            if document_ids is not None and c.document_id not in document_ids:
                continue
            cands.append(c)
        # Keep only the latest version per document among candidates.
        latest: Dict[str, str] = {}
        for c in cands:
            if c.document_id not in latest or _vkey(c.document_version) > _vkey(latest[c.document_id]):
                latest[c.document_id] = c.document_version
        cands = [c for c in cands if c.document_version == latest[c.document_id]]
        if not cands:
            return []
        mat = np.stack([c.vector for c in cands])
        scores = mat @ vector
        order = np.argsort(-scores)[:top_k]
        return [ScoredChunk(cands[i], float(scores[i])) for i in order]

    def get(self, organization_id, chunk_id):
        return self._by_org.get(organization_id, {}).get(chunk_id)

    def count(self) -> int:
        return sum(len(v) for v in self._by_org.values())


def _vkey(v: str):
    parts = []
    for p in str(v).replace("-", ".").split("."):
        parts.append((0, int(p), "") if p.isdigit() else (1, 0, p))
    return parts
