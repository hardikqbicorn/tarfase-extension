#!/usr/bin/env python3
"""
Python/psycopg2 equivalent of `npm run check:db`.

    pip install -r scripts/requirements.txt
    python3 scripts/check_db.py

Why this exists alongside the Node version: libpq (which psycopg2 wraps) and
node-postgres make *different default choices about TLS verification*, and that
difference is the single most confusing thing about connecting to Supabase.

    libpq default          sslmode=prefer  -> encrypted, certificate NOT verified
    this project's default                 -> encrypted, certificate verified

So a psycopg2 snippet connects happily where the Node services report
"self-signed certificate in certificate chain". That is not psycopg2 doing
something better - it is doing something weaker, silently. This script prints
the effective sslmode so the difference is visible rather than mysterious.

The backend services are Node and stay Node; this is a diagnostic and an
ad-hoc query tool, not a second persistence layer.
"""
import os
import socket
import sys
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs

try:
    import psycopg2
except ImportError:
    sys.exit(
        "psycopg2 is not installed.\n"
        "  pip install -r scripts/requirements.txt\n"
        "Note: install psycopg2-binary, not psycopg2 - the latter compiles from\n"
        "source and needs libpq and build tools, which commonly fails on macOS."
    )

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass  # .env loading is optional; the variable may already be exported.


EXPECTED_TABLES = [
    "users",
    "installations",
    "enrollment_codes",
    "projects",
    "repositories",
    "ide_sessions",
    "raw_events",
    "event_errors",
]

failures = 0


def ok(msg):
    print(f"  ✓ {msg}")


def bad(msg, remedy=None):
    global failures
    failures += 1
    print(f"  ✗ {msg}")
    if remedy:
        for line in remedy.split("\n"):
            print(f"      {line}")


def warn(msg, detail=None):
    print(f"  ! {msg}")
    if detail:
        for line in detail.split("\n"):
            print(f"      {line}")


def redact(url):
    parsed = urlparse(url)
    if parsed.password:
        netloc = parsed.netloc.replace(f":{parsed.password}", ":***")
        return parsed._replace(netloc=netloc).geturl()
    return url


def check_dns(host):
    print("\nDNS")
    v4 = v6 = None
    try:
        v4 = socket.getaddrinfo(host, None, socket.AF_INET)[0][4][0]
    except socket.gaierror:
        pass
    try:
        v6 = socket.getaddrinfo(host, None, socket.AF_INET6)[0][4][0]
    except socket.gaierror:
        pass

    if v4:
        ok(f"IPv4 (A): {v4}")
    if v6:
        ok(f"IPv6 (AAAA): {v6}")
    if not v4 and not v6:
        bad(f"{host} does not resolve", "Check the hostname for typos.")
        return

    if v6 and not v4:
        warn(
            f"{host} is IPv6-only (no A record).",
            "Docker containers have no IPv6 by default, so the services will fail\n"
            "to reach this host even though it works from this shell.\n"
            "\n"
            "Fix: use Supabase's Session pooler, which has IPv4:\n"
            "  Project Settings -> Database -> Connection string -> Session pooler\n"
            "  postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres\n"
            "Note the user becomes postgres.<project-ref>, not plain postgres.",
        )


def main():
    url = os.getenv("DATABASE_URL")
    if not url:
        sys.exit(
            "DATABASE_URL is not set.\n"
            "Set it in .env (copy .env.example), or export it inline."
        )

    parsed = urlparse(url)
    sslmode = (parse_qs(parsed.query).get("sslmode") or ["prefer (libpq default)"])[0]

    print(f"Target:  {redact(url)}")
    print(f"sslmode: {sslmode}")
    if "prefer" in sslmode:
        print(
            "         NOTE: 'prefer' encrypts but does NOT verify the certificate.\n"
            "         Append ?sslmode=verify-full and set PGSSLROOTCERT to a\n"
            "         downloaded CA to verify, matching the Node services' default."
        )

    if parsed.hostname:
        check_dns(parsed.hostname)

    print("\nConnection")
    try:
        conn = psycopg2.connect(url, connect_timeout=15)
        conn.autocommit = True
        ok("connected")
    except psycopg2.OperationalError as err:
        message = str(err).strip()
        lowered = message.lower()
        if "certificate" in lowered:
            bad(
                f"TLS verification failed: {message}",
                "Supabase signs its certificates with its own CA.\n"
                "  Download it: Project Settings -> Database -> SSL configuration\n"
                "  Then: export PGSSLROOTCERT=./certs/supabase-ca.crt\n"
                "  and use ?sslmode=verify-full in DATABASE_URL",
            )
        elif "could not translate host name" in lowered or "network is unreachable" in lowered:
            bad(
                f"Network unreachable: {message}",
                "If the host is IPv6-only (see DNS above), use the Session pooler.",
            )
        elif "authentication failed" in lowered or "password" in lowered:
            bad(
                f"Authentication failed: {message}",
                "With the pooler the user is postgres.<project-ref>, not postgres.\n"
                "Percent-encode special characters: @ -> %40, # -> %23.",
            )
        elif "timeout" in lowered or "timed out" in lowered:
            bad(f"Connection timed out: {message}", "Host firewalled, paused, or unreachable.")
        else:
            bad(f"Could not connect: {message}")
        sys.exit(1)

    try:
        with conn.cursor() as cur:
            print("\nServer")
            cur.execute("SELECT version(), current_user, current_database()")
            version, usr, db = cur.fetchone()
            ok(version.split(",")[0])
            ok(f"database={db} user={usr}")

            print("\nSchema")
            cur.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
            )
            present = {r[0] for r in cur.fetchall()}
            missing = [t for t in EXPECTED_TABLES if t not in present]
            if missing:
                bad(f"missing tables: {', '.join(missing)}", "Run: npm run migrate")
            else:
                ok(f"all {len(EXPECTED_TABLES)} expected tables present")

            if "raw_events" in present:
                cur.execute(
                    "SELECT c.relname FROM pg_class c JOIN pg_inherits i ON c.oid = i.inhrelid "
                    "WHERE i.inhparent = 'raw_events'::regclass ORDER BY 1"
                )
                parts = [r[0] for r in cur.fetchall()]
                if parts:
                    ok(f"raw_events partitions: {', '.join(parts)}")
                else:
                    bad("raw_events has no partitions")

                print("\nWrite path (as the consumer would)")
                event_id = str(uuid.uuid4())
                ts = datetime.now(timezone.utc)
                insert = """
                    INSERT INTO raw_events
                      (event_id, user_id, installation_id, session_id, event_type,
                       ide_name, "timestamp", payload, schema_version)
                    VALUES (%s, 'check-db-py', 'check-db-py', 'check-db-py',
                            'session.started', 'vscode', %s,
                            '{"source":"check_db.py"}'::jsonb, '1.0.0')
                    ON CONFLICT (event_id, "timestamp") DO NOTHING
                """
                try:
                    cur.execute("SELECT ensure_raw_events_partition(%s::date)", (ts,))
                    cur.execute(insert, (event_id, ts))
                    ok("insert succeeded (RLS is not blocking the writer)"
                       if cur.rowcount == 1 else "insert affected 0 rows unexpectedly")

                    cur.execute(insert, (event_id, ts))
                    if cur.rowcount == 0:
                        ok("duplicate insert was a no-op (idempotency constraint works)")
                    else:
                        bad("duplicate insert created a row",
                            "UNIQUE (event_id, timestamp) is missing; redelivery would duplicate data.")

                    cur.execute(
                        'SELECT tableoid::regclass FROM raw_events WHERE event_id = %s',
                        (event_id,),
                    )
                    rows = cur.fetchall()
                    if len(rows) == 1:
                        ok(f"read back from partition {rows[0][0]}")
                    else:
                        bad(f"read back returned {len(rows)} rows, expected 1")

                    cur.execute("DELETE FROM raw_events WHERE event_id = %s", (event_id,))
                    ok("cleaned up the test row")
                except psycopg2.Error as err:
                    msg = str(err).strip()
                    if "row-level security" in msg.lower() or "permission denied" in msg.lower():
                        bad(f"write blocked: {msg}",
                            "Connect as the table owner (postgres) or a role with BYPASSRLS.")
                    else:
                        bad(f"write path failed: {msg}")
    finally:
        conn.close()

    print("")
    if failures == 0:
        print("All checks passed. The consumer can write to this database.")
    else:
        print(f"{failures} check(s) failed - see the remedies above.")
        sys.exit(1)


if __name__ == "__main__":
    main()
