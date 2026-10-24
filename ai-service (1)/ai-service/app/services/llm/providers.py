"""Concrete providers: OpenAI-compatible, Gemini, Mock."""
from __future__ import annotations

import json
from typing import Callable, List, Optional, Union

import httpx

from app.config import Settings
from app.core.errors import ProviderTimeout, ProviderUnavailable, RateLimitError, InvalidModelResponse, ProviderError
from .base import LLMProvider, LLMResponse, estimate_tokens


def _raise_for_status(resp: httpx.Response) -> None:
    if resp.status_code == 429:
        raise RateLimitError("rate limited")
    if resp.status_code >= 500:
        raise ProviderUnavailable(f"provider error {resp.status_code}")
    if resp.status_code >= 400:
        # Do not echo bodies: they may contain request content.
        raise InvalidModelResponse(f"provider rejected request ({resp.status_code})")


class OpenAICompatibleProvider(LLMProvider):
    name = "openai"

    def __init__(self, api_key: str, base_url: str, **kw):
        super().__init__(**kw)
        if not api_key:
            raise ValueError("OPENAI_API_KEY is not configured")
        self._key = api_key
        self._base = base_url.rstrip("/")

    async def _complete(self, system: str, user: str, json_mode: bool) -> LLMResponse:
        payload = {
            "model": self.model,
            "temperature": 0,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as c:
                r = await c.post(f"{self._base}/chat/completions", json=payload,
                                 headers={"Authorization": f"Bearer {self._key}"})
        except httpx.TimeoutException as e:
            raise ProviderTimeout("provider timed out") from e
        except httpx.TransportError as e:
            raise ProviderUnavailable("provider unreachable") from e
        _raise_for_status(r)
        try:
            data = r.json()
            usage = data.get("usage", {})
            return LLMResponse(
                text=data["choices"][0]["message"]["content"] or "",
                input_tokens=usage.get("prompt_tokens", estimate_tokens(system + user)),
                output_tokens=usage.get("completion_tokens", 0),
                model=self.model,
            )
        except (KeyError, IndexError, ValueError) as e:
            raise InvalidModelResponse("malformed provider envelope") from e


class GeminiProvider(LLMProvider):
    name = "gemini"

    def __init__(self, api_key: str, **kw):
        super().__init__(**kw)
        if not api_key:
            raise ValueError("GEMINI_API_KEY is not configured")
        self._key = api_key

    async def _complete(self, system: str, user: str, json_mode: bool) -> LLMResponse:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent"
        payload = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {"temperature": 0,
                                 **({"responseMimeType": "application/json"} if json_mode else {})},
        }
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as c:
                r = await c.post(url, json=payload, headers={"x-goog-api-key": self._key})
        except httpx.TimeoutException as e:
            raise ProviderTimeout("provider timed out") from e
        except httpx.TransportError as e:
            raise ProviderUnavailable("provider unreachable") from e
        _raise_for_status(r)
        try:
            data = r.json()
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            u = data.get("usageMetadata", {})
            return LLMResponse(text=text, input_tokens=u.get("promptTokenCount", estimate_tokens(system + user)),
                               output_tokens=u.get("candidatesTokenCount", 0), model=self.model)
        except (KeyError, IndexError, ValueError) as e:
            raise InvalidModelResponse("malformed provider envelope") from e


Responder = Callable[[str, str], str]


class MockProvider(LLMProvider):
    """Deterministic provider for tests/CI. Accepts scripted responses or a callable.

    Items in `script` may be a str (returned), or an Exception (raised).
    """
    name = "mock"

    def __init__(self, script: Optional[List[Union[str, Exception]]] = None,
                 responder: Optional[Responder] = None, **kw):
        kw.setdefault("model", "mock")
        kw.setdefault("backoff_base", 0.0)
        super().__init__(**kw)
        self.script = list(script or [])
        self.responder = responder
        self.calls: List[tuple[str, str]] = []

    async def _complete(self, system: str, user: str, json_mode: bool) -> LLMResponse:
        self.calls.append((system, user))
        if self.script:
            item = self.script.pop(0)
            if isinstance(item, Exception):
                raise item
            text = item
        elif self.responder:
            text = self.responder(system, user)
        else:
            text = json.dumps({"findings": []})
        return LLMResponse(text=text, input_tokens=estimate_tokens(system + user),
                           output_tokens=estimate_tokens(text), model="mock")


def build_provider(settings: Settings) -> LLMProvider:
    common = dict(model=settings.llm_model, timeout=settings.llm_timeout_seconds,
                  max_retries=settings.llm_max_retries, max_input_tokens=settings.llm_max_input_tokens)
    p = settings.llm_provider.lower()
    if p == "openai":
        return OpenAICompatibleProvider(settings.openai_api_key, settings.openai_base_url, **common)
    if p == "gemini":
        common["model"] = settings.gemini_model
        return GeminiProvider(settings.gemini_api_key, **common)
    if p == "mock":
        return MockProvider(**{k: v for k, v in common.items() if k != "model"})
    raise ValueError(f"unknown LLM_PROVIDER: {settings.llm_provider}")
