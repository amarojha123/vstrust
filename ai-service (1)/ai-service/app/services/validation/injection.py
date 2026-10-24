"""Prompt-injection detection and untrusted-text handling.

Detection is a *signal*, not a security boundary. The real boundary is
structural: untrusted text only ever appears inside delimited data blocks,
the model's output is schema-validated, and every evidence reference is
checked against server-side records (see evidence.py).
"""
from __future__ import annotations

import re
import unicodedata
from typing import List, Tuple

_PATTERNS: List[Tuple[str, re.Pattern]] = [
    ("override_instructions", re.compile(
        r"\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|system|all|any)\b[^.\n]{0,40}\b(instruction|prompt|rule|polic|guideline|message)", re.I)),
    ("role_hijack", re.compile(r"\b(you are now|act as|pretend to be|new instructions?|from now on you)\b", re.I)),
    ("system_prompt_probe", re.compile(r"\b(reveal|print|show|repeat|leak)\b[^.\n]{0,30}\b(system prompt|instructions|api key|secret|token)", re.I)),
    ("fake_delimiters", re.compile(r"(<\s*/?\s*(system|assistant|instructions?|evidence|untrusted\w*)\s*>|\[/?INST\]|<\|im_(start|end)\|>)", re.I)),
    ("cross_tenant", re.compile(r"\b(other|another|different|all)\s+(organi[sz]ations?|tenants?|compan(y|ies)|clients?)\b[^.\n]{0,40}\b(document|guideline|data|record|fact)", re.I)),
    ("approval_tampering", re.compile(r"\b(mark|set|approve|treat)\b[^.\n]{0,30}\b(as\s+)?(approved|compliant|verified|no violations?)\b", re.I)),
    ("output_forcing", re.compile(r"\b(return|respond|output)\b[^.\n]{0,25}\b(empty findings|no findings|\{\s*\"findings\"\s*:\s*\[\s*\])", re.I)),
]

_ZERO_WIDTH = dict.fromkeys(map(ord, "​‌‍⁠﻿"), None)


def normalize_for_detection(text: str) -> str:
    t = unicodedata.normalize("NFKC", text).translate(_ZERO_WIDTH)
    return t


def detect_injection(text: str) -> List[str]:
    t = normalize_for_detection(text)
    return sorted({name for name, pat in _PATTERNS if pat.search(t)})


def neutralize(text: str) -> str:
    """Strip control chars and tag-like delimiters so text cannot close our data blocks."""
    t = normalize_for_detection(text)
    t = "".join(ch for ch in t if ch in "\n\t" or unicodedata.category(ch)[0] != "C")
    t = re.sub(r"<\s*/?\s*(untrusted_content|approved_evidence|system|assistant)[^>]*>", "[removed-tag]", t, flags=re.I)
    return t


def wrap_untrusted(label: str, text: str) -> str:
    """Wrap text for inclusion in an LLM prompt as inert data."""
    return f"<untrusted_content label=\"{label}\">\n{neutralize(text)}\n</untrusted_content>"
