"""Small, explicit mutation SAMPLE, not a comprehensive mutation score.

Runs only the 132 original shared discovery cases against in-memory copies
of the Python reference. Production files and targets are never modified.
"""

from __future__ import annotations

import copy
import inspect
import json
import types

from discovery_contract import reference
from discovery_contract.fixtures import CASES, EXPECTED_SUMMARY, materialize, merge

MUTATIONS = [
    (
        "expiry becomes inclusive",
        'now < record["expires_at_ms"]',
        'now <= record["expires_at_ms"]',
    ),
    (
        "revocation becomes inclusive",
        'now < record["revoked_at_ms"]',
        'now <= record["revoked_at_ms"]',
    ),
    ("verification starts early", 'record["valid_from_ms"] <= now', "True"),
    ("actor binding removed", 'account["id"] != actor', "False"),
    ("role gate removed", 'account["role"] != "recruiter"', "False"),
    ("membership ownership ignored", 'membership["account_id"] != actor', "False"),
    ("pause ignored", 'if not candidate["policy"]["active"]:', "if False:"),
    (
        "employer exclusion ignored",
        'if involved.intersection(candidate["current_employer_ids"]):',
        "if False:",
    ),
    ("block precedence removed", 'rule["effect"] == "block"', 'rule["effect"] == "never"'),
    ("pending affiliate trusted", 'if edge["review_status"] == "verified":', "if True:"),
]


def main():
    original = inspect.getsource(reference)
    results = []
    for name, before, after in MUTATIONS:
        if original.count(before) != 1:
            raise RuntimeError(f"Ambiguous mutation: {name}")
        mutant = types.ModuleType(f"audit_mutant_{len(results)}")
        exec(compile(original.replace(before, after), f"<{name}>", "exec"), mutant.__dict__)
        killed_by = []
        for case in CASES:
            data = materialize(case)
            untouched = copy.deepcopy(data)
            expected = {
                "allowed": case["expected"] == "ALLOWED",
                "reason": case["expected"],
                "summary": merge(EXPECTED_SUMMARY, case.get("summary_patch", {}))
                if case["expected"] == "ALLOWED"
                else None,
            }
            try:
                actual = mutant.evaluate(data)
                if actual != expected or data != untouched:
                    killed_by.append(case["id"])
            except Exception as error:  # A crashing policy mutation is also a failing test.
                killed_by.append(f"{case['id']} ({type(error).__name__})")
        results.append({"mutation": name, "killed": bool(killed_by), "killed_by": killed_by})
    print(
        json.dumps(
            {
                "scope": "10 hand-selected Python-reference mutations; original 132 shared cases only",
                "killed": sum(item["killed"] for item in results),
                "total": len(results),
                "results": results,
            },
            indent=2,
        )
    )
    if not all(item["killed"] for item in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
