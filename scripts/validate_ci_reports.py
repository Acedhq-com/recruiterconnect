from __future__ import annotations

import argparse
import json
import os
import sys
import uuid

from .reporting import (
    ROOT,
    run_marker,
    validate_contract_reports,
    validate_junit,
    validate_reference_coverage,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Reject incomplete or stale discovery CI evidence")
    parser.add_argument("--start", action="store_true", help="Start a new report generation run")
    args = parser.parse_args()
    reports = ROOT / "reports"
    if args.start:
        reports.mkdir(exist_ok=True)
        marker = {
            "run_id": str(uuid.uuid4()),
            "mode": "production"
            if os.environ.get("DISCOVERY_REQUIRE_PRODUCTION") == "1"
            else "reference",
        }
        (reports / "run-start.json").write_text(json.dumps(marker), encoding="utf-8")
        print(f"Started {marker['mode']} verification run")
        return
    marker = run_marker(reports)
    current_mode = (
        "production" if os.environ.get("DISCOVERY_REQUIRE_PRODUCTION") == "1" else "reference"
    )
    if current_mode != marker["mode"]:
        raise ValueError("The verification mode changed after the run started")
    count = validate_contract_reports(reports)
    counts = {
        language: validate_junit(
            reports / f"{language}-junit.xml", reports / "run-start.json", count
        )
        for language in ("python", "typescript")
    }
    if marker["mode"] == "reference":
        validate_reference_coverage(reports)
    print(
        f"CI evidence valid ({marker['mode']}): {counts['python']} Python tests, "
        f"{counts['typescript']} TypeScript tests, {count} matching contract decisions; "
        "no failures, errors, skips, missing reports, or stale outputs."
    )


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        print(f"CI validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
