from __future__ import annotations

from typing import Any

from discovery_contract.fixtures import EXPECTED_SUMMARY, merge


def rule(effect: str, kind: str = "company", company_id: str = "company-a") -> dict[str, Any]:
    scope: dict[str, Any] = {"kind": kind}
    if kind in {"recruiter", "recruiter_opportunity"}:
        scope["recruiter_id"] = "recruiter-a"
    if kind in {"opportunity", "recruiter_opportunity"}:
        scope["opportunity_id"] = "opportunity-a"
    return {
        "candidate_id": "candidate-1",
        "company_id": company_id,
        "effect": effect,
        "scope": scope,
    }


def assert_decision(actual, reason: str, summary_patch: dict[str, Any] | None = None) -> None:
    assert type(actual) is dict, "Decision must be an ordinary JSON object"
    assert set(actual) == {"allowed", "reason", "summary"}
    assert type(actual["allowed"]) is bool, "No truthy strings, numeric flags, or promises"
    assert type(actual["reason"]) is str
    assert actual["reason"] == reason
    assert actual["allowed"] is (reason == "ALLOWED")
    if reason == "ALLOWED":
        assert actual["summary"] == merge(EXPECTED_SUMMARY, summary_patch or {})
        assert set(actual["summary"]) == {
            "candidateId",
            "headline",
            "skills",
            "experienceBand",
            "workPreference",
        }
        assert type(actual["summary"]["skills"]) is list
    else:
        assert actual["summary"] is None, "Denied access must never carry a partial profile"
