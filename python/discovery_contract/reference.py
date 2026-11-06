"""Executable example of the documented contract. Replace through the adapter loader."""

from __future__ import annotations

import re
from collections import deque
from typing import Any

SAFE_INTEGER = 2**53 - 1
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
SUMMARY_FIELDS = ("candidateId", "headline", "skills", "experienceBand", "workPreference")


class InvalidContext(ValueError):
    """A required trusted record is missing or malformed."""


def _object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise InvalidContext("expected object")
    return value


def _identifier(value: Any) -> str:
    if not isinstance(value, str) or ID.fullmatch(value) is None:
        raise InvalidContext("invalid identifier")
    return value


def _integer(value: Any, *, minimum: int = 0) -> int:
    if (
        type(value) not in {int, float}
        or not minimum <= value <= SAFE_INTEGER
        or int(value) != value
    ):
        raise InvalidContext("invalid integer")
    return int(value)


def _boolean(value: Any) -> bool:
    if type(value) is not bool:
        raise InvalidContext("invalid boolean")
    return value


def _enum(value: Any, choices: set[str]) -> str:
    if not isinstance(value, str) or value not in choices:
        raise InvalidContext("unknown enum")
    return value


def _array(value: Any) -> list[Any]:
    if not isinstance(value, list):
        raise InvalidContext("expected array")
    return value


def _records(value: Any, *, unique_ids: bool = False) -> list[dict[str, Any]]:
    records = [_object(record) for record in _array(value)]
    if unique_ids:
        ids = [_identifier(record.get("id")) for record in records]
        if len(ids) != len(set(ids)):
            raise InvalidContext("ambiguous record IDs")
    return records


def _window(record: dict[str, Any]) -> None:
    start = _integer(record.get("valid_from_ms"))
    for key in ("expires_at_ms", "revoked_at_ms"):
        if key not in record:
            raise InvalidContext("missing temporal field")
        if record[key] is not None:
            _integer(record[key])
    if record["expires_at_ms"] is not None and record["expires_at_ms"] <= start:
        raise InvalidContext("invalid validity interval")


def _live(record: dict[str, Any], now: int) -> bool:
    return (
        record["status"] == "verified"
        and record["valid_from_ms"] <= now
        and (record["expires_at_ms"] is None or now < record["expires_at_ms"])
        and (record["revoked_at_ms"] is None or now < record["revoked_at_ms"])
    )


def _scope(scope: Any) -> dict[str, Any]:
    scope = _object(scope)
    kind = _enum(
        scope.get("kind"), {"company", "recruiter", "opportunity", "recruiter_opportunity"}
    )
    expected = {"kind"}
    if kind in {"recruiter", "recruiter_opportunity"}:
        expected.add("recruiter_id")
        _identifier(scope.get("recruiter_id"))
    if kind in {"opportunity", "recruiter_opportunity"}:
        expected.add("opportunity_id")
        _identifier(scope.get("opportunity_id"))
    if set(scope) != expected:
        raise InvalidContext("scope has unexpected dimensions")
    return scope


def _matches(scope: dict[str, Any], actor: str, opportunity: str) -> bool:
    return ("recruiter_id" not in scope or scope["recruiter_id"] == actor) and (
        "opportunity_id" not in scope or scope["opportunity_id"] == opportunity
    )


def _validate(data: dict[str, Any]) -> None:
    _integer(data.get("now_ms"))
    account = _object(data.get("account"))
    _identifier(account.get("id"))
    _enum(account.get("role"), {"recruiter", "candidate", "admin"})
    _enum(account.get("status"), {"active", "suspended", "deleted"})
    candidate = _object(data.get("candidate"))
    _identifier(candidate.get("id"))
    policy = _object(candidate.get("policy"))
    _identifier(policy.get("candidate_id"))
    _boolean(policy.get("active"))
    _enum(policy.get("mode"), {"selected", "verified"})
    _integer(policy.get("version"), minimum=1)
    for employer in _array(candidate.get("current_employer_ids")):
        _identifier(employer)
    for rule in _records(candidate.get("rules")):
        _identifier(rule.get("candidate_id"))
        _identifier(rule.get("company_id"))
        _enum(rule.get("effect"), {"allow", "block"})
        _scope(rule.get("scope"))
    summary = _object(candidate.get("summary"))
    _identifier(summary.get("candidateId"))
    for key in ("headline", "experienceBand", "workPreference"):
        if not isinstance(summary.get(key), str) or not summary[key]:
            raise InvalidContext("invalid summary text")
    if any(not isinstance(skill, str) or not skill for skill in _array(summary.get("skills"))):
        raise InvalidContext("invalid skill")
    for company in _records(data.get("companies"), unique_ids=True):
        _enum(company.get("kind"), {"employer", "agency"})
        _boolean(company.get("verified"))
        _boolean(company.get("active"))
    for membership in _records(data.get("memberships"), unique_ids=True):
        _identifier(membership.get("account_id"))
        _identifier(membership.get("company_id"))
        _enum(membership.get("status"), {"verified", "pending", "revoked", "suspended"})
        _window(membership)
    opportunity = _object(data.get("opportunity"))
    for key in ("id", "membership_id", "hiring_company_id"):
        _identifier(opportunity.get(key))
    _enum(opportunity.get("status"), {"open", "closed", "draft"})
    for mandate in _records(data.get("mandates")):
        _identifier(mandate.get("agency_id"))
        _identifier(mandate.get("hiring_company_id"))
        _enum(mandate.get("status"), {"verified", "pending", "revoked", "suspended"})
        _window(mandate)
    for edge in _records(data.get("affiliations")):
        _identifier(edge.get("company_id"))
        _identifier(edge.get("related_company_id"))
        _enum(edge.get("review_status"), {"verified", "pending", "rejected"})
    known = {company["id"] for company in data["companies"]}
    references = (
        candidate["current_employer_ids"]
        + [rule["company_id"] for rule in candidate["rules"]]
        + [member["company_id"] for member in data["memberships"]]
        + [opportunity["hiring_company_id"]]
        + [
            value
            for mandate in data["mandates"]
            for value in (mandate["agency_id"], mandate["hiring_company_id"])
        ]
        + [
            value
            for edge in data["affiliations"]
            for value in (edge["company_id"], edge["related_company_id"])
        ]
    )
    if any(reference not in known for reference in references):
        raise InvalidContext("unresolved company reference")


def _deny(reason: str) -> dict[str, Any]:
    return {"allowed": False, "reason": reason, "summary": None}


def evaluate(raw: Any) -> dict[str, Any]:
    """Return an internal decision; never return internal reasons to a public API."""
    try:
        data = _object(raw)
        request = data.get("request")
        if not isinstance(request, dict) or set(request) != {"candidate_id", "opportunity_id"}:
            return _deny("INVALID_REQUEST")
        try:
            _identifier(request["candidate_id"])
            _identifier(request["opportunity_id"])
        except InvalidContext:
            return _deny("INVALID_REQUEST")
        if data.get("auth") is None:
            return _deny("UNAUTHENTICATED")
        actor = _identifier(_object(data["auth"]).get("account_id"))
        _validate(data)
    except InvalidContext:
        return _deny("INVALID_CONTEXT")

    account = data["account"]
    candidate = data["candidate"]
    opportunity = data["opportunity"]
    if account["id"] != actor or account["status"] != "active" or account["role"] != "recruiter":
        return _deny("ACCOUNT_DENIED")
    if (
        request["candidate_id"] != candidate["id"]
        or request["opportunity_id"] != opportunity["id"]
        or candidate["policy"]["candidate_id"] != candidate["id"]
        or candidate["summary"]["candidateId"] != candidate["id"]
        or any(rule["candidate_id"] != candidate["id"] for rule in candidate["rules"])
    ):
        return _deny("CONTEXT_MISMATCH")
    if opportunity["status"] != "open":
        return _deny("OPPORTUNITY_DENIED")
    membership = next(
        (member for member in data["memberships"] if member["id"] == opportunity["membership_id"]),
        None,
    )
    now = data["now_ms"]
    if membership is None or membership["account_id"] != actor or not _live(membership, now):
        return _deny("MEMBERSHIP_DENIED")
    companies = {company["id"]: company for company in data["companies"]}
    recruiting = companies[membership["company_id"]]
    hiring = companies[opportunity["hiring_company_id"]]
    if not all(company["verified"] and company["active"] for company in (recruiting, hiring)):
        return _deny("COMPANY_DENIED")
    if recruiting["kind"] == "employer":
        if hiring["id"] != recruiting["id"]:
            return _deny("COMPANY_SCOPE_DENIED")
    elif hiring["kind"] != "employer" or not any(
        mandate["agency_id"] == recruiting["id"]
        and mandate["hiring_company_id"] == hiring["id"]
        and _live(mandate, now)
        for mandate in data["mandates"]
    ):
        return _deny("MANDATE_DENIED")
    if not candidate["policy"]["active"]:
        return _deny("PAUSED")

    involved = {recruiting["id"], hiring["id"]}
    involved.update(
        member["company_id"]
        for member in data["memberships"]
        if member["account_id"] == actor and _live(member, now)
    )
    neighbors: dict[str, set[str]] = {}
    for edge in data["affiliations"]:
        if edge["review_status"] == "verified":
            neighbors.setdefault(edge["company_id"], set()).add(edge["related_company_id"])
            neighbors.setdefault(edge["related_company_id"], set()).add(edge["company_id"])
    queue = deque(involved)
    while queue:
        for neighbor in neighbors.get(queue.popleft(), set()):
            if neighbor not in involved:
                involved.add(neighbor)
                queue.append(neighbor)
    if involved.intersection(candidate["current_employer_ids"]):
        return _deny("EMPLOYER_BLOCKED")
    applicable = [
        rule for rule in candidate["rules"] if _matches(rule["scope"], actor, opportunity["id"])
    ]
    if any(rule["effect"] == "block" and rule["company_id"] in involved for rule in applicable):
        return _deny("BLOCKED")
    allowed = {rule["company_id"] for rule in applicable if rule["effect"] == "allow"}
    if candidate["policy"]["mode"] == "selected" and not {recruiting["id"], hiring["id"]}.issubset(
        allowed
    ):
        return _deny("NOT_SELECTED")
    summary = {key: candidate["summary"][key] for key in SUMMARY_FIELDS}
    summary["skills"] = list(summary["skills"])
    return {"allowed": True, "reason": "ALLOWED", "summary": summary}
