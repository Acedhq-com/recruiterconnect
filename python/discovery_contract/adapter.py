"""Load the SUT without hiding configuration/import failures."""

from __future__ import annotations

import importlib
import os
from collections.abc import Callable
from typing import Any

REFERENCE = "discovery_contract.reference:evaluate"


def load_target() -> Callable[[Any], dict[str, Any]]:
    target = os.environ.get("DISCOVERY_PY_TARGET", REFERENCE)
    if os.environ.get("DISCOVERY_REQUIRE_PRODUCTION") == "1" and (
        not target or "discovery_contract.reference" in target
    ):
        raise RuntimeError("Production mode requires DISCOVERY_PY_TARGET=your.module:evaluate")
    if target.count(":") != 1:
        raise RuntimeError("DISCOVERY_PY_TARGET must be module:callable")
    module_name, name = target.split(":")
    function = getattr(importlib.import_module(module_name), name)
    if not callable(function):
        raise TypeError(f"{target} is not callable")
    if os.environ.get("DISCOVERY_REQUIRE_PRODUCTION") == "1" and (
        function.__module__ == "discovery_contract.reference"
    ):
        raise RuntimeError("Production mode cannot use the reference evaluator")
    return function
