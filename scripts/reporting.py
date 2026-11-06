from __future__ import annotations

import json
import math
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def require_fresh(path: Path, marker: Path) -> None:
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError(f"Missing or empty report: {path.name}")
    if path.stat().st_mtime_ns < marker.stat().st_mtime_ns:
        raise ValueError(f"Stale report predates this run: {path.name}")


def run_marker(reports: Path) -> dict[str, Any]:
    path = reports / "run-start.json"
    if not path.is_file():
        raise ValueError("Start this run with python -m scripts.validate_ci_reports --start")
    data = read_json(path)
    if (
        not isinstance(data, dict)
        or not isinstance(data.get("run_id"), str)
        or not data["run_id"]
        or data.get("mode") not in {"reference", "production"}
    ):
        raise ValueError("Invalid run marker")
    return data


def expected_rows(root: Path = ROOT) -> list[dict[str, Any]]:
    cases = read_json(root / "shared/cases.json")
    base_summary = read_json(root / "shared/base.json")["candidate"]["summary"]
    ids = [case["id"] for case in cases]
    if len(ids) < 100 or len(ids) != len(set(ids)):
        raise ValueError("Contract requires at least 100 uniquely identified scenarios")
    rows = []
    for case in cases:
        allowed = case["expected"] == "ALLOWED"
        summary = {**base_summary, **case.get("summary_patch", {})} if allowed else None
        rows.append(
            {
                "id": case["id"],
                "decision": {
                    "allowed": allowed,
                    "reason": case["expected"],
                    "summary": summary,
                },
            }
        )
    return rows


def validate_contract_reports(reports: Path, root: Path = ROOT) -> int:
    marker = run_marker(reports)
    expected = expected_rows(root)
    outputs = []
    for language in ("python", "typescript"):
        path = reports / f"{language}-contract.json"
        require_fresh(path, reports / "run-start.json")
        output = read_json(path)
        if output.get("run_id") != marker["run_id"] or output.get("mode") != marker["mode"]:
            raise ValueError(f"{language} output belongs to another run or target mode")
        rows = output.get("cases")
        if not isinstance(rows, list):
            raise ValueError(f"{language} contract output has no case list")
        ids = [row.get("id") for row in rows]
        if len(ids) != len(set(ids)):
            raise ValueError(f"{language} output contains duplicate case IDs")
        for row in rows:
            result = row.get("decision")
            if not isinstance(result, dict) or type(result.get("allowed")) is not bool:
                raise ValueError(f"{language} output has a non-Boolean authorization")
        if rows != expected:
            raise ValueError(f"{language} decisions do not match the hand-authored contract")
        outputs.append(rows)
    if outputs[0] != outputs[1]:
        raise ValueError("Python and TypeScript output parity failed")
    return len(expected)


def validate_junit(path: Path, marker: Path, minimum_tests: int) -> int:
    require_fresh(path, marker)
    root = ET.parse(path).getroot()
    cases = root.findall(".//testcase")
    if len(cases) < minimum_tests:
        raise ValueError(f"{path.name} has too few test cases: {len(cases)} < {minimum_tests}")
    for tag in ("failure", "error", "skipped"):
        if next(root.iter(tag), None) is not None:
            raise ValueError(f"{path.name} contains {tag} results")
    for suite in [root, *root.iter("testsuite")]:
        for key in ("failures", "errors", "skipped"):
            if int(suite.get(key, "0")) != 0:
                raise ValueError(f"{path.name} reports {key}")
    return len(cases)


def validate_reference_coverage(reports: Path) -> None:
    marker = reports / "run-start.json"
    python_report = reports / "python-coverage.xml"
    require_fresh(python_report, marker)
    root = ET.parse(python_report).getroot()
    if int(root.attrib["lines-valid"]) <= 0 or int(root.attrib["branches-valid"]) <= 0:
        raise ValueError("Python coverage did not measure executable lines and branches")
    if not any(
        item.get("filename", "").replace("\\", "/").endswith("discovery_contract/reference.py")
        for item in root.iter("class")
    ):
        raise ValueError("Python coverage did not measure the reference evaluator")
    for metric in ("line-rate", "branch-rate"):
        rate = float(root.attrib[metric])
        if not math.isfinite(rate) or not 0.95 <= rate <= 1:
            raise ValueError(f"Python reference {metric} is invalid or below 95%")
    typescript_report = reports / "typescript-coverage/coverage-summary.json"
    require_fresh(typescript_report, marker)
    summary = read_json(typescript_report)
    if not any(
        filename.replace("\\", "/").endswith("typescript/src/reference.ts") for filename in summary
    ):
        raise ValueError("TypeScript coverage did not measure the reference evaluator")
    total = summary["total"]
    for metric in ("lines", "branches", "functions", "statements"):
        rate = total[metric]["pct"]
        if (
            type(rate) not in {int, float}
            or not math.isfinite(rate)
            or not 95 <= rate <= 100
            or total[metric]["total"] <= 0
        ):
            raise ValueError(f"TypeScript reference {metric} is invalid or below 95%")
