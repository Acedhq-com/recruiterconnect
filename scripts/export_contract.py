from __future__ import annotations

import json
import os
import sys

from .reporting import ROOT, run_marker


def main() -> None:
    sys.path.insert(0, str(ROOT / "python"))
    from discovery_contract.adapter import load_target
    from discovery_contract.fixtures import CASES, materialize

    marker = run_marker(ROOT / "reports")
    mode = "production" if os.environ.get("DISCOVERY_REQUIRE_PRODUCTION") == "1" else "reference"
    if marker["mode"] != mode:
        raise ValueError("Exporter target mode differs from the current verification run")
    evaluate = load_target()
    output = {
        "run_id": marker["run_id"],
        "mode": mode,
        "cases": [{"id": case["id"], "decision": evaluate(materialize(case))} for case in CASES],
    }
    (ROOT / "reports/python-contract.json").write_text(
        json.dumps(output, indent=2, sort_keys=True, allow_nan=False), encoding="utf-8"
    )
    print(f"Exported {len(CASES)} Python contract decisions ({mode})")


if __name__ == "__main__":
    main()
