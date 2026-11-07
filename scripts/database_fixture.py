"""Safety boundary for disposable local PostgreSQL verification only."""

from __future__ import annotations

import os

import psycopg
from psycopg.conninfo import conninfo_to_dict


def connect_audit_database(name: str = "audit-test"):
    dsn = os.environ.get("AUDIT_DATABASE_URL", "dbname=recruiterconnect_audit")
    options = conninfo_to_dict(dsn)
    host = options.get("host", os.environ.get("PGHOST", "/var/run/postgresql"))
    database = options.get("dbname", os.environ.get("PGDATABASE", ""))
    address = options.get("hostaddr", os.environ.get("PGHOSTADDR", ""))
    # Validate before opening a socket, not only after connecting. A service or
    # hostaddr override must not turn an innocent-looking host into a remote DB.
    if (
        not database.endswith("_audit")
        or host not in ("/var/run/postgresql", "localhost", "127.0.0.1", "::1")
        or address not in ("", "127.0.0.1", "::1")
        or options.get("service")
        or os.environ.get("PGSERVICE")
    ):
        raise RuntimeError("Refusing a nonlocal or non-audit database")
    conn = psycopg.connect(
        dsn,
        autocommit=True,
        application_name=name,
    )
    info = conn.info
    if not info.dbname.endswith("_audit") or info.host not in (
        "/var/run/postgresql",
        "localhost",
        "127.0.0.1",
        "::1",
    ):
        conn.close()
        raise RuntimeError("Refusing a nonlocal or non-audit database")
    return conn
