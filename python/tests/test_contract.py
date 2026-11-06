from __future__ import annotations

import copy

import pytest

from discovery_contract.fixtures import CASES, context, materialize

from .helpers import assert_decision


@pytest.mark.contract
@pytest.mark.parametrize("case", CASES, ids=lambda case: case["id"])
def test_shared_contract(sut, case):
    data = materialize(case)
    original = copy.deepcopy(data)
    assert_decision(sut(data), case["expected"], case.get("summary_patch"))
    assert data == original, "Authorization must not mutate trusted records or its request"


def test_contract_has_positive_controls_and_unique_ids():
    ids = [case["id"] for case in CASES]
    assert len(ids) >= 100
    assert len(ids) == len(set(ids))
    assert sum(case["expected"] == "ALLOWED" for case in CASES) >= 15
    assert {
        "allow",
        "auth",
        "agency",
        "scope",
        "hierarchy",
        "isolation",
        "null",
        "validation",
        "affiliation",
        "verification",
        "request",
        "time",
        "projection",
    }.issubset({case["category"] for case in CASES})


REQUIRED = [
    "/now_ms",
    "/account",
    "/account/id",
    "/account/role",
    "/account/status",
    "/candidate",
    "/candidate/id",
    "/candidate/policy",
    "/candidate/policy/candidate_id",
    "/candidate/policy/active",
    "/candidate/policy/mode",
    "/candidate/policy/version",
    "/candidate/current_employer_ids",
    "/candidate/rules",
    "/candidate/rules/0/candidate_id",
    "/candidate/rules/0/company_id",
    "/candidate/rules/0/effect",
    "/candidate/rules/0/scope",
    "/candidate/summary",
    "/candidate/summary/candidateId",
    "/candidate/summary/headline",
    "/candidate/summary/skills",
    "/candidate/summary/experienceBand",
    "/candidate/summary/workPreference",
    "/memberships",
    "/memberships/0/id",
    "/memberships/0/account_id",
    "/memberships/0/company_id",
    "/memberships/0/status",
    "/memberships/0/valid_from_ms",
    "/opportunity",
    "/opportunity/id",
    "/opportunity/membership_id",
    "/opportunity/hiring_company_id",
    "/opportunity/status",
    "/companies",
    "/companies/0/id",
    "/companies/0/kind",
    "/companies/0/verified",
    "/companies/0/active",
    "/mandates",
    "/affiliations",
]


@pytest.mark.parametrize("pointer", REQUIRED)
@pytest.mark.parametrize("operation", ["null", "missing"])
def test_required_context_cannot_fail_open(sut, pointer, operation):
    case = {"set": {pointer: None}} if operation == "null" else {"remove": [pointer]}
    assert_decision(sut(materialize(case)), "INVALID_CONTEXT")


@pytest.mark.parametrize("collection", ["companies", "memberships"])
def test_duplicate_authority_record_ids_are_ambiguous(sut, collection):
    data = context()
    data[collection].append(copy.deepcopy(data[collection][0]))
    assert_decision(sut(data), "INVALID_CONTEXT")


@pytest.mark.parametrize("claim", ["scope", "account_id", "tenant_id", "isAdmin", "__proto__"])
def test_unknown_request_authority_fields_are_rejected(sut, claim):
    data = context({"request": {claim: {"company_id": "company-a", "verified": True}}})
    assert_decision(sut(data), "INVALID_REQUEST")


@pytest.mark.parametrize("value", ["*", "", " ", "company-*", "company-a/company-b", 12, True])
def test_bad_scope_ids_never_broaden_access(sut, value):
    data = context()
    data["candidate"]["rules"][0]["company_id"] = value
    assert_decision(sut(data), "INVALID_CONTEXT")
