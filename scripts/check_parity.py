from __future__ import annotations

import sys

from .reporting import ROOT, validate_contract_reports


def main() -> None:
    count = validate_contract_reports(ROOT / "reports")
    print(f"Exact Python/TypeScript parity and expected decisions verified for {count} scenarios.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        print(f"Contract parity failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
