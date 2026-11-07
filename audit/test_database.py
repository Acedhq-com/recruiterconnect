"""Run only against the disposable, bootstrapped local PostgreSQL audit DB.

Uses locked test dependencies and synthetic claims, never hosted credentials.
The original authority and schema regressions must be green after hardening.
"""

from __future__ import annotations

import json
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path

import psycopg
import pytest

from scripts.database_fixture import connect_audit_database

SNAPSHOT = {
    "id": "audit-job",
    "role": "Synthetic role",
    "company": "Audit employer",
    "location": "Remote",
    "url": "https://jobs.example.com/audit",
    "source": "ashby",
    "checkedAt": "2026-11-07T00:00:00.000Z",
}
BACKGROUND = {
    "name": "Synthetic owner",
    "email": "",
    "location": "",
    "headline": "Audit",
    "summary": "",
    "experience": [],
    "skills": [],
    "education": [],
}


def connect(name="audit-test"):
    return connect_audit_database(name)


@contextmanager
def actor_transaction(conn, actor):
    user_id, session_id = actor
    with conn.transaction():
        conn.execute("set local role authenticated")
        conn.execute(
            "select set_config('request.jwt.claims', %s, true)",
            (json.dumps({"sub": user_id, "role": "authenticated", "session_id": session_id}),),
        )
        yield conn


@pytest.fixture
def actor():
    user_id, session_id = str(uuid.uuid4()), str(uuid.uuid4())
    with connect() as conn:
        conn.execute(
            """insert into auth.users
               (id, email, email_confirmed_at, is_anonymous, created_at, updated_at)
               values (%s, 'audit@example.com', now(), false, now(), now())""",
            (user_id,),
        )
        conn.execute(
            """insert into auth.sessions(id, user_id, created_at, updated_at)
               values (%s, %s, now(), now())""",
            (session_id, user_id),
        )
        with actor_transaction(conn, (user_id, session_id)):
            conn.execute("select public.onboard_my_account('candidate', 'Synthetic owner', true)")
    yield user_id, session_id
    with connect() as conn:
        conn.execute("delete from auth.users where id = %s", (user_id,))


def save_background(actor, name="audit-save-background"):
    with connect(name) as conn, actor_transaction(conn, actor):
        conn.execute("set local statement_timeout = '5s'")
        conn.execute(
            "select public.save_my_career_background(%s::jsonb, 0)",
            (json.dumps(BACKGROUND),),
        )


DOCUMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


def mutate_in_transaction(conn, operation):
    if operation == "background":
        conn.execute(
            "select public.save_my_career_background(%s::jsonb, 0)",
            (json.dumps(BACKGROUND),),
        )
    elif operation == "workflow":
        conn.execute(
            """select public.save_my_career_workflow(
               %s::jsonb, 'Saved', '', '', null, null, 0)""",
            (json.dumps(SNAPSHOT),),
        )
    elif operation == "document":
        conn.execute(
            """select public.save_my_career_document(
               %s,'resume','Synthetic draft','Synthetic facts','','',null,0)""",
            (DOCUMENT_ID,),
        )
    elif operation == "remove_document":
        conn.execute("select public.remove_my_career_document(%s,1)", (DOCUMENT_ID,))
    elif operation == "profile":
        conn.execute(
            """select public.save_my_private_profile(
               'Synthetic owner','Synthetic headline',array['Accounting'],'Remote',1)"""
        )
    elif operation == "onboard":
        conn.execute("select public.onboard_my_account('candidate','Synthetic owner',true)")
    else:
        raise AssertionError("Unknown test operation")


def mutate(actor, operation, name="audit-mutation"):
    with connect(name) as conn, actor_transaction(conn, actor):
        conn.execute("set local statement_timeout = '5s'")
        mutate_in_transaction(conn, operation)


def change_authority(conn, actor, authority):
    user_id, session_id = actor
    if authority == "deletion":
        with actor_transaction(conn, actor):
            conn.execute("select public.request_my_account_deletion()")
    elif authority == "suspension":
        conn.execute(
            "update public.member_accounts set status='suspended' where user_id=%s",
            (user_id,),
        )
    elif authority == "session_revocation":
        conn.execute("delete from auth.sessions where id=%s", (session_id,))
    elif authority == "session_expiry":
        # The worker transaction began earlier; transaction now() is stale here.
        conn.execute(
            "update auth.sessions set not_after=clock_timestamp() where id=%s",
            (session_id,),
        )
    elif authority == "ban":
        conn.execute(
            "update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=%s",
            (user_id,),
        )
    else:
        raise AssertionError("Unknown test authority")


def revoke_worker(actor, authority, name):
    with connect(name) as conn:
        conn.execute("set statement_timeout='5s'")
        change_authority(conn, actor, authority)


def wait_for_lock(observer, name):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        row = observer.execute(
            "select wait_event_type from pg_stat_activity where application_name=%s", (name,)
        ).fetchone()
        if row and row[0] == "Lock":
            return
        time.sleep(0.01)
    pytest.fail("Worker did not reach the expected real PostgreSQL lock")


def test_positive_database_save_and_owner_only_read(actor):
    save_background(actor)
    with connect() as conn, actor_transaction(conn, actor):
        assert conn.execute("select count(*) from public.career_backgrounds").fetchone()[0] == 1
        conn.execute(
            "select set_config('request.jwt.claims', %s, true)",
            ('{"role":"authenticated"}',),
        )
        assert conn.execute("select count(*) from public.career_backgrounds").fetchone()[0] == 0


@pytest.mark.parametrize(
    "authority", ["deletion", "suspension", "session_revocation", "session_expiry", "ban"]
)
@pytest.mark.parametrize("operation", ["background", "workflow", "document", "remove_document"])
def test_rc01_waiting_write_rechecks_authority_after_lock(actor, authority, operation):
    # Hold the SAME advisory lock used by the production SQL RPC. The second
    # connection passes career_actor(), then blocks at pg_advisory_xact_lock.
    user_id, _ = actor
    if operation == "remove_document":
        mutate(actor, "document")
    name = f"audit-wait-{uuid.uuid4().hex}"
    with connect("audit-lock-holder") as holder, connect("audit-observer") as observer:
        holder.execute("begin")
        holder.execute(
            "select pg_advisory_xact_lock(hashtextextended(%s, 0))",
            (f"{user_id}:career",),
        )
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(mutate, actor, operation, name)
            try:
                wait_for_lock(observer, name)
                change_authority(observer, actor, authority)
            finally:
                holder.execute("rollback")
            try:
                future.result(timeout=6)
            except psycopg.errors.InsufficientPrivilege:
                return  # Correct post-remediation outcome.
            pytest.fail(f"RC-01: a waiting {operation} committed after {authority}")


@pytest.mark.parametrize("authority", ["deletion", "suspension", "session_revocation"])
@pytest.mark.parametrize(
    "operation", ["background", "workflow", "document", "remove_document", "profile", "onboard"]
)
def test_rc01_already_authorized_write_serializes_authority_change(actor, authority, operation):
    if operation == "remove_document":
        mutate(actor, "document")
    name = f"audit-revoke-{uuid.uuid4().hex}"
    with ThreadPoolExecutor(max_workers=1) as pool:
        with connect("audit-authorized-writer") as writer, connect("audit-observer") as observer:
            with actor_transaction(writer, actor):
                mutate_in_transaction(writer, operation)
                future = pool.submit(revoke_worker, actor, authority, name)
                wait_for_lock(observer, name)
                assert not future.done()
            # Releasing the writer transaction permits revocation to commit.
            future.result(timeout=6)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        mutate(actor, operation)


@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1/audit",
        "https://jobs.internal/audit",
        "https://jobs.example.com:444/audit",
        "https://user:password@jobs.example.com/audit",
    ],
)
def test_rc03_direct_rpc_uses_same_snapshot_url_policy_as_api(actor, url):
    snapshot = {**SNAPSHOT, "url": url}
    with connect() as conn:
        try:
            with actor_transaction(conn, actor):
                conn.execute(
                    """select public.save_my_career_workflow(
                       %s::jsonb, 'Saved', '', '', null, null, 0)""",
                    (json.dumps(snapshot),),
                )
        except (psycopg.errors.CheckViolation, psycopg.errors.InvalidParameterValue):
            return
    pytest.fail(f"RC-03: direct SQL RPC accepted an API-rejected URL: {url}")


def test_rc03_direct_rpc_rejects_whitespace_only_background_lines(actor):
    background = {**BACKGROUND, "experience": ["   "]}
    with connect() as conn:
        try:
            with actor_transaction(conn, actor):
                conn.execute(
                    "select public.save_my_career_background(%s::jsonb, 0)",
                    (json.dumps(background),),
                )
        except (psycopg.errors.CheckViolation, psycopg.errors.InvalidParameterValue):
            return
    pytest.fail("RC-03: direct SQL RPC accepted an API-rejected empty experience line")


def test_positive_optimistic_version_rejects_stale_update(actor):
    save_background(actor)
    with pytest.raises(psycopg.errors.SerializationFailure):
        save_background(actor)


def test_positive_anon_cannot_read_or_write_private_background():
    with connect() as conn:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with conn.transaction():
                conn.execute("set local role anon")
                conn.execute("select * from public.career_backgrounds")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with conn.transaction():
                conn.execute("set local role anon")
                conn.execute(
                    "select public.save_my_career_background(%s::jsonb, 0)",
                    (json.dumps(BACKGROUND),),
                )


def test_positive_pilot_consent_and_plan_are_enforced_for_direct_rpc():
    with connect() as conn, conn.transaction(force_rollback=True):
        conn.execute("set local role anon")
        for consent, plan in [(False, "candidate"), (True, "founding")]:
            with pytest.raises(psycopg.errors.InvalidParameterValue):
                with conn.transaction():
                    conn.execute(
                        """select public.register_pilot_interest(
                        'synthetic@example.com','Audit owner','Synthetic audit',
                        'candidate',%s,%s)""",
                        (plan, consent),
                    )


def test_positive_pilot_duplicate_is_accepted_at_exact_hourly_cap():
    with connect() as conn, conn.transaction(force_rollback=True):
        assert conn.execute("select count(*) from public.pilot_leads").fetchone()[0] == 0
        conn.execute("set local role anon")
        conn.execute(
            """select public.register_pilot_interest(
               'audit-' || n || '@example.com', 'Synthetic audit', 'Synthetic audit',
               'candidate','candidate',true) from generate_series(1,100) n"""
        )
        assert (
            conn.execute(
                """select public.register_pilot_interest(
               ' AUDIT-1@EXAMPLE.COM ', 'Synthetic audit', 'Synthetic audit',
               'candidate','candidate',true)"""
            ).fetchone()[0]
            is True
        )
        with pytest.raises(psycopg.errors.ProgramLimitExceeded):
            with conn.transaction():
                conn.execute(
                    """select public.register_pilot_interest(
                    'audit-101@example.com','Synthetic audit','Synthetic audit',
                    'candidate','candidate',true)"""
                )


def test_positive_pilot_total_cap_is_enforced_below_hourly_cap():
    with connect() as conn, conn.transaction(force_rollback=True):
        assert conn.execute("select count(*) from public.pilot_leads").fetchone()[0] == 0
        conn.execute(
            """insert into public.pilot_leads(
               email,name,organization,audience,plan,created_at)
               select 'audit-' || n || '@example.com','Synthetic audit',
                 'Synthetic audit','candidate','candidate',now()-interval '2 hours'
               from generate_series(1,1500) n"""
        )
        conn.execute("set local role anon")
        with pytest.raises(psycopg.errors.ProgramLimitExceeded):
            with conn.transaction():
                conn.execute(
                    """select public.register_pilot_interest(
                    'audit-1501@example.com','Synthetic audit','Synthetic audit',
                    'candidate','candidate',true)"""
                )


def test_positive_pilot_anon_has_no_direct_table_access():
    with connect() as conn:
        for statement in [
            "select * from public.pilot_leads",
            """insert into public.pilot_leads(email,name,organization,audience,plan)
               values ('audit@example.com','Audit owner','Synthetic audit',
               'candidate','candidate')""",
        ]:
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                with conn.transaction():
                    conn.execute("set local role anon")
                    conn.execute(statement)


CORPUS = json.loads(
    (Path(__file__).resolve().parents[1] / "shared/career-validation-cases.json").read_text(
        encoding="utf-8"
    )
)
SCHEMA_CASES = [(kind, case) for kind in ("background", "snapshot") for case in CORPUS[kind]]


def expand(value):
    if isinstance(value, list):
        return [expand(child) for child in value]
    if isinstance(value, dict):
        if set(value) == {"repeat", "times"}:
            assert isinstance(value["repeat"], str)
            assert type(value["times"]) is int and 0 <= value["times"] <= 50001
            return value["repeat"] * value["times"]
        return {key: expand(child) for key, child in value.items()}
    return value


@pytest.mark.parametrize(
    ("kind", "case"),
    SCHEMA_CASES,
    ids=[f"{kind}-{case['id']}" for kind, case in SCHEMA_CASES],
)
def test_rc03_shared_api_storage_admission_contract(actor, kind, case):
    assert CORPUS["version"] == 1
    base = BACKGROUND if kind == "background" else SNAPSHOT
    value = {**base, **expand(case["patch"])}
    with connect() as conn:
        if kind == "background":
            statement = "select public.save_my_career_background(%s::jsonb, 0)"
        else:
            statement = """select public.save_my_career_workflow(
                %s::jsonb,'Saved','','',null,null,0)"""
        if case["valid"]:
            with actor_transaction(conn, actor):
                conn.execute(statement, (json.dumps(value),))
        else:
            with pytest.raises((psycopg.DataError, psycopg.errors.CheckViolation)):
                with actor_transaction(conn, actor):
                    conn.execute(statement, (json.dumps(value),))


@pytest.mark.parametrize(
    "signature",
    [
        "fwp_private.verified_user_id()",
        "fwp_private.career_actor()",
        "fwp_private.career_trim(text)",
        "fwp_private.career_text(text,integer,boolean)",
        "fwp_private.career_public_posting_url(text)",
        "fwp_private.career_utc_timestamp(text)",
        "fwp_private.valid_career_background(jsonb)",
        "fwp_private.valid_career_snapshot(jsonb)",
    ],
)
def test_private_validation_and_authority_helpers_are_not_directly_callable(signature):
    with connect() as conn:
        for role in ("anon", "authenticated"):
            assert (
                conn.execute(
                    "select has_function_privilege(%s,%s,'EXECUTE')", (role, signature)
                ).fetchone()[0]
                is False
            )
