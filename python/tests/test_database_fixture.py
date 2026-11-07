"""The local SQL runner must refuse unsafe destinations before any connection."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from scripts.database_fixture import connect_audit_database


@pytest.fixture(autouse=True)
def clear_database_environment(monkeypatch):
    for name in ("AUDIT_DATABASE_URL", "PGHOST", "PGHOSTADDR", "PGSERVICE", "PGDATABASE"):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.parametrize(
    "dsn",
    [
        "dbname=production host=127.0.0.1",
        "dbname=test_audit host=db.example.com",
        "dbname=test_audit host=localhost hostaddr=192.0.2.1",
        "dbname=test_audit host=localhost,db.example.com",
        "dbname=test_audit service=remote",
        "postgresql://db.example.com/test_audit",
    ],
)
def test_database_guard_refuses_unsafe_dsn_before_connect(monkeypatch, dsn):
    connect = Mock()
    monkeypatch.setenv("AUDIT_DATABASE_URL", dsn)
    monkeypatch.setattr("scripts.database_fixture.psycopg.connect", connect)
    with pytest.raises(RuntimeError, match="Refusing"):
        connect_audit_database()
    connect.assert_not_called()


@pytest.mark.parametrize(
    ("name", "value"),
    [("PGHOST", "db.example.com"), ("PGHOSTADDR", "192.0.2.1"), ("PGSERVICE", "remote")],
)
def test_database_guard_refuses_unsafe_environment(monkeypatch, name, value):
    connect = Mock()
    monkeypatch.setenv(name, value)
    monkeypatch.setattr("scripts.database_fixture.psycopg.connect", connect)
    with pytest.raises(RuntimeError, match="Refusing"):
        connect_audit_database()
    connect.assert_not_called()


@pytest.mark.parametrize("host", ["/var/run/postgresql", "localhost", "127.0.0.1", "::1"])
def test_database_guard_accepts_only_explicit_local_audit_database(monkeypatch, host):
    connection = Mock(info=SimpleNamespace(dbname="test_audit", host=host))
    connect = Mock(return_value=connection)
    monkeypatch.setenv("AUDIT_DATABASE_URL", f"dbname=test_audit host={host}")
    monkeypatch.setattr("scripts.database_fixture.psycopg.connect", connect)
    assert connect_audit_database("synthetic-test") is connection
    connect.assert_called_once_with(
        f"dbname=test_audit host={host}", autocommit=True, application_name="synthetic-test"
    )


def test_database_guard_rechecks_actual_connection_destination(monkeypatch):
    connection = Mock(info=SimpleNamespace(dbname="production", host="db.example.com"))
    monkeypatch.setattr("scripts.database_fixture.psycopg.connect", Mock(return_value=connection))
    with pytest.raises(RuntimeError, match="Refusing"):
        connect_audit_database()
    connection.close.assert_called_once()
