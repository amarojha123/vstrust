import base64
import time

from app.config import Settings
from .conftest import ORG, OTHER_ORG, make_container

SC = {"organization_id": ORG, "brand_id": "brand_1", "locale": "en-US"}
RULE = {"id": "r1", "organization_id": ORG, "type": "prohibited_word", "terms": ["cheap"], "severity": "high"}


def test_health_is_public_but_ready_and_api_are_not_open(client):
    from fastapi.testclient import TestClient
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/ready").status_code == 200
    anon = TestClient(client.app)
    for path in ("/api/v1/analyze", "/api/v1/analyze/rules", "/api/v1/analyze/facts", "/api/v1/analyze/tone",
                 "/api/v1/extract", "/api/v1/knowledge/index", "/api/v1/knowledge/search"):
        assert anon.post(path, json={}).status_code == 401, path
    assert anon.get("/api/v1/tasks/x", params={"organization_id": ORG}).status_code == 401
    assert anon.post("/api/v1/analyze", json={}, headers={"X-Service-Token": "wrong"}).status_code == 401


def test_unconfigured_service_token_fails_closed():
    from fastapi.testclient import TestClient
    from app.main import create_app
    s = Settings(service_auth_token="")
    with TestClient(create_app(s, make_container(s))) as c:
        assert c.post("/api/v1/analyze", json={}, headers={"X-Service-Token": ""}).status_code == 503


def test_invalid_request_bodies_rejected_with_422(client):
    assert client.post("/api/v1/analyze/rules", json={"scope": SC, "content": "x", "rules": [], "extra": 1}).status_code == 422
    assert client.post("/api/v1/analyze", json={"scope": {"organization_id": ""}, "content": "x"}).status_code == 422


def test_analyze_rules_endpoint(client):
    r = client.post("/api/v1/analyze/rules", json={"scope": SC, "content": "A cheap deal.", "rules": [RULE]})
    assert r.status_code == 200
    body = r.json()
    assert body["organization_id"] == ORG and body["findings"][0]["quoted_text"] == "cheap"
    assert body["findings"][0]["requires_human_review"] is True


def test_analyze_facts_endpoint(client):
    fact = {"id": "f1", "organization_id": ORG, "subject": "battery", "keywords": ["zephyr", "battery"],
            "statement": "The Zephyr battery lasts 12 hours.", "value": 12, "unit": "hours"}
    r = client.post("/api/v1/analyze/facts", json={"scope": SC, "content": "The Zephyr battery lasts 20 hours.",
                                                    "facts": [fact]})
    assert r.json()["findings"][0]["fact_verdict"] == "verified_contradiction"


def test_analyze_tone_endpoint(client):
    r = client.post("/api/v1/analyze/tone", json={"scope": SC, "content": "It's gonna be awesome.",
                                                   "tone_profile": {"formality": 5}})
    assert {f["quoted_text"] for f in r.json()["findings"]} >= {"gonna", "awesome"}


def test_extract_endpoint(client):
    b64 = base64.b64encode(b"Hello text").decode()
    r = client.post("/api/v1/extract", json={"filename": "a.txt", "content_base64": b64})
    assert r.status_code == 200 and r.json()["text"] == "Hello text"
    assert client.post("/api/v1/extract", json={"filename": "a.bin", "content_base64": b64}).status_code == 422


def test_knowledge_index_and_search_are_tenant_scoped(client):
    idx = {"scope": SC, "document_id": "d1", "document_version": "1", "status": "published", "approved": True,
           "text": "Always use the full product name on first mention."}
    assert client.post("/api/v1/knowledge/index", json=idx).json()["chunks_indexed"] == 1
    hits = client.post("/api/v1/knowledge/search", json={"scope": SC, "query": "full product name"}).json()["hits"]
    assert hits and hits[0]["organization_id"] == ORG
    other = {**SC, "organization_id": OTHER_ORG}
    assert client.post("/api/v1/knowledge/search", json={"scope": other, "query": "full product name"}).json()["hits"] == []
    assert client.post("/api/v1/knowledge/index", json={**idx, "approved": False}).status_code == 403


def test_full_analyze_uses_tenant_index_when_no_chunks_supplied(client):
    idx = {"scope": SC, "document_id": "d1", "document_version": "1", "status": "published", "approved": True,
           "text": "Always use the full product name on first mention."}
    client.post("/api/v1/knowledge/index", json=idx)
    r = client.post("/api/v1/analyze", json={"scope": SC, "content": "Use Acme alone.", "rules": [RULE]})
    layers = {l["layer"]: l for l in r.json()["layers"]}
    assert layers["guidelines.llm"]["ran"] is True  # mock provider returned no findings, but retrieval ran
    other = client.post("/api/v1/analyze", json={"scope": {**SC, "organization_id": OTHER_ORG}, "content": "Use Acme alone."})
    assert other.json()["layers"] and not {l["layer"]: l for l in other.json()["layers"]}["guidelines.llm"]["ran"]


def test_async_analyze_and_task_isolation(client):
    r = client.post("/api/v1/analyze", json={"scope": SC, "content": "A cheap deal.", "rules": [RULE],
                                              "async_mode": True})
    tid = r.json()["task_id"]
    for _ in range(40):
        t = client.get(f"/api/v1/tasks/{tid}", params={"organization_id": ORG}).json()
        if t["status"] in ("completed", "failed"):
            break
        time.sleep(0.05)
    assert t["status"] == "completed" and t["result"]["findings"]
    assert client.get(f"/api/v1/tasks/{tid}", params={"organization_id": OTHER_ORG}).status_code == 404
    assert client.get("/api/v1/tasks/nope", params={"organization_id": ORG}).status_code == 404
