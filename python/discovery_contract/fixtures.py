"""Shared test inputs; merge is not JSON Merge Patch: null is retained literally."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
BASE = json.loads((ROOT / "shared/base.json").read_text())
CASES = json.loads((ROOT / "shared/cases.json").read_text())
PRESETS = json.loads((ROOT / "shared/presets.json").read_text())
EXPECTED_SUMMARY = copy.deepcopy(BASE["candidate"]["summary"])


def merge(base: Any, patch: Any) -> Any:
    if isinstance(base, dict) and isinstance(patch, dict):
        result = copy.deepcopy(base)
        for key, value in patch.items():
            result[key] = merge(result.get(key), value)
        return result
    return copy.deepcopy(patch)


def context(patch: dict[str, Any] | None = None) -> dict[str, Any]:
    return merge(BASE, patch or {})


def materialize(case: dict[str, Any]) -> Any:
    data = merge(context(PRESETS.get(case.get("preset"), {})), case.get("patch", {}))
    for pointer, value in case.get("set", {}).items():
        tokens = pointer.split("/")[1:]
        parent = data
        for token in tokens[:-1]:
            parent = parent[int(token)] if isinstance(parent, list) else parent[token]
        if isinstance(parent, list):
            parent[int(tokens[-1])] = copy.deepcopy(value)
        else:
            parent[tokens[-1]] = copy.deepcopy(value)
    for pointer in case.get("remove", []):
        tokens = [token.replace("~1", "/").replace("~0", "~") for token in pointer.split("/")[1:]]
        parent = data
        for token in tokens[:-1]:
            parent = parent[int(token)] if isinstance(parent, list) else parent[token]
        if isinstance(parent, list):
            del parent[int(tokens[-1])]
        else:
            del parent[tokens[-1]]
    return case["raw"] if "raw" in case else data
