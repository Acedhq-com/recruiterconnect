"""Create synthetic auth/schema in a fresh local DB, then enforce SQL regressions.

Never resets an existing schema and never connects to hosted infrastructure.
Create a disposable *_audit database and set AUDIT_DATABASE_URL first.
"""

from __future__ import annotations

import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from .database_fixture import connect_audit_database

ROOT = Path(__file__).resolve().parents[1]


def execute_file(conn, path: Path) -> None:
    print(f"Applying {path.relative_to(ROOT)}", flush=True)
    cursor = conn.execute(path.read_text(encoding="utf-8"), prepare=False)
    while cursor.nextset():
        pass
    if conn.info.transaction_status.name != "IDLE":
        raise RuntimeError(f"{path.name} left an open transaction")


def main() -> None:
    with connect_audit_database("audit-schema-runner") as conn:
        existing = conn.execute(
            """select exists (
                 select 1 from pg_namespace
                 where nspname not in ('public','pg_catalog','information_schema')
                   and nspname not like 'pg_%'
               ) or exists (
                 select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                 where n.nspname='public'
               ) or exists (
                 select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public'
               )"""
        ).fetchone()[0]
        if existing:
            raise RuntimeError("Requires an empty disposable database; no existing schema is reset")
        execute_file(conn, ROOT / "audit/bootstrap-auth.sql")
        for path in sorted((ROOT / "supabase/migrations").glob("*.sql")):
            execute_file(conn, path)
        for path in sorted((ROOT / "supabase/tests").glob("*.sql")):
            execute_file(conn, path)

    report = ROOT / "reports/database-junit.xml"
    report.parent.mkdir(exist_ok=True)
    report.unlink(missing_ok=True)
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "audit/test_database.py",
            "--no-cov",
            "-o",
            "addopts=",
            f"--junitxml={report}",
            "-q",
        ],
        cwd=ROOT,
        check=True,
    )
    root = ET.parse(report).getroot()
    suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
    count = sum(int(suite.attrib.get("tests", 0)) for suite in suites)
    bad = sum(
        int(suite.attrib.get(key, 0))
        for suite in suites
        for key in ("failures", "errors", "skipped")
    )
    if not count or bad:
        raise RuntimeError("Database report must have tests and no failures, errors or skips")
    with connect_audit_database("audit-cleanup-check") as conn:
        counts = conn.execute(
            """select (select count(*) from auth.users),
                      (select count(*) from auth.sessions),
                      (select count(*) from public.member_accounts),
                      (select count(*) from public.account_profiles),
                      (select count(*) from public.pilot_leads),
                      (select count(*) from public.career_backgrounds),
                      (select count(*) from public.career_workflows),
                      (select count(*) from public.career_documents)"""
        ).fetchone()
        if any(counts):
            raise RuntimeError("Database tests leaked synthetic rows")
    print(f"Database evidence valid: {count} tests, no skips, synthetic rows cleaned up")


if __name__ == "__main__":
    main()
