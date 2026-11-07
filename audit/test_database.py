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
    elif operation == "employer":
        conn.execute("select public.save_my_current_employer('Synthetic Employer LLP')")
    elif operation == "block":
        conn.execute("select public.add_my_block('Synthetic Blocked Firm')")
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
    "operation",
    [
        "background",
        "workflow",
        "document",
        "remove_document",
        "profile",
        "onboard",
        "employer",
        "block",
    ],
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


def test_positive_pilot_research_request_is_a_candidate_plan_kept_apart_from_signup():
    with connect() as conn, conn.transaction(force_rollback=True):
        assert conn.execute("select count(*) from public.pilot_leads").fetchone()[0] == 0
        conn.execute("set local role anon")
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            with conn.transaction():
                conn.execute(
                    """select public.register_pilot_interest(
                    'synthetic@example.com','Audit owner','Synthetic audit',
                    'recruiter','research',true)"""
                )
        for plan in ("candidate", "research", "research"):
            assert (
                conn.execute(
                    """select public.register_pilot_interest(
                    'synthetic@example.com','Audit owner','Synthetic audit',
                    'candidate',%s,true)""",
                    (plan,),
                ).fetchone()[0]
                is True
            )
        conn.execute("reset role")
        rows = conn.execute(
            "select plan from public.pilot_leads where email = 'synthetic@example.com' order by plan"
        ).fetchall()
        assert [row[0] for row in rows] == ["candidate", "research"]


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
        "fwp_private.privacy_actor()",
        "fwp_private.normalize_company(text)",
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


# --- Phase 1: candidate privacy controls (current employer and block list) ---


def make_actor(kind="candidate"):
    user_id, session_id = str(uuid.uuid4()), str(uuid.uuid4())
    with connect() as conn:
        conn.execute(
            """insert into auth.users
               (id, email, email_confirmed_at, is_anonymous, created_at, updated_at)
               values (%s, %s, now(), false, now(), now())""",
            (user_id, f"{user_id}@example.com"),
        )
        conn.execute(
            """insert into auth.sessions(id, user_id, created_at, updated_at)
               values (%s, %s, now(), now())""",
            (session_id, user_id),
        )
        with actor_transaction(conn, (user_id, session_id)):
            conn.execute("select public.onboard_my_account(%s, 'Synthetic person', true)", (kind,))
    return user_id, session_id


@pytest.fixture
def other_actor():
    person = make_actor()
    yield person
    with connect() as conn:
        conn.execute("delete from auth.users where id = %s", (person[0],))


@pytest.fixture
def recruiter_actor():
    person = make_actor("recruiter")
    yield person
    with connect() as conn:
        conn.execute("delete from auth.users where id = %s", (person[0],))


def run_as(person, sql, params=()):
    with connect() as conn, actor_transaction(conn, person):
        return conn.execute(sql, params).fetchall()


def my_blocks(person):
    return run_as(
        person,
        "select company_name, source from public.candidate_blocks order by company_name",
    )


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("Acme, Inc.", "acme"),
        ("ACME LLC", "acme"),
        ("The Acme Company", "acme"),
        ("Smith & Jones LLP", "smith and jones"),
        ("  Big   Four  Co.  ", "big four"),
        ("KPMG LLP", "kpmg"),
        ("Ernst & Young LLP", "ernst and young"),
        ("A.B.C. Corp", "a b c"),
        ("Acme\u00a0Inc", "acme"),
        ("Acme Inc Co", "acme"),
        ("3M Company", "3m"),
        ("Co", "co"),
        ("!!", ""),
    ],
)
def test_phase1_company_names_normalize_to_one_key(raw, expected):
    with connect() as conn:
        assert (
            conn.execute("select fwp_private.normalize_company(%s)", (raw,)).fetchone()[0]
            == expected
        )


def test_phase1_current_employer_is_stored_privately_and_blocked(actor):
    run_as(actor, "select public.save_my_current_employer(%s)", ("Acme Holdings, Inc.",))
    assert my_blocks(actor) == [("Acme Holdings, Inc.", "current_employer")]
    assert run_as(actor, "select current_employer from public.candidate_private") == [
        ("Acme Holdings, Inc.",)
    ]


def test_phase1_changing_employer_keeps_the_previous_one_blocked(actor):
    run_as(actor, "select public.save_my_current_employer('Old Firm LLP')")
    run_as(actor, "select public.save_my_current_employer('New Firm LLP')")
    assert my_blocks(actor) == [
        ("New Firm LLP", "current_employer"),
        ("Old Firm LLP", "candidate"),
    ]


def test_phase1_employer_matching_an_existing_block_converts_it(actor):
    run_as(actor, "select public.add_my_block('Acme Inc')")
    run_as(actor, "select public.save_my_current_employer('ACME LLC')")
    assert my_blocks(actor) == [("ACME LLC", "current_employer")]


def test_phase1_blocks_dedupe_by_normalized_name_and_are_capped(actor):
    run_as(actor, "select public.save_my_current_employer('Employer 0 LLC')")
    for n in range(1, 50):
        run_as(actor, "select public.add_my_block(%s)", (f"Company {n} Inc",))
    assert len(my_blocks(actor)) == 50
    # Re-adding an existing company is a no-op even at the cap.
    run_as(actor, "select public.add_my_block('company 7, LLC')")
    assert len(my_blocks(actor)) == 50
    with pytest.raises(psycopg.errors.ProgramLimitExceeded):
        run_as(actor, "select public.add_my_block('One Too Many Ltd')")
    with pytest.raises(psycopg.errors.ProgramLimitExceeded):
        run_as(actor, "select public.save_my_current_employer('Brand New Employer LLC')")
    assert len(my_blocks(actor)) == 50


def test_phase1_current_employer_cannot_be_removed_but_others_can(actor):
    run_as(actor, "select public.save_my_current_employer('Current Firm LLP')")
    run_as(actor, "select public.add_my_block('Other Firm')")
    ids = dict(run_as(actor, "select company_name, id from public.candidate_blocks"))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        run_as(actor, "select public.remove_my_block(%s)", (ids["Current Firm LLP"],))
    run_as(actor, "select public.remove_my_block(%s)", (ids["Other Firm"],))
    assert my_blocks(actor) == [("Current Firm LLP", "current_employer")]


def test_phase1_owner_only_reads_and_no_cross_user_removal(actor, other_actor):
    run_as(actor, "select public.add_my_block('Private Firm')")
    mine = run_as(actor, "select id from public.candidate_blocks")
    assert run_as(other_actor, "select count(*) from public.candidate_blocks") == [(0,)]
    assert run_as(other_actor, "select count(*) from public.candidate_private") == [(0,)]
    # Removing someone else's block id is a silent no-op that leaves it intact.
    run_as(other_actor, "select public.remove_my_block(%s)", (mine[0][0],))
    assert my_blocks(actor) == [("Private Firm", "candidate")]


@pytest.mark.parametrize(
    "statement",
    [
        "insert into public.candidate_blocks(user_id,company_name,company_key,source) "
        "select user_id,'X Firm','x firm','candidate' from public.member_accounts limit 1",
        "update public.candidate_blocks set company_name = 'Changed'",
        "delete from public.candidate_blocks",
        "insert into public.candidate_private(user_id,current_employer,current_employer_key) "
        "select user_id,'X Firm','x firm' from public.member_accounts limit 1",
        "update public.candidate_private set current_employer = 'Changed'",
        "delete from public.candidate_private",
    ],
)
def test_phase1_clients_cannot_write_the_tables_directly(actor, statement):
    run_as(actor, "select public.save_my_current_employer('Direct Write Firm LLC')")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        run_as(actor, statement)


def test_phase1_anon_has_no_access():
    with connect() as conn:
        for statement in (
            "select * from public.candidate_blocks",
            "select * from public.candidate_private",
            "select public.add_my_block('Anon Firm')",
            "select public.save_my_current_employer('Anon Firm')",
        ):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                with conn.transaction():
                    conn.execute("set local role anon")
                    conn.execute(statement)


def test_phase1_recruiter_accounts_cannot_use_candidate_controls(recruiter_actor):
    for statement in (
        "select public.save_my_current_employer('Recruiter Firm')",
        "select public.add_my_block('Recruiter Firm')",
    ):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            run_as(recruiter_actor, statement)
    assert run_as(recruiter_actor, "select count(*) from public.candidate_blocks") == [(0,)]


@pytest.mark.parametrize(
    "value",
    ["", " ", "x", "a" * 151, "bad\nname", "!!", ". . ."],
)
@pytest.mark.parametrize("function", ["save_my_current_employer", "add_my_block"])
def test_phase1_invalid_company_names_are_rejected(actor, function, value):
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        run_as(actor, f"select public.{function}(%s)", (value,))
    assert my_blocks(actor) == []


def test_phase1_null_inputs_are_rejected(actor):
    for statement in (
        "select public.save_my_current_employer(null)",
        "select public.add_my_block(null)",
        "select public.remove_my_block(null)",
    ):
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            run_as(actor, statement)


def test_phase1_audit_records_events_without_company_names(actor):
    run_as(actor, "select public.save_my_current_employer('Secret Audit Firm LLP')")
    run_as(actor, "select public.add_my_block('Another Secret Firm')")
    ids = run_as(actor, "select id from public.candidate_blocks where source = 'candidate'")
    run_as(actor, "select public.remove_my_block(%s)", (ids[0][0],))
    with connect() as conn:
        columns = [
            row[0]
            for row in conn.execute(
                """select column_name from information_schema.columns
                   where table_schema = 'fwp_private' and table_name = 'privacy_audit'
                   order by ordinal_position"""
            ).fetchall()
        ]
        assert columns == ["id", "user_id", "event", "created_at"]
        events = conn.execute(
            "select event from fwp_private.privacy_audit where user_id = %s order by id",
            (actor[0],),
        ).fetchall()
        assert [e[0] for e in events] == ["current_employer_set", "block_added", "block_removed"]
        for role in ("anon", "authenticated"):
            assert (
                conn.execute(
                    "select has_table_privilege(%s,'fwp_private.privacy_audit','SELECT,INSERT,UPDATE,DELETE')",
                    (role,),
                ).fetchone()[0]
                is False
            )


def test_phase1_deleting_the_account_removes_private_rows():
    person = make_actor()
    run_as(person, "select public.save_my_current_employer('Gone Firm LLC')")
    run_as(person, "select public.add_my_block('Gone Block')")
    with connect() as conn:
        conn.execute("delete from auth.users where id = %s", (person[0],))
        assert conn.execute(
            "select (select count(*) from public.candidate_blocks where user_id = %s), "
            "(select count(*) from public.candidate_private where user_id = %s)",
            (person[0], person[0]),
        ).fetchone() == (0, 0)


def test_phase1_deletion_requested_accounts_cannot_change_protections(actor):
    run_as(actor, "select public.save_my_current_employer('Frozen Firm LLC')")
    run_as(actor, "select public.request_my_account_deletion()")
    for statement in (
        "select public.add_my_block('Late Block')",
        "select public.save_my_current_employer('Late Employer')",
    ):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            run_as(actor, statement)


# --- Phase 2: recruiter verification, consented discovery and anonymous search ---

CONSENT = "discovery-v1"
SEARCH = (
    "select handle, headline, skills, work_preference from public.search_candidates(%s, %s, %s, %s)"
)


def email_of(person):
    return f"{person[0]}@example.com"


def admin(sql, params=()):
    with connect("audit-operator") as conn:
        cursor = conn.execute(sql, params)
        return cursor.fetchall() if cursor.description else None


def search(person, query=None, preference=None, limit=20, offset=0):
    return run_as(person, SEARCH, (query, preference, limit, offset))


def handle_of(person):
    return run_as(person, "select handle from public.candidate_discovery")[0][0]


def visible_handles(person, **kwargs):
    return {row[0] for row in search(person, **kwargs)}


@pytest.fixture
def people():
    created = []

    def candidate(
        headline="Senior accountant",
        skills=("US GAAP", "Excel"),
        employer="Alpha Audit LLP",
        blocks=(),
        preference="Remote",
        enable=True,
        approve=True,
    ):
        person = make_actor("candidate")
        created.append(person[0])
        run_as(
            person,
            "select public.save_my_private_profile('Synthetic person', %s, %s, %s, 1)",
            (headline, list(skills), preference),
        )
        if employer:
            run_as(person, "select public.save_my_current_employer(%s)", (employer,))
        for name in blocks:
            run_as(person, "select public.add_my_block(%s)", (name,))
        if enable:
            run_as(person, "select public.set_my_discovery(true, %s)", (CONSENT,))
            if approve:
                admin(
                    "select fwp_private.admin_set_candidate_review(%s, 'approved', 'test')",
                    (email_of(person),),
                )
        return person

    def recruiter(
        firm="Zenith Search Partners",
        clients=("Orion Corp",),
        proof="https://example.com/zenith",
        verify=True,
    ):
        person = make_actor("recruiter")
        created.append(person[0])
        run_as(person, "select public.save_my_recruiter_firm(%s, %s)", (firm, proof))
        for name in clients:
            run_as(person, "select public.add_my_client(%s)", (name,))
        if verify:
            run_as(person, "select public.submit_my_recruiter_profile()")
            admin(
                "select fwp_private.admin_set_recruiter_status(%s, 'verified', 'test')",
                (email_of(person),),
            )
        return person

    yield type(
        "People", (), {"candidate": staticmethod(candidate), "recruiter": staticmethod(recruiter)}
    )
    with connect() as conn:
        for user_id in created:
            conn.execute("delete from auth.users where id = %s", (user_id,))


def test_phase2_a_verified_recruiter_sees_an_approved_candidate_anonymously(people):
    candidate = people.candidate(skills=("US GAAP", "Excel"), preference="Hybrid")
    recruiter = people.recruiter()
    rows = search(recruiter)
    assert rows == [(handle_of(candidate), "Senior accountant", ["US GAAP", "Excel"], "Hybrid")]
    assert rows[0][0].startswith("RC-") and len(rows[0][0]) == 15


def test_phase2_results_have_four_columns_and_leak_nothing_private(people):
    candidate = people.candidate(employer="Secret Employer LLC", blocks=("Hidden Past Firm",))
    recruiter = people.recruiter()
    with connect() as conn, actor_transaction(conn, recruiter):
        cursor = conn.execute(SEARCH, (None, None, 20, 0))
        assert [c.name for c in cursor.description] == [
            "handle",
            "headline",
            "skills",
            "work_preference",
        ]
        text = json.dumps(cursor.fetchall()).lower()
    for secret in (
        "secret employer",
        "hidden past firm",
        "synthetic person",
        email_of(candidate),
        candidate[0],
        candidate[1],
    ):
        assert secret.lower() not in text


@pytest.mark.parametrize(
    "blocked,firm,clients,hidden",
    [
        ("Orion Corp", "Zenith Partners", ("Orion Corporation",), True),
        ("Orion", "Zenith Partners", ("Orion Search Group",), True),
        ("Orion Search Group", "Zenith Partners", ("Orion",), True),
        ("Orion", "Orion Search Partners", ("Delta Bank",), True),
        ("Delta", "Zenith Partners", ("Delta Dental",), True),
        ("Orionic", "Zenith Partners", ("Orion",), False),
        ("Orion", "Zenith Partners", ("Orionic Labs",), False),
        ("Gamma", "Zenith Partners", ("Orion", "Delta Bank"), False),
        ("Smith & Jones LLP", "Zenith Partners", ("Smith and Jones",), True),
        ("ey", "Zenith Partners", ("Ernst & Young",), False),
    ],
)
def test_phase2_blocked_companies_never_see_the_candidate(people, blocked, firm, clients, hidden):
    candidate = people.candidate(blocks=(blocked,))
    recruiter = people.recruiter(firm=firm, clients=clients)
    assert (handle_of(candidate) not in visible_handles(recruiter)) is hidden


def test_phase2_the_current_employer_is_always_excluded(people):
    candidate = people.candidate(employer="Beta Holdings, Inc.")
    assert handle_of(candidate) not in visible_handles(people.recruiter(clients=("Beta Holdings",)))
    assert handle_of(candidate) in visible_handles(people.recruiter(clients=("Other Corp",)))


def test_phase2_aliases_extend_matching_and_can_be_removed(people):
    candidate = people.candidate(blocks=("Ernst & Young",))
    recruiter = people.recruiter(clients=("EY",))
    assert handle_of(candidate) in visible_handles(recruiter)
    admin("select fwp_private.admin_add_alias('EY', 'Ernst & Young')")
    try:
        assert handle_of(candidate) not in visible_handles(recruiter)
    finally:
        admin("select fwp_private.admin_remove_alias('ey')")
    assert handle_of(candidate) in visible_handles(recruiter)


def test_phase2_alias_chains_are_refused():
    try:
        admin("select fwp_private.admin_add_alias('Foo Bar', 'Foo Holdings')")
        with pytest.raises(psycopg.errors.Error):
            admin("select fwp_private.admin_add_alias('Foo Holdings', 'Elsewhere')")
        with pytest.raises(psycopg.errors.Error):
            admin("select fwp_private.admin_add_alias('Baz', 'Foo Bar')")
        with pytest.raises(psycopg.errors.Error):
            admin("select fwp_private.admin_add_alias('Same Name Inc', 'Same Name LLC')")
    finally:
        admin("delete from fwp_private.company_aliases")


@pytest.mark.parametrize(
    "a,b,expected",
    [
        ("acme", "acme", True),
        ("acme", "acme holdings", True),
        ("acme holdings", "acme", True),
        ("acme", "acmeron", False),
        ("acme corp", "acme inc", False),
        ("a b", "a b c", True),
        ("x", "x", True),
        (None, "acme", True),
    ],
)
def test_phase2_key_conflict_rule(a, b, expected):
    assert admin("select fwp_private.canonical_keys_conflict(%s, %s)", (a, b)) == [(expected,)]


def test_phase2_blocks_take_effect_on_the_next_search_and_can_be_lifted(people):
    candidate = people.candidate()
    recruiter = people.recruiter(clients=("Orion Corp",))
    assert handle_of(candidate) in visible_handles(recruiter)
    run_as(candidate, "select public.add_my_block('Orion Corporation')")
    assert handle_of(candidate) not in visible_handles(recruiter)
    block = run_as(candidate, "select id from public.candidate_blocks where source = 'candidate'")
    run_as(candidate, "select public.remove_my_block(%s)", (block[0][0],))
    assert handle_of(candidate) in visible_handles(recruiter)


@pytest.mark.parametrize("state", ["draft", "pending", "rejected", "suspended"])
def test_phase2_unverified_recruiters_get_nothing(people, state):
    people.candidate()
    recruiter = people.recruiter(verify=False)
    email = email_of(recruiter)
    if state != "draft":
        run_as(recruiter, "select public.submit_my_recruiter_profile()")
    if state in ("rejected", "suspended"):
        admin("select fwp_private.admin_set_recruiter_status(%s, %s)", (email, state))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        search(recruiter)


def test_phase2_a_verified_recruiter_with_no_hires_for_list_is_refused(people):
    people.candidate()
    recruiter = people.recruiter()
    assert search(recruiter)
    admin("delete from public.recruiter_clients where user_id = %s", (recruiter[0],))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        search(recruiter)


def test_phase2_changing_a_verified_profile_withdraws_verification(people):
    candidate = people.candidate()
    recruiter = people.recruiter()
    status = "select status from public.recruiter_profiles"
    assert run_as(recruiter, status) == [("verified",)]
    run_as(recruiter, "select public.add_my_client('Gamma Group')")
    assert run_as(recruiter, status) == [("draft",)]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        search(recruiter)
    # Unchanged saves do not withdraw anything.
    run_as(recruiter, "select public.submit_my_recruiter_profile()")
    admin("select fwp_private.admin_set_recruiter_status(%s, 'verified')", (email_of(recruiter),))
    run_as(
        recruiter,
        "select public.save_my_recruiter_firm('ZENITH Search Partners', 'https://example.com/zenith')",
    )
    run_as(recruiter, "select public.add_my_client('gamma group')")
    assert run_as(recruiter, status) == [("verified",)]
    assert handle_of(candidate) in visible_handles(recruiter)
    run_as(
        recruiter,
        "select public.save_my_recruiter_firm('Zenith Search Partners', 'https://example.com/other')",
    )
    assert run_as(recruiter, status) == [("draft",)]
    clients = run_as(recruiter, "select id from public.recruiter_clients limit 1")
    admin(
        "update public.recruiter_profiles set status = 'verified' where user_id = %s",
        (recruiter[0],),
    )
    run_as(recruiter, "select public.remove_my_client(%s)", (clients[0][0],))
    assert run_as(recruiter, status) == [("draft",)]


def test_phase2_a_recruiter_cannot_verify_themselves(people):
    recruiter = people.recruiter(verify=False)
    for statement in (
        "update public.recruiter_profiles set status = 'verified'",
        "delete from public.recruiter_profiles",
        "insert into public.recruiter_clients(user_id, company_name, company_key) "
        "values (gen_random_uuid(), 'X Y', 'x y')",
        "select fwp_private.admin_set_recruiter_status('a@b.c', 'verified')",
    ):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            run_as(recruiter, statement)
    run_as(recruiter, "select public.submit_my_recruiter_profile()")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        search(recruiter)


def test_phase2_submission_needs_a_link_and_a_hires_for_list_and_rejection_needs_edits(people):
    recruiter = people.recruiter(verify=False, clients=(), proof=None)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        run_as(recruiter, "select public.submit_my_recruiter_profile()")
    run_as(
        recruiter,
        "select public.save_my_recruiter_firm('Zenith Search Partners', 'https://example.com/z')",
    )
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        run_as(recruiter, "select public.submit_my_recruiter_profile()")
    run_as(recruiter, "select public.add_my_client('Orion Corp')")
    run_as(recruiter, "select public.submit_my_recruiter_profile()")
    run_as(recruiter, "select public.submit_my_recruiter_profile()")
    admin(
        "select fwp_private.admin_set_recruiter_status(%s, 'rejected', 'no')",
        (email_of(recruiter),),
    )
    with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
        run_as(recruiter, "select public.submit_my_recruiter_profile()")


def test_phase2_suspended_recruiters_cannot_edit_or_search_until_reinstated(people):
    people.candidate()
    recruiter = people.recruiter()
    email = email_of(recruiter)
    admin("select fwp_private.admin_set_recruiter_status(%s, 'suspended', 'abuse')", (email,))
    for statement in (
        "select public.add_my_client('Another Company')",
        "select public.save_my_recruiter_firm('Zenith Search Partners', 'https://example.com/zenith')",
        "select public.submit_my_recruiter_profile()",
    ):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            run_as(recruiter, statement)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        search(recruiter)
    admin("select fwp_private.admin_set_recruiter_status(%s, 'pending')", (email,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        search(recruiter)
    admin("select fwp_private.admin_set_recruiter_status(%s, 'verified')", (email,))
    assert search(recruiter)


@pytest.mark.parametrize(
    "value",
    ["", "x", "a" * 151, "bad\nname", "!!"],
)
def test_phase2_invalid_recruiter_inputs_are_rejected(people, value):
    recruiter = people.recruiter(verify=False, clients=())
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        run_as(recruiter, "select public.save_my_recruiter_firm(%s, null)", (value,))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        run_as(recruiter, "select public.add_my_client(%s)", (value,))


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/a",
        "https://exa mple.com",
        "javascript:alert(1)",
        "https://x",
        "https://" + "a" * 300,
    ],
)
def test_phase2_proof_links_must_be_https(people, url):
    recruiter = people.recruiter(verify=False, clients=(), proof=None)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        run_as(recruiter, "select public.save_my_recruiter_firm('Zenith Partners', %s)", (url,))


def test_phase2_hires_for_list_is_capped_and_needs_a_firm_first(people):
    recruiter = make_actor("recruiter")
    try:
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            run_as(recruiter, "select public.add_my_client('Orion Corp')")
        run_as(recruiter, "select public.save_my_recruiter_firm('Zenith Partners', null)")
        for n in range(30):
            run_as(recruiter, "select public.add_my_client(%s)", (f"Client {n} Inc",))
        run_as(recruiter, "select public.add_my_client('client 3 llc')")
        with pytest.raises(psycopg.errors.ProgramLimitExceeded):
            run_as(recruiter, "select public.add_my_client('One Too Many')")
    finally:
        admin("delete from auth.users where id = %s", (recruiter[0],))


def test_phase2_candidates_must_consent_with_the_current_version_and_finish_their_draft(people):
    candidate = people.candidate(enable=False)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        run_as(candidate, "select public.set_my_discovery(true, 'discovery-v0')")
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        run_as(candidate, "select public.set_my_discovery(true, null)")
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        run_as(candidate, "select public.set_my_discovery(null, %s)", (CONSENT,))
    no_headline = make_actor("candidate")
    no_employer = make_actor("candidate")
    mentions = make_actor("candidate")
    try:
        run_as(
            no_employer,
            "select public.save_my_private_profile('X Person', 'Accountant', array['GAAP'], 'Remote', 1)",
        )
        run_as(
            mentions,
            "select public.save_my_private_profile('X Person', 'Auditor at Acme Inc', array['GAAP'], 'Remote', 1)",
        )
        run_as(mentions, "select public.save_my_current_employer('Acme, Inc.')")
        run_as(no_headline, "select public.save_my_current_employer('Acme, Inc.')")
        for person in (no_headline, no_employer, mentions):
            with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
                run_as(person, "select public.set_my_discovery(true, %s)", (CONSENT,))
            assert run_as(person, "select count(*) from public.candidate_discovery") == [(0,)]
    finally:
        for person in (no_headline, no_employer, mentions):
            admin("delete from auth.users where id = %s", (person[0],))


def test_phase2_nobody_is_visible_until_the_operator_approves(people):
    recruiter = people.recruiter()
    pending = people.candidate(approve=False)
    assert handle_of(pending) not in visible_handles(recruiter)
    status = run_as(pending, "select public.my_discovery_status()")[0][0]
    assert status["enabled"] and not status["visible"] and status["blockers"] == ["awaiting_review"]
    for review, blocker in (("rejected", "review_rejected"), ("suspended", "review_suspended")):
        admin("select fwp_private.admin_set_candidate_review(%s, %s)", (email_of(pending), review))
        assert handle_of(pending) not in visible_handles(recruiter)
        assert run_as(pending, "select public.my_discovery_status()")[0][0]["blockers"] == [blocker]
        admin("select fwp_private.admin_set_candidate_review(%s, 'pending')", (email_of(pending),))
    admin("select fwp_private.admin_set_candidate_review(%s, 'approved')", (email_of(pending),))
    assert handle_of(pending) in visible_handles(recruiter)
    assert run_as(pending, "select public.my_discovery_status()")[0][0]["visible"] is True


def test_phase2_a_candidate_cannot_approve_themselves_or_unhide_after_rejection(people):
    candidate = people.candidate(approve=False)
    for statement in (
        "update public.candidate_discovery set review_status = 'approved'",
        "update public.candidate_discovery set enabled = true",
        "delete from public.candidate_discovery",
        "update public.account_profiles set discovery_active = true",
        "select fwp_private.admin_set_candidate_review('a@b.c', 'approved')",
    ):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            run_as(candidate, statement)
    admin("select fwp_private.admin_set_candidate_review(%s, 'rejected')", (email_of(candidate),))
    run_as(candidate, "select public.set_my_discovery(false, null)")
    run_as(candidate, "select public.set_my_discovery(true, %s)", (CONSENT,))
    assert run_as(candidate, "select review_status from public.candidate_discovery") == [
        ("rejected",)
    ]
    assert run_as(candidate, "select discovery_active from public.account_profiles") == [(False,)]


def test_phase2_turning_discovery_off_hides_the_candidate_immediately(people):
    candidate = people.candidate()
    recruiter = people.recruiter()
    handle = handle_of(candidate)
    assert handle in visible_handles(recruiter)
    run_as(candidate, "select public.set_my_discovery(false, null)")
    assert handle not in visible_handles(recruiter)
    run_as(candidate, "select public.set_my_discovery(true, %s)", (CONSENT,))
    assert handle in visible_handles(recruiter)
    assert handle_of(candidate) == handle


def test_phase2_outdated_consent_hides_the_candidate_until_given_again(people):
    candidate = people.candidate()
    recruiter = people.recruiter()
    admin(
        "update public.candidate_discovery set consent_version = 'discovery-v0' where user_id = %s",
        (candidate[0],),
    )
    assert handle_of(candidate) not in visible_handles(recruiter)
    assert run_as(candidate, "select public.my_discovery_status()")[0][0]["blockers"] == [
        "consent_outdated"
    ]
    run_as(candidate, "select public.set_my_discovery(true, %s)", (CONSENT,))
    assert handle_of(candidate) in visible_handles(recruiter)


def test_phase2_editing_the_headline_to_name_a_blocked_company_hides_the_candidate(people):
    candidate = people.candidate(employer="Gamma Group")
    recruiter = people.recruiter(clients=("Orion Corp",))
    assert handle_of(candidate) in visible_handles(recruiter)
    run_as(
        candidate,
        "select public.save_my_private_profile('X Person', 'Auditor, ex Gamma Group', array['GAAP'], 'Remote', 2)",
    )
    assert handle_of(candidate) not in visible_handles(recruiter)
    status = run_as(candidate, "select public.my_discovery_status()")[0][0]
    assert status["blockers"] == ["mentions_blocked_company"] and status["ready"] is False
    run_as(
        candidate,
        "select public.save_my_private_profile('X Person', 'Senior auditor', array['Gamma Group audits'], 'Remote', 3)",
    )
    assert handle_of(candidate) not in visible_handles(recruiter)
    run_as(
        candidate,
        "select public.save_my_private_profile('X Person', 'Senior auditor', array['GAAP'], 'Remote', 4)",
    )
    assert handle_of(candidate) in visible_handles(recruiter)


def test_phase2_deleting_suspending_or_banning_removes_a_candidate_at_once(people):
    recruiter = people.recruiter()
    one, two, three = people.candidate(), people.candidate(), people.candidate()
    handles = [handle_of(p) for p in (one, two, three)]
    assert set(handles) <= visible_handles(recruiter)
    run_as(one, "select public.request_my_account_deletion()")
    admin("update public.member_accounts set status = 'suspended' where user_id = %s", (two[0],))
    admin(
        "update auth.users set banned_until = now() + interval '1 day' where id = %s", (three[0],)
    )
    assert not set(handles) & visible_handles(recruiter)
    # Coming back does not silently restore visibility: consent is asked again.
    run_as(one, "select public.cancel_my_account_deletion()")
    assert handles[0] not in visible_handles(recruiter)
    assert run_as(one, "select enabled from public.candidate_discovery") == [(False,)]
    run_as(one, "select public.set_my_discovery(true, %s)", (CONSENT,))
    assert handles[0] in visible_handles(recruiter)


def test_phase2_search_is_limited_to_job_text_and_cannot_probe_private_fields(people):
    people.candidate(employer="Secret Employer LLC", blocks=("Hidden Past Firm",))
    recruiter = people.recruiter()
    for probe in ("secret", "hidden past", "synthetic", "example.com", "alpha"):
        assert search(recruiter, query=probe) == []
    assert len(search(recruiter, query="senior GAAP")) == 1
    assert search(recruiter, query="senior blockchain") == []
    assert len(search(recruiter, query="  EXCEL ")) == 1
    assert search(recruiter, preference="Hybrid") == []
    assert len(search(recruiter, preference="Remote")) == 1


def test_phase2_search_inputs_are_validated_and_paged(people):
    for n in range(3):
        people.candidate(headline=f"Accountant number {n}")
    recruiter = people.recruiter()
    for kwargs in (
        {"limit": 0},
        {"limit": 21},
        {"offset": -1},
        {"offset": 101},
        {"query": "x" * 81},
        {"query": "bad\nquery"},
        {"preference": "Anywhere"},
    ):
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            search(recruiter, **kwargs)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        run_as(recruiter, "select * from public.search_candidates(null, null, null, 0)")
    first = [row[0] for row in search(recruiter, limit=2)]
    second = [row[0] for row in search(recruiter, limit=2, offset=2)]
    assert len(first) == 2 and len(second) == 1 and len(set(first + second)) == 3
    assert len(run_as(recruiter, "select * from public.search_candidates()")) == 3


def test_phase2_search_is_rate_limited_per_recruiter(people):
    recruiter = people.recruiter()
    other = people.recruiter()
    for _ in range(60):
        search(recruiter)
    with pytest.raises(psycopg.errors.ConfigurationLimitExceeded):
        search(recruiter)
    assert search(other) == []
    assert admin(
        "select count(*) from fwp_private.search_log where user_id = %s", (recruiter[0],)
    ) == [(60,)]
    admin(
        "update fwp_private.search_log set created_at = now() - interval '2 hours' where user_id = %s",
        (recruiter[0],),
    )
    search(recruiter)


def test_phase2_roles_cannot_use_each_others_functions(people):
    candidate = people.candidate()
    recruiter = people.recruiter()
    for statement in (
        "select public.save_my_recruiter_firm('Mine Inc', null)",
        "select public.add_my_client('Mine Inc')",
        "select public.submit_my_recruiter_profile()",
        "select * from public.search_candidates()",
    ):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            run_as(candidate, statement)
    for statement in ("select public.set_my_discovery(true, 'discovery-v1')",):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            run_as(recruiter, statement)
    assert run_as(recruiter, "select public.my_discovery_status()")[0][0]["blockers"] == [
        "account_inactive"
    ]


def test_phase2_nobody_can_read_other_peoples_rows_directly(people):
    candidate = people.candidate()
    other_candidate = people.candidate()
    recruiter = people.recruiter()
    other_recruiter = people.recruiter()
    candidate_tables = (
        "candidate_discovery",
        "candidate_private",
        "candidate_blocks",
        "account_profiles",
        "career_backgrounds",
    )
    for table in candidate_tables:
        for outsider in (recruiter, other_recruiter):
            assert run_as(outsider, f"select count(*) from public.{table}") == [(0,)]
    for table in ("recruiter_profiles", "recruiter_clients"):
        for outsider in (candidate, other_candidate, other_recruiter):
            if outsider is other_recruiter:
                continue
            assert run_as(outsider, f"select count(*) from public.{table}") == [(0,)]
    assert run_as(other_recruiter, "select user_id from public.recruiter_profiles") == [
        (uuid.UUID(other_recruiter[0]),)
    ]
    assert run_as(candidate, "select count(*) from public.candidate_discovery") == [(1,)]
    assert run_as(recruiter, "select count(*) from public.member_accounts") == [(1,)]


@pytest.mark.parametrize(
    "statement",
    [
        "insert into public.recruiter_profiles(user_id, firm_name, firm_key) select user_id, 'X Y', 'x y' from public.member_accounts limit 1",
        "update public.recruiter_profiles set firm_name = 'Changed'",
        "delete from public.recruiter_clients",
        "update public.recruiter_clients set company_key = 'zz'",
        "insert into public.candidate_discovery(user_id) select user_id from public.member_accounts limit 1",
        "select * from fwp_private.search_log",
        "select * from fwp_private.review_log",
        "select * from fwp_private.company_aliases",
        "insert into fwp_private.company_aliases values ('aa', 'bb')",
        "select * from fwp_private.privacy_audit",
    ],
)
def test_phase2_clients_cannot_touch_the_new_tables_directly(people, statement):
    recruiter = people.recruiter()
    candidate = people.candidate()
    for person in (recruiter, candidate):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            run_as(person, statement)


def test_phase2_anonymous_visitors_have_no_access():
    with connect() as conn:
        for statement in (
            "select * from public.recruiter_profiles",
            "select * from public.recruiter_clients",
            "select * from public.candidate_discovery",
            "select * from public.search_candidates()",
            "select public.set_my_discovery(true, 'discovery-v1')",
            "select public.my_discovery_status()",
            "select public.save_my_recruiter_firm('A B', null)",
            "select public.add_my_client('A B')",
            "select public.submit_my_recruiter_profile()",
        ):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                with conn.transaction():
                    conn.execute("set local role anon")
                    conn.execute(statement)


def test_phase2_only_the_intended_functions_are_callable_by_clients():
    """Exact allowlists, so any new function must be granted on purpose."""
    anon_allowed = {"public.register_pilot_interest"}
    signed_in_allowed = {
        "fwp_private.career_readable",
        "fwp_private.session_is_active",
        "public.account_session_active",
        "public.add_my_block",
        "public.add_my_client",
        "public.cancel_my_account_deletion",
        "public.my_discovery_status",
        "public.onboard_my_account",
        "public.remove_my_block",
        "public.remove_my_career_document",
        "public.remove_my_client",
        "public.request_my_account_deletion",
        "public.save_my_career_background",
        "public.save_my_career_document",
        "public.save_my_career_workflow",
        "public.save_my_current_employer",
        "public.save_my_private_profile",
        "public.save_my_recruiter_firm",
        "public.search_candidates",
        "public.set_my_discovery",
        "public.submit_my_recruiter_profile",
    }
    with connect() as conn:
        rows = conn.execute(
            """select n.nspname || '.' || p.proname,
                      has_function_privilege('anon', p.oid, 'EXECUTE'),
                      has_function_privilege('authenticated', p.oid, 'EXECUTE'),
                      has_function_privilege('public', p.oid, 'EXECUTE')
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname in ('fwp_private', 'public')"""
        ).fetchall()
    assert {name for name, anon, _, _ in rows if anon} == anon_allowed
    assert {name for name, _, signed_in, _ in rows if signed_in} == signed_in_allowed
    assert not [name for name, _, _, everyone in rows if everyone]


def test_phase2_operator_functions_are_not_executable_by_clients(people):
    candidate = people.candidate()
    for statement in (
        "select * from fwp_private.admin_pending()",
        "select fwp_private.admin_set_recruiter_status('a@b.c', 'verified')",
        "select fwp_private.admin_set_candidate_review('a@b.c', 'approved')",
        "select fwp_private.admin_add_alias('aa', 'bb')",
        "select fwp_private.admin_remove_alias('aa')",
        "select fwp_private.candidate_blockers(gen_random_uuid())",
        "select fwp_private.recruiter_actor()",
        "select fwp_private.recruiter_blocked_by(gen_random_uuid(), gen_random_uuid())",
    ):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            run_as(candidate, statement)


def test_phase2_operator_transitions_are_checked_and_logged(people):
    recruiter = people.recruiter(verify=False)
    candidate = people.candidate(approve=False)
    r, c = email_of(recruiter), email_of(candidate)
    with pytest.raises(psycopg.errors.Error):
        admin("select fwp_private.admin_set_recruiter_status(%s, 'verified')", (r,))
    run_as(recruiter, "select public.submit_my_recruiter_profile()")
    pending = admin("select kind, email, link from fwp_private.admin_pending() order by kind")
    assert ("candidate", c, None) in pending
    assert ("recruiter", r, "https://example.com/zenith") in pending
    detail = admin(
        "select summary from fwp_private.admin_pending() where kind = 'recruiter' and email = %s",
        (r,),
    )
    assert "Zenith Search Partners" in detail[0][0] and "Orion Corp" in detail[0][0]
    for bad in ("approved", "suspended_x"):
        with pytest.raises(psycopg.errors.Error):
            admin("select fwp_private.admin_set_recruiter_status(%s, %s)", (r, bad))
    with pytest.raises(psycopg.errors.Error):
        admin("select fwp_private.admin_set_recruiter_status('nobody@example.com', 'verified')")
    with pytest.raises(psycopg.errors.Error):
        admin("select fwp_private.admin_set_candidate_review(%s, 'pending')", (c,))
    admin("select fwp_private.admin_set_recruiter_status(%s, 'verified', 'checked link')", (r,))
    admin("select fwp_private.admin_set_candidate_review(%s, 'approved', 'real person')", (c,))
    assert admin(
        "select count(*) from fwp_private.admin_pending() where email in (%s, %s)", (r, c)
    ) == [(0,)]
    log = admin(
        "select kind, from_status, to_status, note from fwp_private.review_log where user_id in (%s, %s) order by id",
        (recruiter[0], candidate[0]),
    )
    assert log == [
        ("recruiter", "pending", "verified", "checked link"),
        ("candidate", "pending", "approved", "real person"),
    ]
    # Verified status needs a link and a hires-for list even for the operator.
    admin(
        "update public.recruiter_profiles set status = 'pending', proof_url = null where user_id = %s",
        (recruiter[0],),
    )
    with pytest.raises(psycopg.errors.Error):
        admin("select fwp_private.admin_set_recruiter_status(%s, 'verified')", (r,))


def test_phase2_audit_log_holds_events_only_and_never_company_names(people):
    candidate = people.candidate(employer="Audit Secret Firm LLC")
    recruiter = people.recruiter(clients=("Audit Client Corp",))
    run_as(candidate, "select public.set_my_discovery(false, null)")
    events = [
        e[0]
        for e in admin(
            "select event from fwp_private.privacy_audit where user_id = any(%s::uuid[]) order by id",
            ([candidate[0], recruiter[0]],),
        )
    ]
    assert events == [
        "current_employer_set",
        "discovery_enabled",
        "candidate_approved",
        "recruiter_firm_saved",
        "recruiter_client_added",
        "recruiter_submitted",
        "recruiter_verified",
        "discovery_disabled",
    ]
    columns = [
        c[0]
        for c in admin(
            """select column_name from information_schema.columns
           where table_schema = 'fwp_private' and table_name = 'privacy_audit' order by ordinal_position"""
        )
    ]
    assert columns == ["id", "user_id", "event", "created_at"]


def test_phase2_deleting_an_account_removes_everything_it_owned(people):
    candidate = people.candidate()
    recruiter = people.recruiter()
    search(recruiter)
    handle = handle_of(candidate)
    admin("delete from auth.users where id = %s", (recruiter[0],))
    admin("delete from auth.users where id = %s", (candidate[0],))
    counts = admin(
        """select (select count(*) from public.recruiter_profiles where user_id = %s),
                  (select count(*) from public.recruiter_clients where user_id = %s),
                  (select count(*) from fwp_private.search_log where user_id = %s),
                  (select count(*) from public.candidate_discovery where handle = %s)""",
        (recruiter[0], recruiter[0], recruiter[0], handle),
    )
    assert counts == [(0, 0, 0, 0)]


def test_phase2_handles_are_unique_random_and_stable(people):
    one, two = people.candidate(), people.candidate()
    assert handle_of(one) != handle_of(two)
    before = handle_of(one)
    run_as(one, "select public.set_my_discovery(false, null)")
    run_as(one, "select public.set_my_discovery(true, 'discovery-v1')")
    assert handle_of(one) == before
