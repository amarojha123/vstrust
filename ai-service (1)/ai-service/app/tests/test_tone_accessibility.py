from app.schemas import Category, Scope, Severity, ToneProfile
from app.services.analysis.accessibility import check_accessibility
from app.services.analysis.tone import analyze_tone
from .conftest import BRAND, ORG

SC = Scope(organization_id=ORG, brand_id=BRAND)
FORMAL = ToneProfile(formality=5, confidence=5, avoid=["slang"], guideline_ref="Voice §1")


def test_formal_profile_flags_informal_language_as_suggestions():
    text = "Hey guys, this is gonna be awesome!"
    f, m = analyze_tone(text, FORMAL, SC)
    quotes = {x.quoted_text.lower() for x in f}
    assert {"hey guys", "gonna", "awesome"} <= quotes
    for x in f:
        assert x.category == Category.TONE and x.is_subjective and x.requires_human_review
        assert x.severity in (Severity.INFO, Severity.LOW, Severity.MEDIUM)  # never a definite violation
        assert "suggestion" in x.explanation.lower()
        assert text[x.start_offset:x.end_offset] == x.quoted_text
    assert m["informal_hits"] >= 3


def test_relaxed_profile_does_not_flag_harmless_variation():
    relaxed = ToneProfile(formality=2, confidence=2)
    f, _ = analyze_tone("Hey guys, this is gonna be awesome!", relaxed, SC)
    assert [x for x in f if x.quoted_text.lower() in ("hey guys", "gonna", "awesome")] == []


def test_hedging_flagged_only_for_confident_voice():
    assert any(x.quoted_text == "maybe" for x in analyze_tone("We maybe can help.", FORMAL, SC)[0])
    soft = ToneProfile(formality=3, confidence=2)
    assert analyze_tone("We maybe can help.", soft, SC)[0] == []


def test_custom_markers_and_hype():
    p = ToneProfile(formality=4, hype_markers=["blazing"], informal_markers=["yo"])
    f, _ = analyze_tone("Yo, our blazing platform is revolutionary.", p, SC)
    assert {"Yo", "blazing", "revolutionary"} <= {x.quoted_text for x in f}


def test_missing_alt_text_html():
    f = check_accessibility('<p>Hi</p><img src="a.png">', "html")
    assert len(f) == 1 and f[0].severity == Severity.HIGH and f[0].layer == "accessibility.deterministic"
    assert check_accessibility('<img src="a.png" alt="A red kettle">', "html") == []
    assert check_accessibility('<img src="a.png" alt="">', "html") == []  # decorative is allowed


def test_non_descriptive_alt_text():
    assert check_accessibility('<img src="a.png" alt="image">', "html")[0].severity == Severity.MEDIUM


def test_vague_links_html_and_markdown():
    html = check_accessibility('<a href="/p">click here</a> and <a href="/p">Pricing plans</a>', "html")
    assert len(html) == 1 and html[0].quoted_text.startswith("<a href=\"/p\">click here")
    md = check_accessibility("See [read more](http://x.test) or ![](pic.png)", "text")
    assert {f.severity for f in md} == {Severity.MEDIUM, Severity.HIGH}


def test_heading_level_skip():
    f = check_accessibility("<h1>A</h1><h3>B</h3>", "html")
    assert any("jumps" in x.explanation for x in f)
