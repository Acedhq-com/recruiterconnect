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
