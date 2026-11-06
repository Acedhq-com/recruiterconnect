from __future__ import annotations

import pytest
from hypothesis import settings

from discovery_contract.adapter import load_target

settings.register_profile(
    "discovery-ci", max_examples=150, derandomize=True, database=None, deadline=None
)
settings.load_profile("discovery-ci")


@pytest.fixture(scope="session")
def sut():
    return load_target()
