from __future__ import annotations

from dataclasses import dataclass

from app.config import Settings
from app.pipelines.analysis_pipeline import AnalysisPipeline
from app.repositories import TaskRepository
from app.services.embeddings import Embedder, build_embedder
from app.services.llm import LLMProvider, build_provider
from app.services.retrieval import InMemoryVectorStore, RetrievalService, VectorStore


@dataclass
class Container:
    settings: Settings
    provider: LLMProvider
    embedder: Embedder
    store: VectorStore
    retrieval: RetrievalService
    pipeline: AnalysisPipeline
    tasks: TaskRepository


def build_container(settings: Settings, provider: LLMProvider | None = None,
                    embedder: Embedder | None = None, store: VectorStore | None = None) -> Container:
    provider = provider or build_provider(settings)
    embedder = embedder or build_embedder(settings)
    if store is None:
        if settings.vector_store != "memory":
            raise NotImplementedError("Only VECTOR_STORE=memory is bundled; implement VectorStore for Atlas/FAISS.")
        store = InMemoryVectorStore()
    return Container(settings, provider, embedder, store, RetrievalService(store, embedder),
                     AnalysisPipeline(settings, provider, embedder, store), TaskRepository())
