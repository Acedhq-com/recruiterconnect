from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

from .reporting import ROOT


def main() -> None:
    npm = shutil.which("npm")
    if npm is None:
        raise SystemExit("npm is required; install Node.js and run npm ci first")
    environment = dict(os.environ)
    environment["PATH"] = (
        str(Path(sys.executable).parent) + os.pathsep + environment.get("PATH", "")
    )
    python = sys.executable
    pytest_options = (
        ["--no-cov", "--cov-fail-under=0"]
        if environment.get("DISCOVERY_REQUIRE_PRODUCTION") == "1"
        else []
    )
    commands = [
        [python, "-m", "scripts.validate_ci_reports", "--start"],
        [python, "-m", "ruff", "check", "python", "scripts"],
        [python, "-m", "ruff", "format", "--check", "python", "scripts"],
        [python, "-m", "pytest", *pytest_options],
        [npm, "run", "typecheck"],
        [npm, "run", "build"],
        [npm, "test"],
        [npm, "run", "export:contract"],
        [python, "-m", "scripts.check_parity"],
        [python, "-m", "scripts.validate_ci_reports"],
    ]
    for command in commands:
        print(f"\n> {' '.join(command)}", flush=True)
        subprocess.run(command, cwd=ROOT, env=environment, check=True)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.returncode) from error
