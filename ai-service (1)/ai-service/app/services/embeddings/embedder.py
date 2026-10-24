"""Embedding providers.

HashEmbedder is a deterministic, dependency-free lexical embedder (feature
hashing of unigrams+bigrams) for local dev and CI. It is NOT semantic; use the
OpenAI-compatible embedder in production.
"""
from __future__ import annotations

import hashlib
import math
import re
from abc import ABC, abstractmethod
from typing import List

import httpx
import numpy as np

from app.config import Settings
from app.core.errors import ProviderTimeout, ProviderUnavailable, RateLimitError, InvalidModelResponse

_TOKEN = re.compile(r"[a-z0-9]+")


class Embedder(ABC):
    dim: int

    @abstractmethod
    async def embed(self, texts: List[str]) -> np.ndarray: ...

    async def embed_one(self, text: str) -> np.ndarray:
        return (await self.embed([text]))[0]


class HashEmbedder(Embedder):
    def __init__(self, dim: int = 256):
        self.dim = dim

    def _vec(self, text: str) -> np.ndarray:
        toks = _TOKEN.findall(text.lower())
        feats = toks + [f"{a}_{b}" for a, b in zip(toks, toks[1:])]
        v = np.zeros(self.dim, dtype=np.float32)
        for f in feats:
            h = int.from_bytes(hashlib.blake2b(f.encode(), digest_size=8).digest(), "big")
            v[h % self.dim] += 1.0 if (h >> 63) & 1 else -1.0
        n = np.linalg.norm(v)
        return v / n if n else v

    async def embed(self, texts: List[str]) -> np.ndarray:
        return np.stack([self._vec(t) for t in texts]) if texts else np.zeros((0, self.dim), np.float32)


class OpenAIEmbedder(Embedder):
    def __init__(self, api_key: str, base_url: str, model: str, dim: int, timeout: float = 30.0):
        if not api_key:
            raise ValueError("OPENAI_API_KEY is not configured")
        self._key, self._base, self._model, self.dim, self._timeout = api_key, base_url.rstrip("/"), model, dim, timeout

    async def embed(self, texts: List[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), np.float32)
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as c:
                r = await c.post(f"{self._base}/embeddings", json={"model": self._model, "input": texts},
                                 headers={"Authorization": f"Bearer {self._key}"})
        except httpx.TimeoutException as e:
            raise ProviderTimeout("embedding timeout") from e
        except httpx.TransportError as e:
            raise ProviderUnavailable("embedding provider unreachable") from e
        if r.status_code == 429:
            raise RateLimitError("embedding rate limited")
        if r.status_code >= 500:
            raise ProviderUnavailable("embedding provider error")
        if r.status_code >= 400:
            raise InvalidModelResponse("embedding request rejected")
        try:
            arr = np.array([d["embedding"] for d in r.json()["data"]], dtype=np.float32)
        except (KeyError, ValueError) as e:
            raise InvalidModelResponse("malformed embedding response") from e
        norms = np.linalg.norm(arr, axis=1, keepdims=True)
        norms[norms == 0] = 1
        self.dim = arr.shape[1]
        return arr / norms


def build_embedder(settings: Settings) -> Embedder:
    if settings.embedding_provider == "openai":
        return OpenAIEmbedder(settings.openai_api_key, settings.openai_base_url,
                              settings.embedding_model, settings.embedding_dim, settings.llm_timeout_seconds)
    return HashEmbedder(settings.embedding_dim)
