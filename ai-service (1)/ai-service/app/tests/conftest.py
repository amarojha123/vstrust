import asyncio
import json
from datetime import date

import pytest

from app.config import Settings
from app.core.container import build_container
from app.schemas import ApprovedChunk, ApprovedFact, Rule, RuleType, Scope, Severity, ToneProfile
from app.services.llm import MockProvider

ORG, OTHER_ORG, BRAND = "org_1", "org_2", "brand_1"
TODAY = date(2026, 10, 24)


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def settings():
    return Settings(service_auth_token="secret", llm_provider="mock", embedding_provider="hash")


@pytest.fixture
def scope():
    return Scope(organization_id=ORG, brand_id=BRAND, locale="en-US")


@pytest.fixture
def chunk():
    return ApprovedChunk(chunk_id="chk_naming1", organization_id=ORG, brand_id=BRAND, locale="en-US",
                         document_id="doc_naming", document_version="2", status="published", approved=True,
                         text="Always use the full product name on first mention. Never abbreviate it.",
                         guideline_ref="Naming Guide §2")


@pytest.fixture
def battery_fact():
    return ApprovedFact(id="f_batt", organization_id=ORG, brand_id=BRAND, subject="Zephyr X1 battery life",
                        keywords=["zephyr x1", "battery"], statement="The Zephyr X1 battery lasts 12 hours.",
                        value=12, unit="hours", as_of=date(2026, 1, 1), document_id="doc_specs",
                        document_version="5")


@pytest.fixture
def launch_fact():
    return ApprovedFact(id="f_launch", organization_id=ORG, brand_id=BRAND, subject="Zephyr X1 launch",
                        keywords=["zephyr x1", "launch"], statement="The Zephyr X1 launched in March 2021.",
                        text_value="March 2021", document_id="doc_specs", document_version="5")


def rule(**kw):
    base = dict(id="r1", organization_id=ORG, type=RuleType.PROHIBITED_WORD, terms=["cheap"],
                severity=Severity.HIGH, message="Avoid price-undermining words", guideline_ref="Voice §4")
    base.update(kw)
    return Rule(**base)


def llm_json(findings):
    return json.dumps({"findings": findings})


def make_container(settings, provider=None):
    return build_container(settings, provider=provider or MockProvider())


@pytest.fixture
def client(settings):
    from fastapi.testclient import TestClient
    from app.main import create_app
    app = create_app(settings, make_container(settings))
    with TestClient(app) as c:
        c.headers.update({"X-Service-Token": "secret"})
        yield c
