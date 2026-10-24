from app.schemas import RuleType, Scope, Severity
from app.services.rules import run_rules
from .conftest import BRAND, ORG, OTHER_ORG, rule

SC = Scope(organization_id=ORG, brand_id=BRAND)


def test_prohibited_word_case_insensitive_with_offsets():
    text = "This is a Cheap plan."
    f, _ = run_rules(text, [rule()], SC)
    assert len(f) == 1 and f[0].quoted_text == "Cheap"
    assert text[f[0].start_offset:f[0].end_offset] == "Cheap"
    assert f[0].supporting_evidence[0].rule_id == "r1" and f[0].guideline_references == ["Voice §4"]


def test_word_boundaries_avoid_substring_matches():
    f, _ = run_rules("Cheaper options exist; scheap is not a word.", [rule()], SC)
    assert f == []


def test_case_sensitive_rule():
    r = rule(terms=["Acme"], case_sensitive=True)
    f, _ = run_rules("acme and Acme", [r], SC)
    assert [x.quoted_text for x in f] == ["Acme"]


def test_inactive_rule_ignored():
    assert run_rules("cheap", [rule(active=False)], SC)[0] == []


def test_org_and_brand_scoping():
    assert run_rules("cheap", [rule(organization_id=OTHER_ORG)], SC)[0] == []
    assert run_rules("cheap", [rule(brand_id="brand_other")], SC)[0] == []
    assert len(run_rules("cheap", [rule(brand_id=BRAND)], SC)[0]) == 1
    assert len(run_rules("cheap", [rule(brand_id=None)], SC)[0]) == 1


def test_exceptions_exempt_matches():
    r = rule(exceptions=["cheap and cheerful"])
    assert run_rules("A cheap and cheerful tone.", [r], SC)[0] == []
    assert len(run_rules("A cheap tone.", [r], SC)[0]) == 1


def test_preferred_term_gives_correction():
    r = rule(id="r2", type=RuleType.PREFERRED_TERM, terms=["utilize"], replacement="use", severity=Severity.LOW)
    f, _ = run_rules("We utilize tools.", [r], SC)
    assert f[0].suggested_correction == "use" and f[0].category.value == "preferred_term"


def test_trademark_flags_missing_symbol_only():
    r = rule(id="tm", type=RuleType.TRADEMARK, terms=["Acme Cloud"], replacement="Acme Cloud™")
    assert len(run_rules("Try acme cloud now.", [r], SC)[0]) == 1
    assert run_rules("Try Acme Cloud™ now.", [r], SC)[0] == []


def test_required_phrase_missing_and_present():
    r = rule(id="req", type=RuleType.REQUIRED_PHRASE, terms=["Terms apply"])
    f, _ = run_rules("Buy now.", [r], SC)
    assert len(f) == 1 and "Terms apply" in f[0].explanation
    assert run_rules("Buy now. Terms apply.", [r], SC)[0] == []


def test_regex_and_formatting_rules_with_replacement():
    r = rule(id="fmt", type=RuleType.FORMATTING, pattern=r" {2,}", replacement=" ")
    f, _ = run_rules("Two  spaces here.", [r], SC)
    assert f[0].quoted_text == "  " and f[0].suggested_correction == " "
    r2 = rule(id="rx", type=RuleType.REGEX, pattern=r"\b\d{1,2}/\d{1,2}/\d{4}\b")
    assert len(run_rules("On 03/04/2026 we ship.", [r2], SC)[0]) == 1


def test_unsafe_or_invalid_regex_rejected_with_warning():
    for bad in (r"(a+)+$", r"([unclosed"):
        f, w = run_rules("aaaa", [rule(id="bad", type=RuleType.REGEX, pattern=bad)], SC)
        assert f == [] and any("rejected" in x for x in w)


def test_duplicate_terms_produce_single_finding():
    f, _ = run_rules("cheap", [rule(terms=["cheap", "Cheap", "cheap"])], SC)
    assert len(f) == 1
