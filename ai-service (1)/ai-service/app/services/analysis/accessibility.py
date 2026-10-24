"""Layer 5 (deterministic half): accessibility checks. AI-assisted suggestions live in llm_layers.py."""
from __future__ import annotations

import re
from typing import List

from app.schemas import Category, Finding, Severity

VAGUE_LINK = {"click here", "here", "read more", "learn more", "more", "link", "this link", "click", "details",
              "this page", "go"}
_IMG = re.compile(r"<img\b[^>]*>", re.I)
_ALT = re.compile(r"\balt\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", re.I)
_A = re.compile(r"<a\b[^>]*>(.*?)</a>", re.I | re.S)
_MD_IMG = re.compile(r"!\[(?P<alt>[^\]]*)\]\([^)]+\)")
_MD_LINK = re.compile(r"(?<!!)\[(?P<t>[^\]]+)\]\([^)]+\)")
_HEADING = re.compile(r"<h([1-6])\b", re.I)


def _f(content, s, e, sev, expl, corr=None, conf=1.0) -> Finding:
    return Finding(category=Category.ACCESSIBILITY, severity=sev, confidence=conf, quoted_text=content[s:e],
                   start_offset=s, end_offset=e, explanation=expl, suggested_correction=corr,
                   requires_human_review=False if conf >= 0.95 and sev != Severity.HIGH else True,
                   layer="accessibility.deterministic")


def check_accessibility(content: str, content_format: str = "text") -> List[Finding]:
    out: List[Finding] = []
    for m in _IMG.finditer(content):
        tag = m.group()
        alt = _ALT.search(tag)
        if alt is None:
            out.append(_f(content, m.start(), m.end(), Severity.HIGH,
                          "Image has no alt attribute. Add descriptive alt text, or alt=\"\" if purely decorative.",
                          "Add alt=\"<describe the image>\""))
        else:
            val = alt.group(1).strip("\"'").strip()
            if val.lower() in {"image", "photo", "picture", "img", "graphic"} or re.fullmatch(r".*\.(png|jpe?g|gif|svg)", val, re.I):
                out.append(_f(content, m.start(), m.end(), Severity.MEDIUM,
                              f"Alt text '{val}' is not descriptive.", None, 0.9))
    for m in _MD_IMG.finditer(content):
        if not m.group("alt").strip():
            out.append(_f(content, m.start(), m.end(), Severity.HIGH, "Markdown image is missing alt text.",
                          "Add a description inside the square brackets."))
    for m in _A.finditer(content):
        text = re.sub(r"<[^>]+>", "", m.group(1)).strip().lower()
        if text in VAGUE_LINK:
            s, e = m.span()
            out.append(_f(content, s, e, Severity.MEDIUM,
                          f"Link text '{text}' is vague out of context; screen-reader users navigate by link text.",
                          "Use text that describes the destination.", 0.95))
    for m in _MD_LINK.finditer(content):
        if m.group("t").strip().lower() in VAGUE_LINK:
            out.append(_f(content, m.start(), m.end(), Severity.MEDIUM,
                          f"Link text '{m.group('t')}' is vague out of context.",
                          "Use text that describes the destination.", 0.95))
    if content_format == "text":
        for m in re.finditer(r"\bclick here\b", content, re.I):
            if not any(f.start_offset <= m.start() < f.end_offset for f in out):
                out.append(_f(content, m.start(), m.end(), Severity.LOW,
                              "'Click here' is vague and device-specific.", "Describe the action or destination.", 0.8))
    if content_format == "html":
        levels = [(int(m.group(1)), m.start(), m.end()) for m in _HEADING.finditer(content)]
        for (a, _, _), (b, s, e) in zip(levels, levels[1:]):
            if b > a + 1:
                out.append(_f(content, s, e, Severity.LOW, f"Heading level jumps from h{a} to h{b}.",
                              f"Use h{a + 1}.", 0.9))
    # Long all-caps runs are hard to read for many users.
    for m in re.finditer(r"\b(?:[A-Z]{2,}\s+){4,}[A-Z]{2,}\b", content):
        out.append(_f(content, m.start(), m.end(), Severity.LOW, "Long all-caps text is harder to read.",
                      m.group().capitalize(), 0.85))
    return out
