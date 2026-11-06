from __future__ import annotations

import copy
import string

import pytest
from hypothesis import given
from hypothesis import strategies as st

from discovery_contract.fixtures import context

from .helpers import assert_decision, rule

KINDS = st.sampled_from(["company", "recruiter", "opportunity", "recruiter_opportunity"])
SLUG = st.text(alphabet=string.ascii_lowercase, min_size=1, max_size=12)
pytestmark = pytest.mark.property


@given(tenant=SLUG)
def test_other_tenant_requires_its_own_explicit_allow(sut, tenant):
    company_id = f"tenant-{tenant}"
    data = context()
    data["companies"].append(
        {
            "id": company_id,
            "kind": "employer",
            "verified": True,
            "active": True,
        }
    )
    data["memberships"][0]["company_id"] = company_id
    data["opportunity"]["hiring_company_id"] = company_id
    assert_decision(sut(data), "NOT_SELECTED")
    data["candidate"]["rules"].append(rule("allow", company_id=company_id))
    assert_decision(sut(data), "ALLOWED")


@given(allow_kind=KINDS, block_kind=KINDS, reverse=st.booleans())
def test_scope_specificity_never_overrides_a_matching_deny(sut, allow_kind, block_kind, reverse):
    rules = [rule("allow", allow_kind), rule("block", block_kind)]
    if reverse:
        rules.reverse()
    assert_decision(sut(context({"candidate": {"rules": rules}})), "BLOCKED")


@given(extra=st.lists(st.tuples(KINDS, st.sampled_from(["allow", "block"])), max_size=20))
def test_order_and_duplicate_rules_do_not_change_decision(sut, extra):
    rules = [rule("allow")] + [rule(effect, kind) for kind, effect in extra]
    data = context({"candidate": {"rules": rules}})
    expected = sut(copy.deepcopy(data))
    data["candidate"]["rules"] = list(reversed(rules)) + copy.deepcopy(rules)
    assert sut(data) == expected


@given(delay=st.integers(min_value=-1000, max_value=1000))
def test_random_membership_expiry_boundary(sut, delay):
    data = context()
    data["memberships"][0]["expires_at_ms"] = data["now_ms"] + delay
    assert_decision(sut(data), "ALLOWED" if delay > 0 else "MEMBERSHIP_DENIED")


@given(
    key=st.sampled_from(["fullName", "email", "resumeUrl", "currentEmployer", "phone"]),
    secret=st.text(min_size=1, max_size=60),
)
def test_sensitive_extra_fields_never_enter_the_projection(sut, key, secret):
    data = context()
    data["candidate"]["summary"][key] = secret
    data["candidate"]["identity"][key] = secret
    assert_decision(sut(data), "ALLOWED")


@given(length=st.integers(min_value=2, max_value=60), cycle=st.booleans())
def test_transitive_affiliate_graph_cannot_hide_the_employer(sut, length, cycle):
    data = context()
    nodes = [f"node-{index}" for index in range(length)]
    data["companies"].extend(
        {"id": node, "kind": "employer", "verified": True, "active": True} for node in nodes
    )
    chain = ["company-a", *nodes, "employer-x"]
    data["affiliations"] = [
        {"company_id": left, "related_company_id": right, "review_status": "verified"}
        for left, right in zip(chain, chain[1:])
    ]
    if cycle:
        data["affiliations"].append(
            {
                "company_id": nodes[-1],
                "related_company_id": "company-a",
                "review_status": "verified",
            }
        )
    assert_decision(sut(data), "EMPLOYER_BLOCKED")


@given(value=st.one_of(st.none(), st.integers(), st.text(), st.lists(st.integers(), max_size=3)))
def test_request_cannot_self_assert_a_tenant_or_verification(sut, value):
    data = context({"request": {"company_id": value}})
    assert_decision(sut(data), "INVALID_REQUEST")


@given(value=st.sampled_from([None, 0, 1, "true", "false", [], {}]))
def test_truthiness_is_not_boolean_authority(sut, value):
    data = context({"candidate": {"policy": {"active": value}}})
    assert_decision(sut(data), "INVALID_CONTEXT")


@given(version=st.integers(min_value=1, max_value=2**53 - 1))
def test_new_policy_version_cannot_bypass_a_company_block(sut, version):
    data = context(
        {
            "candidate": {
                "policy": {"version": version},
                "rules": [
                    rule("allow"),
                    rule("block"),
                ],
                "identity_grants": [{"approved": True, "policy_version": version}],
            }
        }
    )
    assert_decision(sut(data), "BLOCKED")


@given(actor=SLUG)
def test_recruiter_scoped_allow_does_not_transfer_to_a_new_actor(sut, actor):
    data = context({"candidate": {"rules": [rule("allow", "recruiter")]}})
    assert_decision(sut(data), "ALLOWED")
    actor_id = f"actor-{actor}"
    data["auth"]["account_id"] = actor_id
    data["account"]["id"] = actor_id
    data["memberships"][0]["account_id"] = actor_id
    assert_decision(sut(data), "NOT_SELECTED")


@given(reverse=st.booleans(), duplicate_edges=st.integers(min_value=1, max_value=8))
def test_affiliation_order_and_duplicate_edges_are_idempotent(sut, reverse, duplicate_edges):
    data = context()
    edges = [
        {
            "company_id": "company-a",
            "related_company_id": "affiliate-x",
            "review_status": "verified",
        },
        {
            "company_id": "affiliate-x",
            "related_company_id": "employer-x",
            "review_status": "verified",
        },
    ]
    data["affiliations"] = (list(reversed(edges)) if reverse else edges) * duplicate_edges
    assert_decision(sut(data), "EMPLOYER_BLOCKED")


@given(kind=KINDS)
def test_adding_an_unrelated_company_block_is_noninterfering(sut, kind):
    data = context()
    data["candidate"]["rules"].append(rule("block", kind, "company-b"))
    assert_decision(sut(data), "ALLOWED")
