import pytest
from pydantic import ValidationError

from app.schemas import (ApprovedChunk, Category, Evidence, EvidenceSourceType, Finding, Scope, Severity,
                         UNABLE_TO_VERIFY)
from app.services.validation import EvidenceRegistry, validate_evidence, validate_finding
from .conftest import BRAND, ORG, OTHER_ORG, rule

SC = Scope(organization_id=ORG, brand_id=BRAND, locale="en-US")
PASSAGE = "Always use the full product name on first mention."


def reg_with(chunk, **kw):
    return EvidenceRegistry.build(SC, [chunk], kw.get("facts", []), kw.get("rules", []))


def ev(**kw):
    base = dict(source_type=EvidenceSourceType.APPROVED_GUIDELINE, organization_id=ORG, document_id="doc_naming",
                chunk_id="chk_naming1", document_version="2", guideline_ref="Naming Guide §2", passage=PASSAGE)
    base.update(kw)
    return Evidence(**base)


def test_valid_evidence_accepted(chunk):
    assert validate_evidence(ev(), reg_with(chunk)).ok


@pytest.mark.parametrize("override,reason", [
    ({"chunk_id": "chk_fabricated"}, "unknown chunk_id"),
    ({"document_id": "doc_other"}, "document_id does not own chunk"),
    ({"organization_id": OTHER_ORG}, "organization mismatch"),
    ({"document_version": "1"}, "document version mismatch"),
    ({"guideline_ref": "Invented §9"}, "guideline_ref does not match chunk"),
    ({"passage": "Never use the product name at all."}, "passage not found verbatim in chunk"),
])
def test_fabricated_or_mismatched_evidence_rejected(chunk, override, reason):
    r = validate_evidence(ev(**override), reg_with(chunk))
    assert not r.ok and r.reason == reason


def test_passage_check_tolerates_whitespace_and_case(chunk):
    assert validate_evidence(ev(passage="always  use the full\nproduct name on first mention."), reg_with(chunk)).ok


def test_unapproved_other_org_and_wrong_brand_chunks_never_enter_registry(chunk):
    bad = [chunk.model_copy(update={"chunk_id": "c_draft", "approved": False}),
           chunk.model_copy(update={"chunk_id": "c_unpub", "status": "draft"}),
           chunk.model_copy(update={"chunk_id": "c_org", "organization_id": OTHER_ORG}),
           chunk.model_copy(update={"chunk_id": "c_brand", "brand_id": "brand_x"}),
           chunk.model_copy(update={"chunk_id": "c_loc", "locale": "fr-FR"})]
    reg = EvidenceRegistry.build(SC, bad, [], [])
    assert reg.chunks == {} and len(reg.refused) == 5
    for c in bad:
        assert not validate_evidence(ev(chunk_id=c.chunk_id), reg).ok


def test_rule_evidence_requires_known_active_rule():
    reg = EvidenceRegistry.build(SC, [], [], [rule(), rule(id="off", active=False)])
    mk = lambda rid: Evidence(source_type=EvidenceSourceType.RULE, organization_id=ORG, rule_id=rid, passage="x")
    assert validate_evidence(mk("r1"), reg).ok
    assert not validate_evidence(mk("off"), reg).ok and not validate_evidence(mk("ghost"), reg).ok


def finding(evidence=None, **kw):
    base = dict(category=Category.GUIDELINE, severity=Severity.MEDIUM, confidence=0.9, quoted_text="Acme",
                start_offset=4, end_offset=8, explanation="Use the full name.", guideline_references=["Naming Guide §2"],
                supporting_evidence=evidence or [])
    base.update(kw)
    return Finding(**base)


def test_finding_with_bad_evidence_becomes_unable_to_verify(chunk):
    f, reasons = validate_finding(finding([ev(chunk_id="chk_fake")]), "Use Acme now", reg_with(chunk))
    assert f.supporting_evidence == [] and f.guideline_references == []
    assert f.verification_note == UNABLE_TO_VERIFY and UNABLE_TO_VERIFY in f.explanation
    assert f.confidence <= 0.3 and f.requires_human_review
    assert any("unknown chunk_id" in r for r in reasons)


def test_finding_with_good_evidence_kept(chunk):
    f, reasons = validate_finding(finding([ev()]), "Use Acme now", reg_with(chunk))
    assert len(f.supporting_evidence) == 1 and f.verification_note is None and reasons == []
    assert f.guideline_references == ["Naming Guide §2"]


def test_finding_quote_must_match_content(chunk):
    f, reasons = validate_finding(finding([ev()]), "Use Zeta now", reg_with(chunk))
    assert f is None and reasons


def test_schema_is_strict():
    with pytest.raises(ValidationError):
        finding(end_offset=99)  # span does not match quote length
    with pytest.raises(ValidationError):
        finding(confidence=1.5)
    with pytest.raises(ValidationError):
        finding(severity="catastrophic")
    with pytest.raises(ValidationError):
        Finding(**{**finding().model_dump(), "surprise": 1})
    with pytest.raises(ValidationError):
        ev(passage="")
