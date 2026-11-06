from __future__ import annotations

import copy
import itertools

import pytest

from discovery_contract.fixtures import BASE, context, materialize

from .helpers import assert_decision, rule

KINDS = ("company", "recruiter", "opportunity", "recruiter_opportunity")


@pytest.mark.isolation
def test_alternating_companies_never_share_a_cached_authorization(sut):
    a = context()
    b = context()
    b["memberships"][0]["company_id"] = "company-b"
    b["opportunity"]["hiring_company_id"] = "company-b"
    allowed_b = copy.deepcopy(b)
    allowed_b["candidate"]["rules"] = [rule("allow", company_id="company-b")]
    blocked_a = context({"candidate": {"rules": [rule("allow"), rule("block")]}})
    for data, expected in [
        (a, "ALLOWED"),
        (b, "NOT_SELECTED"),
        (blocked_a, "BLOCKED"),
        (allowed_b, "ALLOWED"),
        (a, "ALLOWED"),
        (b, "NOT_SELECTED"),
    ]:
        assert_decision(sut(data), expected)


@pytest.mark.isolation
def test_cross_candidate_rules_do_not_reuse_the_first_candidates_result(sut):
    assert_decision(sut(context()), "ALLOWED")
    data = context()
    data["candidate"]["id"] = "candidate-2"
    data["request"]["candidate_id"] = "candidate-2"
    data["candidate"]["policy"]["candidate_id"] = "candidate-2"
    data["candidate"]["summary"]["candidateId"] = "candidate-2"
    assert_decision(sut(data), "CONTEXT_MISMATCH")


@pytest.mark.parametrize(
    ("allow_kind", "block_kind", "reverse"), list(itertools.product(KINDS, KINDS, [False, True]))
)
def test_deny_dominates_all_matching_scope_hierarchies(sut, allow_kind, block_kind, reverse):
    rules = [rule("allow", allow_kind), rule("block", block_kind)]
    if reverse:
        rules.reverse()
    assert_decision(sut(context({"candidate": {"rules": rules}})), "BLOCKED")


@pytest.mark.parametrize("company", ["agency-a", "company-a"])
def test_agency_or_client_block_dominates_both_allows(sut, company):
    data = materialize({"preset": "agency"})
    data["candidate"]["rules"].append(rule("block", company_id=company))
    assert_decision(sut(data), "BLOCKED")


def test_all_permission_changes_apply_to_the_next_evaluation(sut):
    data = context()
    assert_decision(sut(data), "ALLOWED")
    data["candidate"]["policy"]["active"] = False
    assert_decision(sut(data), "PAUSED")
    data["candidate"]["policy"]["active"] = True
    data["candidate"]["policy"]["version"] += 1
    assert_decision(sut(data), "ALLOWED")
    data["candidate"]["rules"].append(rule("block"))
    assert_decision(sut(data), "BLOCKED")
    data["candidate"]["rules"].pop()
    data["memberships"][0]["status"] = "revoked"
    assert_decision(sut(data), "MEMBERSHIP_DENIED")
    data["memberships"][0]["status"] = "verified"
    data["candidate"]["current_employer_ids"] = ["company-a"]
    assert_decision(sut(data), "EMPLOYER_BLOCKED")


def test_client_change_cannot_reuse_the_old_agency_mandate(sut):
    data = materialize({"preset": "agency"})
    assert_decision(sut(data), "ALLOWED")
    data["opportunity"]["hiring_company_id"] = "company-b"
    data["candidate"]["rules"].append(rule("allow", company_id="company-b"))
    assert_decision(sut(data), "MANDATE_DENIED")


def test_returned_skills_do_not_alias_the_input_or_later_response(sut):
    data = context()
    first = sut(data)
    assert_decision(first, "ALLOWED")
    first["summary"]["skills"].append("UNAUTHORIZED-MUTATION")
    assert data == BASE
    assert_decision(sut(data), "ALLOWED")


@pytest.mark.parametrize("offset", [-1, 0, 1])
@pytest.mark.parametrize("record_kind", ["membership", "mandate"])
def test_expiry_boundary_uses_exclusive_end(sut, offset, record_kind):
    data = materialize({"preset": "agency"}) if record_kind == "mandate" else context()
    collection = "mandates" if record_kind == "mandate" else "memberships"
    data[collection][0]["expires_at_ms"] = data["now_ms"] + offset
    reason = (
        "ALLOWED"
        if offset > 0
        else ("MANDATE_DENIED" if record_kind == "mandate" else "MEMBERSHIP_DENIED")
    )
    assert_decision(sut(data), reason)
