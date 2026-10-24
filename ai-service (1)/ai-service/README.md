# TRUST MARK – AI Service

Evidence-grounded brand-compliance engine (FastAPI). It **returns findings**; the Node backend authorizes access, persists findings, and owns users, roles, approvals and workflows.

## Run

```bash
cp .env.example .env            # set SERVICE_AUTH_TOKEN; LLM_PROVIDER=mock works offline
pip install -r requirements.txt
uvicorn app.main:app --port 8000
pytest                          # mock provider only; no network needed
python -m eval.run_eval         # labelled evaluation (see eval/dataset.json caveat)
```

## Integration contract (backend → AI service)

All `/api/v1/*` calls require header `X-Service-Token: <SERVICE_AUTH_TOKEN>` (fails closed if unset). `/health` is open; `/ready` is open and reveals only provider/store type.

**The backend must**: authenticate the user, authorize the organization/brand, and send **only** that tenant's approved material. The service re-checks every item's `organization_id`, approval status, brand and locale, and silently excludes (with a warning) anything that does not match — but it is a second line of defence, not the authorization layer.

### POST /api/v1/analyze
```jsonc
{
  "request_id": "optional-string",
  "scope": {"organization_id": "org_1", "brand_id": "brand_1", "locale": "en-US"},
  "content": "text or html under review", "content_format": "text|html",
  "rules":  [{"id","organization_id","brand_id?","type","terms","pattern?","replacement?","severity","active","case_sensitive","exceptions","guideline_ref?"}],
  "facts":  [{"id","organization_id","subject","keywords","statement","value?","unit?","text_value?","as_of?","valid_until?","status","document_id?","document_version?"}],
  "tone_profile": {"formality":1-5,"confidence":1-5,"avoid":[],"...":""},
  "evidence_chunks": [{"chunk_id","organization_id","document_id","document_version","status":"published","approved":true,"text","guideline_ref"}],
  "layers": {"rules":true,"facts":true,"guidelines":true,"tone":true,"accessibility":true},
  "use_llm": true, "async_mode": false
}
```
If `evidence_chunks` is empty, the service searches its own tenant-partitioned index (populated via `/knowledge/index`).
Response (`AnalysisResult`): `findings[]`, `claim_checks[]` (verified / contradiction / unsupported / inconclusive), `layers[]`, `usage`, `warnings[]`, `injection_signals[]`. With `async_mode:true` you get `{task_id,status}` and poll `GET /api/v1/tasks/{task_id}?organization_id=...` (a wrong org returns 404).

### Finding
`finding_id, category, severity, confidence, quoted_text, start_offset, end_offset, explanation, guideline_references[], supporting_evidence[], suggested_correction, review_status, requires_human_review, fact_verdict?, layer, verification_note?, is_subjective`.
Invariant: `content[start_offset:end_offset] == quoted_text`. Backend should re-check it and persist; **every finding is advisory and defaults to human review**.

### Other endpoints
`POST /extract` (base64 PDF/DOCX/HTML/TXT → text), `POST /knowledge/index` (approved + published documents only, else 403), `POST /knowledge/search`, `POST /analyze/rules|facts|tone`.

## Trust model
- Evidence is accepted only if it matches a server-side registry (org, chunk id, document id, version, guideline ref, verbatim passage). The LLM only supplies a `chunk_id` and a quote; document ids, versions and offsets are rebuilt server-side. Unknown ids ⇒ finding rejected.
- Fact claims with no approved basis are reported as `unsupported` with *"Unable to verify this claim against the available approved sources."* and no evidence. Guideline findings with no valid evidence are dropped (not shown as violations).
- Untrusted text is delimited as inert data, control/tag characters stripped, instruction-like text flagged (`injection_signals`), instruction-like guideline paragraphs quarantined at index time. Detection is a signal; the boundary is structural (schema validation + evidence registry).
- Tone and AI accessibility findings are capped at MEDIUM, `is_subjective=true`, never presented as violations.

## Known limitations
- Only the in-memory (brute-force cosine) vector store is bundled; FAISS/MongoDB Atlas need a `VectorStore` implementation (interface in `services/retrieval/store.py`). Local `hash` embeddings are lexical, not semantic.
- OpenAI-compatible and Gemini providers have not been exercised against live APIs. No LangChain; the RAG pipeline is custom.
- Fact verification is deterministic (regex numbers/dates + keyword matching); it will miss claims phrased without matching keywords.
- No OCR for scanned PDFs. The task store is in-memory (lost on restart).
