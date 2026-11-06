from __future__ import annotations

import pytest

from discovery_contract.adapter import load_target


def test_default_adapter_is_callable(monkeypatch):
    monkeypatch.delenv("DISCOVERY_PY_TARGET", raising=False)
    monkeypatch.delenv("DISCOVERY_REQUIRE_PRODUCTION", raising=False)
    assert callable(load_target())


@pytest.mark.parametrize("target", ["", "discovery_contract.reference:evaluate"])
def test_enforced_production_rejects_reference_or_missing_target(monkeypatch, target):
    monkeypatch.setenv("DISCOVERY_REQUIRE_PRODUCTION", "1")
    monkeypatch.setenv("DISCOVERY_PY_TARGET", target)
    with pytest.raises(RuntimeError, match="Production mode requires"):
        load_target()


def test_missing_adapter_module_is_an_error_not_a_skip(monkeypatch):
    monkeypatch.setenv("DISCOVERY_PY_TARGET", "no_such_recruiterconnect_module:evaluate")
    with pytest.raises(ModuleNotFoundError):
        load_target()


def test_missing_callable_is_an_error(monkeypatch):
    monkeypatch.delenv("DISCOVERY_REQUIRE_PRODUCTION", raising=False)
    monkeypatch.setenv("DISCOVERY_PY_TARGET", "discovery_contract.reference:does_not_exist")
    with pytest.raises(AttributeError):
        load_target()


def test_non_callable_export_is_an_error(monkeypatch):
    monkeypatch.delenv("DISCOVERY_REQUIRE_PRODUCTION", raising=False)
    monkeypatch.setenv("DISCOVERY_PY_TARGET", "discovery_contract.reference:SUMMARY_FIELDS")
    with pytest.raises(TypeError, match="not callable"):
        load_target()


@pytest.mark.parametrize("target", ["missing-colon", "one:two:three"])
def test_invalid_adapter_specification_is_an_error(monkeypatch, target):
    monkeypatch.delenv("DISCOVERY_REQUIRE_PRODUCTION", raising=False)
    monkeypatch.setenv("DISCOVERY_PY_TARGET", target)
    with pytest.raises(RuntimeError, match="module:callable"):
        load_target()
