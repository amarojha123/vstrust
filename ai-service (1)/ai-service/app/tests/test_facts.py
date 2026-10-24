from datetime import date

from app.schemas import FactVerdict, Scope, UNABLE_TO_VERIFY
from app.services.analysis.facts import verify_facts
from .conftest import BRAND, ORG, OTHER_ORG, TODAY

SC = Scope(organization_id=ORG, brand_id=BRAND)


def test_verified_claim_produces_no_finding(battery_fact):
    f, checks = verify_facts("The Zephyr X1 battery lasts 12 hours.", [battery_fact], SC, TODAY)
    assert f == [] and checks[0].verdict == FactVerdict.VERIFIED and checks[0].fact_id == "f_batt"


def test_incorrect_number_is_verified_contradiction_with_evidence(battery_fact):
    text = "The Zephyr X1 battery lasts 15 hours."
    f, checks = verify_facts(text, [battery_fact], SC, TODAY)
    assert len(f) == 1
    x = f[0]
    assert x.fact_verdict == FactVerdict.CONTRADICTION and x.quoted_text == "15 hours"
    assert x.suggested_correction == "12 hours"
    assert text[x.start_offset:x.end_offset] == "15 hours"
    ev = x.supporting_evidence[0]
    assert ev.fact_id == "f_batt" and ev.document_id == "doc_specs" and ev.document_version == "5"
    assert x.requires_human_review


def test_outdated_statistic_is_called_out(battery_fact):
    f, _ = verify_facts("In 2024 the Zephyr X1 battery lasted 10 hours.", [battery_fact], SC, TODAY)
    assert f[0].fact_verdict == FactVerdict.CONTRADICTION and "outdated" in f[0].explanation


def test_year_numbers_are_not_mistaken_for_values(battery_fact):
    f, checks = verify_facts("In 2026 the Zephyr X1 battery lasts 12 hours.", [battery_fact], SC, TODAY)
    assert f == [] and checks[0].verdict == FactVerdict.VERIFIED


def test_unsupported_performance_claim_has_no_fabricated_evidence(battery_fact):
    f, checks = verify_facts("Our app is the fastest on the market.", [battery_fact], SC, TODAY)
    assert len(f) == 1 and f[0].fact_verdict == FactVerdict.UNSUPPORTED
    assert f[0].supporting_evidence == [] and f[0].verification_note == UNABLE_TO_VERIFY
    assert checks[0].verdict == FactVerdict.UNSUPPORTED


def test_incorrect_date_detected(launch_fact):
    f, _ = verify_facts("The Zephyr X1 launch happened in April 2021.", [launch_fact], SC, TODAY)
    assert f[0].fact_verdict == FactVerdict.CONTRADICTION and f[0].quoted_text == "April 2021"
    assert f[0].suggested_correction == "March 2021"


def test_matching_date_verified(launch_fact):
    f, checks = verify_facts("The Zephyr X1 launch was in March 2021.", [launch_fact], SC, TODAY)
    assert f == [] and checks[0].verdict == FactVerdict.VERIFIED


def test_incorrect_product_specification_text_value():
    from app.schemas import ApprovedFact
    fact = ApprovedFact(id="f_port", organization_id=ORG, subject="Zephyr X1 charging port",
                        keywords=["zephyr x1", "port"], statement="The Zephyr X1 uses a USB-C port.",
                        text_value="USB-C")
    ok, c1 = verify_facts("The Zephyr X1 port is USB-C, with 2 cables.", [fact], SC, TODAY)
    assert c1[0].verdict == FactVerdict.VERIFIED
    _, c2 = verify_facts("The Zephyr X1 port is Lightning, with 2 cables.", [fact], SC, TODAY)
    assert c2[0].verdict == FactVerdict.INCONCLUSIVE  # no approved basis to call it a contradiction


def test_inconclusive_when_units_differ(battery_fact):
    f, checks = verify_facts("The Zephyr X1 battery lasts 3 days.", [battery_fact], SC, TODAY)
    assert checks[0].verdict == FactVerdict.INCONCLUSIVE
    assert f[0].fact_verdict == FactVerdict.INCONCLUSIVE and f[0].confidence < 0.5


def test_expired_fact_cannot_verify_or_contradict(battery_fact):
    old = battery_fact.model_copy(update={"valid_until": date(2025, 1, 1)})
    f, checks = verify_facts("The Zephyr X1 battery lasts 15 hours.", [old], SC, TODAY)
    assert checks[0].verdict == FactVerdict.INCONCLUSIVE and "expired" in checks[0].note
    assert all(x.fact_verdict != FactVerdict.CONTRADICTION for x in f)


def test_other_org_draft_and_retired_facts_are_ignored(battery_fact):
    for bad in (battery_fact.model_copy(update={"organization_id": OTHER_ORG}),
                battery_fact.model_copy(update={"status": "draft"}),
                battery_fact.model_copy(update={"status": "retired"})):
        f, checks = verify_facts("The Zephyr X1 battery lasts 99 hours.", [bad], SC, TODAY)
        assert f == [] and checks == []


def test_numbers_with_commas_and_multipliers():
    from app.schemas import ApprovedFact
    fact = ApprovedFact(id="f_c", organization_id=ORG, subject="Acme customers", keywords=["acme", "customers"],
                        statement="Acme serves 40,000 customers.", value=40000, unit="customers")
    assert verify_facts("Acme serves 40,000 customers.", [fact], SC, TODAY)[1][0].verdict == FactVerdict.VERIFIED
    assert verify_facts("Acme serves 40k customers.", [fact], SC, TODAY)[1][0].verdict == FactVerdict.VERIFIED
    assert verify_facts("Acme serves 50,000 customers.", [fact], SC, TODAY)[0][0].quoted_text == "50,000 customers"
