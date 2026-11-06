from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from scripts.reporting import (
    ROOT,
    expected_rows,
    require_fresh,
    run_marker,
    validate_contract_reports,
    validate_junit,
    validate_reference_coverage,
)


def marker_at(directory: Path) -> Path:
    marker = directory / "run-start.json"
    marker.write_text(json.dumps({"run_id": "unit-test-run", "mode": "reference"}))
    return marker


def exports_at(directory: Path) -> None:
    marker_at(directory)
    for language in ("python", "typescript"):
        (directory / f"{language}-contract.json").write_text(
            json.dumps(
                {
                    "run_id": "unit-test-run",
                    "mode": "reference",
                    "cases": expected_rows(),
                }
            )
        )


def test_valid_exports_are_accepted(tmp_path):
    exports_at(tmp_path)
    assert validate_contract_reports(tmp_path) == len(expected_rows())


def test_missing_start_marker_fails(tmp_path):
    with pytest.raises(ValueError, match="Start this run"):
        run_marker(tmp_path)


@pytest.mark.parametrize("data", [None, {}, {"run_id": "", "mode": "reference"}])
def test_malformed_start_marker_fails(tmp_path, data):
    (tmp_path / "run-start.json").write_text(json.dumps(data))
    with pytest.raises(ValueError, match="Invalid run marker"):
        run_marker(tmp_path)


@pytest.mark.parametrize("language", ["python", "typescript"])
def test_export_from_another_run_fails(tmp_path, language):
    exports_at(tmp_path)
    path = tmp_path / f"{language}-contract.json"
    value = json.loads(path.read_text())
    value["run_id"] = "old-run"
    path.write_text(json.dumps(value))
    with pytest.raises(ValueError, match="another run"):
        validate_contract_reports(tmp_path)


@pytest.mark.parametrize(
    "mutation", ["wrong-decision", "missing-case", "duplicate-case", "truthy-boolean"]
)
def test_export_tampering_fails(tmp_path, mutation):
    exports_at(tmp_path)
    path = tmp_path / "typescript-contract.json"
    value = json.loads(path.read_text())
    if mutation == "wrong-decision":
        value["cases"][0]["decision"]["summary"] = None
    elif mutation == "missing-case":
        value["cases"].pop()
    elif mutation == "duplicate-case":
        value["cases"].append(value["cases"][0])
    else:
        value["cases"][0]["decision"]["allowed"] = 1
    path.write_text(json.dumps(value))
    with pytest.raises(ValueError):
        validate_contract_reports(tmp_path)


def test_missing_report_fails(tmp_path):
    marker = marker_at(tmp_path)
    with pytest.raises(ValueError, match="Missing or empty"):
        require_fresh(tmp_path / "missing.xml", marker)


def test_empty_report_fails(tmp_path):
    marker = marker_at(tmp_path)
    report = tmp_path / "empty.xml"
    report.touch()
    with pytest.raises(ValueError, match="Missing or empty"):
        require_fresh(report, marker)


def test_stale_report_fails(tmp_path):
    marker = marker_at(tmp_path)
    report = tmp_path / "stale.xml"
    report.write_text("<testsuites/>")
    old = marker.stat().st_mtime_ns - 2_000_000_000
    os.utime(report, ns=(old, old))
    with pytest.raises(ValueError, match="Stale"):
        require_fresh(report, marker)


@pytest.mark.parametrize("bad_tag", ["failure", "error", "skipped"])
def test_failed_errored_or_skipped_junit_fails(tmp_path, bad_tag):
    marker = marker_at(tmp_path)
    report = tmp_path / "junit.xml"
    report.write_text(
        f'<testsuites><testsuite><testcase name="x"><{bad_tag}/></testcase></testsuite></testsuites>'
    )
    with pytest.raises(ValueError, match=bad_tag):
        validate_junit(report, marker, 1)


def test_empty_or_incomplete_test_run_fails(tmp_path):
    marker = marker_at(tmp_path)
    report = tmp_path / "junit.xml"
    report.write_text("<testsuites><testsuite/></testsuites>")
    with pytest.raises(ValueError, match="too few"):
        validate_junit(report, marker, 1)


def test_successful_junit_is_accepted(tmp_path):
    marker = marker_at(tmp_path)
    report = tmp_path / "junit.xml"
    report.write_text(
        '<testsuites><testsuite failures="0"><testcase name="x"/></testsuite></testsuites>'
    )
    assert validate_junit(report, marker, 1) == 1


def test_shared_contract_count_is_not_a_literal_copy():
    assert len(expected_rows(ROOT)) >= 100


def coverage_at(directory: Path) -> None:
    marker_at(directory)
    (directory / "python-coverage.xml").write_text(
        '<coverage line-rate="1" branch-rate="1" lines-valid="50" branches-valid="20">'
        '<packages><package><classes><class filename="python/discovery_contract/reference.py"/>'
        "</classes></package></packages></coverage>"
    )
    folder = directory / "typescript-coverage"
    folder.mkdir()
    total = {
        metric: {"total": 20, "covered": 20, "pct": 100}
        for metric in ("lines", "branches", "functions", "statements")
    }
    (folder / "coverage-summary.json").write_text(
        json.dumps(
            {
                "total": total,
                "/checkout/typescript/src/reference.ts": total,
            }
        )
    )


def test_valid_reference_coverage_is_accepted(tmp_path):
    coverage_at(tmp_path)
    validate_reference_coverage(tmp_path)


@pytest.mark.parametrize("rate", ["0.94", "nan", "inf", "-1", "1.01"])
def test_invalid_or_low_python_coverage_fails(tmp_path, rate):
    coverage_at(tmp_path)
    path = tmp_path / "python-coverage.xml"
    path.write_text(path.read_text().replace('line-rate="1"', f'line-rate="{rate}"'))
    with pytest.raises(ValueError, match="invalid or below"):
        validate_reference_coverage(tmp_path)


@pytest.mark.parametrize("rate", [94, None, "100", True, -1, 101])
def test_invalid_or_low_typescript_coverage_fails(tmp_path, rate):
    coverage_at(tmp_path)
    path = tmp_path / "typescript-coverage/coverage-summary.json"
    data = json.loads(path.read_text())
    data["total"]["branches"]["pct"] = rate
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="invalid or below"):
        validate_reference_coverage(tmp_path)


@pytest.mark.parametrize("language", ["python", "typescript"])
def test_coverage_of_the_wrong_source_is_rejected(tmp_path, language):
    coverage_at(tmp_path)
    path = tmp_path / (
        "python-coverage.xml"
        if language == "python"
        else "typescript-coverage/coverage-summary.json"
    )
    path.write_text(
        path.read_text().replace("reference.py", "fake.py").replace("reference.ts", "fake.ts")
    )
    with pytest.raises(ValueError, match="did not measure the reference"):
        validate_reference_coverage(tmp_path)


@pytest.mark.parametrize("language", ["python", "typescript"])
def test_zero_measured_lines_or_branches_is_not_full_coverage(tmp_path, language):
    coverage_at(tmp_path)
    if language == "python":
        path = tmp_path / "python-coverage.xml"
        path.write_text(path.read_text().replace('lines-valid="50"', 'lines-valid="0"'))
    else:
        path = tmp_path / "typescript-coverage/coverage-summary.json"
        data = json.loads(path.read_text())
        data["total"]["branches"]["total"] = 0
        path.write_text(json.dumps(data))
    with pytest.raises(ValueError):
        validate_reference_coverage(tmp_path)
