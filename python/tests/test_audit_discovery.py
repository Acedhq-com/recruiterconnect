"""Additional boundary tests; the session's configured adapter is the SUT."""

from copy import deepcopy

import pytest

from discovery_contract.fixtures import context, materialize

from .helpers import assert_decision, rule


@pytest.mark.parametrize("offset", [-1, 0, 1])
@pytest.mark.parametrize("field", ["valid_from_ms", "expires_at_ms", "revoked_at_ms"])
def test_audit_mandate_temporal_boundaries(sut, offset, field):
    data = materialize(
        {"id": "audit-agency", "category": "agency", "preset": "agency", "expected": "ALLOWED"}
    )
    data["mandates"][0][field] = data["now_ms"] + offset
    allowed = offset <= 0 if field == "valid_from_ms" else offset > 0
    assert_decision(sut(data), "ALLOWED" if allowed else "MANDATE_DENIED")


@pytest.mark.parametrize("offset", [-1, 0, 1])
@pytest.mark.parametrize("field", ["valid_from_ms", "expires_at_ms", "revoked_at_ms"])
def test_audit_secondary_membership_temporal_boundaries(sut, offset, field):
    data = context()
    secondary = {
        **deepcopy(data["memberships"][0]),
        "id": "audit-secondary",
        "company_id": "employer-x",
    }
    secondary[field] = data["now_ms"] + offset
    data["memberships"].append(secondary)
    live = offset <= 0 if field == "valid_from_ms" else offset > 0
    assert_decision(sut(data), "EMPLOYER_BLOCKED" if live else "ALLOWED")


@pytest.mark.parametrize("status", ["pending", "revoked", "suspended"])
def test_audit_nonlive_secondary_membership_does_not_exclude(sut, status):
    data = context()
    data["memberships"].append(
        {
            **deepcopy(data["memberships"][0]),
            "id": "audit-secondary",
            "company_id": "employer-x",
            "status": status,
        }
    )
    assert_decision(sut(data), "ALLOWED")


def test_audit_secondary_company_composite_scope_block(sut):
    data = context()
    data["memberships"].append(
        {
            **deepcopy(data["memberships"][0]),
            "id": "audit-secondary",
            "company_id": "company-b",
        }
    )
    data["candidate"]["rules"].append(rule("block", "recruiter_opportunity", "company-b"))
    assert_decision(sut(data), "BLOCKED")


@pytest.mark.parametrize("now", [float("nan"), float("inf"), float("-inf")])
def test_audit_nonfinite_clock_denies(sut, now):
    assert_decision(sut(context({"now_ms": now})), "INVALID_CONTEXT")


@pytest.mark.parametrize("length", [64, 65])
def test_audit_actor_identifier_length_boundary(sut, length):
    data = context()
    identifier = "a" * length
    data["auth"]["account_id"] = identifier
    data["account"]["id"] = identifier
    data["memberships"][0]["account_id"] = identifier
    assert_decision(sut(data), "ALLOWED" if length == 64 else "INVALID_CONTEXT")


def test_audit_unresolved_irrelevant_company_still_fails_closed(sut):
    data = context()
    extra = rule("allow", "recruiter", "unresolved-company")
    extra["scope"]["recruiter_id"] = "another-recruiter"
    data["candidate"]["rules"].append(extra)
    assert_decision(sut(data), "INVALID_CONTEXT")


def test_audit_reviewed_affiliation_removal_is_recomputed(sut):
    data = context()
    data["affiliations"] = [
        {
            "company_id": "company-a",
            "related_company_id": "employer-x",
            "review_status": "verified",
        }
    ]
    assert_decision(sut(data), "EMPLOYER_BLOCKED")
    data["affiliations"][0]["review_status"] = "rejected"
    assert_decision(sut(data), "ALLOWED")
