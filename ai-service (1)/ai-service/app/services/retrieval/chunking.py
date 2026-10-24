"""Heading/paragraph-aware chunking with overlap and stable IDs."""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import List


@dataclass
class Chunk:
    chunk_id: str
    index: int
    text: str
    start: int
    end: int
    heading: str = ""


_HEADING = re.compile(r"^(#{1,6}\s+.+|\d+(\.\d+)*\.?\s+[A-Z].{0,80}|[A-Z][A-Z \-]{3,60})$")


def chunk_id_for(org: str, doc_id: str, version: str, index: int, text: str) -> str:
    h = hashlib.sha256(f"{org}|{doc_id}|{version}|{index}|{text}".encode()).hexdigest()[:16]
    return f"chk_{h}"


def chunk_text(text: str, org: str, doc_id: str, version: str,
               max_chars: int = 900, overlap: int = 120) -> List[Chunk]:
    """Split on paragraphs, keep headings attached to following text, cap size.

    `start`/`end` index into the ORIGINAL text so passages can be re-verified.
    """
    paras = []
    for m in re.finditer(r"\S[\s\S]*?(?=\n\s*\n|\Z)", text):
        paras.append((m.start(), m.end(), m.group().strip()))
    chunks: List[Chunk] = []
    cur_start, cur_end, cur_parts, heading = None, None, [], ""

    def flush():
        nonlocal cur_start, cur_end, cur_parts
        if cur_parts:
            body = text[cur_start:cur_end]
            idx = len(chunks)
            chunks.append(Chunk(chunk_id_for(org, doc_id, version, idx, body), idx, body, cur_start, cur_end, heading))
        cur_start, cur_end, cur_parts = None, None, []

    for s, e, p in paras:
        if _HEADING.match(p) and len(p) < 100:
            flush()
            heading = p.lstrip("# ").strip()
        if len(p) > max_chars:
            flush()
            pos = s
            while pos < e:
                end = min(pos + max_chars, e)
                if end < e:  # prefer sentence boundary
                    cut = text.rfind(". ", pos + max_chars // 2, end)
                    end = cut + 1 if cut != -1 else end
                body = text[pos:end]
                idx = len(chunks)
                chunks.append(Chunk(chunk_id_for(org, doc_id, version, idx, body), idx, body, pos, end, heading))
                if end >= e:
                    break
                pos = max(end - overlap, pos + 1)
            continue
        if cur_start is not None and (e - cur_start) > max_chars:
            flush()
        if cur_start is None:
            cur_start = s
        cur_end = e
        cur_parts.append(p)
    flush()
    return chunks
