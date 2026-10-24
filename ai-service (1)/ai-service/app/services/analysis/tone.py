"""Layer 4: tone analysis against the explicit brand tone profile.

Tone findings are advisory suggestions: never above MEDIUM severity, always
`is_subjective=True` and flagged for human review. They are not violations.
"""
from __future__ import annotations

import re
from typing import Dict, List, Tuple

from app.schemas import Category, Finding, Scope, Severity, ToneProfile
from .facts import split_sentences

DEFAULT_INFORMAL = ["gonna", "wanna", "gotta", "lol", "omg", "awesome", "super cool", "kinda", "sorta", "btw",
                    "hey guys", "stuff like that", "no worries"]
DEFAULT_HYPE = ["revolutionary", "game-changing", "game changing", "mind-blowing", "best ever", "unbelievable",
                "incredible", "amazing", "life-changing", "magical", "insane"]
DEFAULT_HEDGE = ["maybe", "i guess", "i think", "perhaps", "sort of", "kind of", "might possibly", "hopefully"]
_EMOJI = re.compile("[\U0001F300-\U0001FAFF☀-➿]")


def _find_terms(content: str, terms: List[str]) -> List[Tuple[int, int]]:
    out = []
    for t in terms:
        if not t.strip():
            continue
        for m in re.finditer(r"(?<![\w-])" + re.escape(t) + r"(?![\w-])", content, re.I):
            out.append(m.span())
    return out


def _mk(content, s, e, sev, conf, expl, corr, profile: ToneProfile) -> Finding:
    from app.schemas import Evidence, EvidenceSourceType
    return Finding(category=Category.TONE, severity=sev, confidence=conf, quoted_text=content[s:e], start_offset=s,
                   end_offset=e, explanation=expl, suggested_correction=corr, requires_human_review=True,
                   is_subjective=True, layer="tone.deterministic",
                   guideline_references=[profile.guideline_ref] if profile.guideline_ref else [])


def analyze_tone(content: str, profile: ToneProfile, scope: Scope) -> Tuple[List[Finding], Dict]:
    findings: List[Finding] = []
    informal = DEFAULT_INFORMAL + profile.informal_markers
    hype = DEFAULT_HYPE + profile.hype_markers
    hedge = DEFAULT_HEDGE + profile.hedging_markers
    avoid = {a.lower() for a in profile.avoid}

    if profile.formality >= 4 or "slang" in avoid or "informal" in avoid:
        for s, e in _find_terms(content, informal):
            findings.append(_mk(content, s, e, Severity.LOW, 0.7,
                                f"Informal wording ('{content[s:e]}') may not match the brand's formality level "
                                f"({profile.formality}/5). This is a style suggestion.", None, profile))
        for m in _EMOJI.finditer(content):
            findings.append(_mk(content, m.start(), m.end(), Severity.LOW, 0.6,
                                "Emoji may not suit the brand's formality level. Style suggestion.", None, profile))
    if profile.formality >= 3 or "hype" in avoid or "exaggeration" in avoid:
        for s, e in _find_terms(content, hype):
            findings.append(_mk(content, s, e, Severity.LOW, 0.65,
                                f"Promotional wording ('{content[s:e]}') may conflict with the brand's tone. "
                                "Style suggestion; also consider whether the claim is substantiated.", None, profile))
    if profile.confidence >= 4:
        for s, e in _find_terms(content, hedge):
            findings.append(_mk(content, s, e, Severity.LOW, 0.6,
                                f"Hedging ('{content[s:e]}') may undercut the confident voice in the brand profile. "
                                "Style suggestion.", None, profile))
    if profile.formality >= 4 or "exclamation" in avoid:
        for m in re.finditer(r"!{1,}", content):
            findings.append(_mk(content, m.start(), m.end(), Severity.INFO, 0.5,
                                "Exclamation marks can read as informal for this brand profile. Style suggestion.",
                                None, profile))
    # Clarity / consistency metrics
    sents = split_sentences(content)
    lens = [len(re.findall(r"\w+", content[s:e])) for s, e in sents]
    avg = sum(lens) / len(lens) if lens else 0
    for (s, e), n in zip(sents, lens):
        if n > profile.max_avg_sentence_words * 1.6:
            findings.append(_mk(content, s, e, Severity.INFO, 0.5,
                                f"Very long sentence ({n} words) may reduce clarity. Style suggestion.", None, profile))
    caps = [m for m in re.finditer(r"\b[A-Z]{4,}\b", content)]
    metrics = {
        "sentence_count": len(sents), "avg_sentence_words": round(avg, 1),
        "informal_hits": len(_find_terms(content, informal)), "hype_hits": len(_find_terms(content, hype)),
        "hedge_hits": len(_find_terms(content, hedge)), "all_caps_words": len(caps),
        "exclamations": content.count("!"),
        "mixed_register": bool(_find_terms(content, informal)) and avg > profile.max_avg_sentence_words * 0.8,
    }
    return findings, metrics
