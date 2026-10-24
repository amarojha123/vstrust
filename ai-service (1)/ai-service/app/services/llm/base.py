"""Provider-agnostic LLM interface with retry/backoff."""
from __future__ import annotations

import asyncio
import json
import random
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Dict, Optional

from app.core.errors import InvalidModelResponse, ProviderError, TokenLimitExceeded


@dataclass
class LLMResponse:
    text: str
    input_tokens: int = 0
    output_tokens: int = 0
    model: str = ""


def estimate_tokens(text: str) -> int:
    # Conservative heuristic (~4 chars/token); providers report real usage.
    return max(1, len(text) // 4)


class LLMProvider(ABC):
    name = "base"

    def __init__(self, model: str, timeout: float = 30.0, max_retries: int = 3,
                 max_input_tokens: int = 12000, backoff_base: float = 0.5):
        self.model = model
        self.timeout = timeout
        self.max_retries = max_retries
        self.max_input_tokens = max_input_tokens
        self.backoff_base = backoff_base

    @abstractmethod
    async def _complete(self, system: str, user: str, json_mode: bool) -> LLMResponse: ...

    async def complete(self, system: str, user: str, json_mode: bool = True) -> LLMResponse:
        if estimate_tokens(system) + estimate_tokens(user) > self.max_input_tokens:
            raise TokenLimitExceeded("prompt exceeds configured input token limit")
        attempt = 0
        while True:
            try:
                return await self._complete(system, user, json_mode)
            except ProviderError as exc:
                attempt += 1
                if not exc.retryable or attempt > self.max_retries:
                    raise
                delay = self.backoff_base * (2 ** (attempt - 1)) + random.uniform(0, 0.1)
                await asyncio.sleep(delay)

    async def complete_json(self, system: str, user: str) -> tuple[Dict[str, Any], LLMResponse]:
        resp = await self.complete(system, user, json_mode=True)
        try:
            data = parse_json_loose(resp.text)
        except ValueError as exc:
            raise InvalidModelResponse(str(exc)) from exc
        if not isinstance(data, dict):
            raise InvalidModelResponse("model JSON must be an object")
        return data, resp


def parse_json_loose(text: str) -> Any:
    """Parse JSON, tolerating markdown fences. Never evals anything."""
    s = text.strip()
    if s.startswith("```"):
        s = s.strip("`")
        if s.lower().startswith("json"):
            s = s[4:]
    start, end = s.find("{"), s.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("no JSON object in model output")
    try:
        return json.loads(s[start:end + 1])
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON from model: {exc}") from exc
