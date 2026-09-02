/**
 * Diagnoses the database connection and verifies the schema is usable by the
 * consumer.
 *
 *   npm run check:db
 *
 * Written because the failure modes against a hosted database (Supabase in
 * particular) are specific and easy to misread: an IPv6-only host unreachable
 * from Docker, a TLS chain that will not verify, or RLS blocking the writer.
 * Each check below reports the actual remedy rather than a raw driver error.
 */
import { lookup } from "dns/promises";
import { randomUUID } from "crypto";
import { Client } from "pg";
import { parseDatabaseHost, readCaCertFromEnv, redactDatabaseUrl, resolveDatabaseSsl } from "../packages/shared-utils/src";
import { loadDotEnv, requireDatabaseUrl } from "./env";

loadDotEnv();

const EXPECTED_TABLES = [
  "users",
  "installations",
  "enrollment_codes",
  "projects",
  "repositories",
  "ide_sessions",
  "raw_events",
  "event_errors",
];

let failures = 0;

function pass(message: string) {
  console.log(`  ✓ ${message}`);
}
function fail(message: string, remedy?: string) {
  failures++;
  console.log(`  ✗ ${message}`);
  if (remedy) console.log(`      ${remedy.split("\n").join("\n      ")}`);
}
function warn(message: string, detail?: string) {
  console.log(`  ! ${message}`);
  if (detail) console.log(`      ${detail.split("\n").join("\n      ")}`);
}

async function checkDns(host: string): Promise<void> {
  console.log("\nDNS");

  let v4: string | undefined;
  let v6: string | undefined;

  try {
    const address = (await lookup(host, { family: 4 })).address;
    // Guard against v4-mapped results being reported as the wrong family.
    if (!address.includes(":")) v4 = address;
  } catch {
    /* no A record */
  }
  try {
    const address = (await lookup(host, { family: 6 })).address;
    if (address.includes(":")) v6 = address;
  } catch {
    /* no AAAA record */
  }

  if (v4) pass(`IPv4 (A): ${v4}`);
  if (v6) pass(`IPv6 (AAAA): ${v6}`);

  if (!v4 && !v6) {
    fail(`${host} does not resolve`, "Check the hostname for typos.");
    return;
  }

  if (!v4 && v6) {
    // The single most common Supabase-in-Docker failure.
    warn(
      `${host} is IPv6-only (no A record).`,
      [
        "Docker containers have no IPv6 by default, so the services will fail",
        "to reach this host even though it works from your shell.",
        "",
        "Fix: use Supabase's Session pooler, which has IPv4. In the dashboard:",
        "  Project Settings -> Database -> Connection string -> Session pooler",
        "It looks like:",
        "  postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres",
        "Note the user becomes postgres.<project-ref>, not plain postgres.",
      ].join("\n")
    );
  }
}

async function main() {
  const databaseUrl = requireDatabaseUrl();
  const host = parseDatabaseHost(databaseUrl);
  const ssl = resolveDatabaseSsl({
    databaseUrl,
    mode: process.env.DATABASE_SSL,
    caCert: readCaCertFromEnv(),
  });

  console.log(`Target: ${redactDatabaseUrl(databaseUrl)}`);
  console.log(
    `TLS:    ${ssl === false ? "disabled" : ssl.rejectUnauthorized ? "verified" : "unverified"}`
  );

  if (host) await checkDns(host);

  console.log("\nConnection");
  const client = new Client({ connectionString: databaseUrl, ssl, connectionTimeoutMillis: 15_000 });

  try {
    await client.connect();
    pass("connected");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (/self.signed|unable to verify|certificate/i.test(message)) {
      fail(
        `TLS verification failed: ${message}`,
        [
          "Supabase signs its database certificates with its own CA, which is not",
          "in the system trust store. The connection is encrypted either way; the",
          "question is only whether the certificate is verified.",
          "",
          "Preferred fix - verify against Supabase's CA:",
          "  1. Supabase dashboard -> Project Settings -> Database ->",
          "     SSL configuration -> Download certificate  (prod-ca-*.crt)",
          "  2. Save it in the repo root as  supabase-ca.crt   (it is gitignored)",
          "  3. Add to .env:   DATABASE_CA_CERT_FILE=./supabase-ca.crt",
          "",
          "Quick unblock - encrypted but NOT verified:",
          "  DATABASE_SSL=require",
        ].join("\n")
      );
    } else if (/ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN/i.test(message)) {
      fail(
        `Network unreachable: ${message}`,
        "If the host is IPv6-only (see DNS above), switch to the Session pooler."
      );
    } else if (/password authentication failed|SASL|SCRAM/i.test(message)) {
      fail(
        `Authentication failed: ${message}`,
        [
          "Check the password in DATABASE_URL.",
          "If you are using the pooler, the user must be postgres.<project-ref>,",
          "not plain postgres. Special characters in the password must be",
          "percent-encoded (@ becomes %40, # becomes %23).",
        ].join("\n")
      );
    } else if (/ECONNREFUSED/i.test(message)) {
      fail(
        `Connection refused: ${message}`,
        [
          "Nothing is listening on that host and port.",
          "Against Supabase this usually means the wrong port (5432 for direct",
          "and Session pooler, 6543 for Transaction pooler) or a paused project.",
        ].join("\n")
      );
    } else if (/timeout/i.test(message)) {
      fail(
        `Connection timed out: ${message}`,
        "The host may be firewalled, paused, or unreachable from this network."
      );
    } else {
      fail(`Could not connect: ${message}`);
    }
    process.exit(1);
  }

  try {
    // ---- Server identity ----------------------------------------------------
    console.log("\nServer");
    const { rows: info } = await client.query(
      `SELECT version() AS version,
              current_user AS usr,
              current_database() AS db,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls`
    );
    pass(`${String(info[0].version).split(",")[0]}`);
    pass(`database=${info[0].db} user=${info[0].usr}`);

    // ---- Schema -------------------------------------------------------------
    console.log("\nSchema");
    const { rows: tableRows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    const present = new Set(tableRows.map((r) => r.table_name));

    const missing = EXPECTED_TABLES.filter((t) => !present.has(t));
    if (missing.length === 0) {
      pass(`all ${EXPECTED_TABLES.length} expected tables present`);
    } else {
      fail(`missing tables: ${missing.join(", ")}`, "Run: npm run migrate");
    }

    const { rows: fnRows } = await client.query(
      `SELECT 1 FROM pg_proc WHERE proname = 'ensure_raw_events_partition'`
    );
    if (fnRows.length > 0) {
      pass("ensure_raw_events_partition() present");
    } else {
      fail("ensure_raw_events_partition() missing", "Run: npm run migrate");
    }

    if (present.has("raw_events")) {
      const { rows: partRows } = await client.query<{ partition: string }>(
        `SELECT c.relname AS partition
           FROM pg_class c JOIN pg_inherits i ON c.oid = i.inhrelid
          WHERE i.inhparent = 'raw_events'::regclass
          ORDER BY 1`
      );
      if (partRows.length > 0) {
        pass(`raw_events partitions: ${partRows.map((r) => r.partition).join(", ")}`);
      } else {
        fail("raw_events has no partitions");
      }
    }

    // ---- Write path ---------------------------------------------------------
    // The check that actually matters: RLS, partition routing, and the
    // idempotency constraint all have to work for the consumer to function.
    if (present.has("raw_events")) {
      console.log("\nWrite path (as the consumer would)");
      const eventId = randomUUID();
      const timestamp = new Date().toISOString();

      try {
        await client.query("SELECT ensure_raw_events_partition($1::date)", [timestamp]);

        const insert = `
          INSERT INTO raw_events
            (event_id, user_id, installation_id, session_id, event_type,
             ide_name, "timestamp", payload, schema_version)
          VALUES ($1, 'check-db', 'check-db', 'check-db', 'session.started',
                  'vscode', $2, '{"source":"check-db"}'::jsonb, '1.0.0')
          ON CONFLICT (event_id, "timestamp") DO NOTHING`;

        const first = await client.query(insert, [eventId, timestamp]);
        if (first.rowCount === 1) {
          pass("insert succeeded (RLS is not blocking the writer)");
        } else {
          fail("insert affected 0 rows unexpectedly");
        }

        // Re-insert the same event: the unique constraint must make it a no-op.
        const second = await client.query(insert, [eventId, timestamp]);
        if (second.rowCount === 0) {
          pass("duplicate insert was a no-op (idempotency constraint works)");
        } else {
          fail(
            "duplicate insert created a row",
            "The UNIQUE (event_id, timestamp) constraint is missing; redelivery would duplicate data."
          );
        }

        const { rows: readBack } = await client.query(
          `SELECT tableoid::regclass AS partition FROM raw_events WHERE event_id = $1`,
          [eventId]
        );
        if (readBack.length === 1) {
          pass(`read back from partition ${readBack[0].partition}`);
        } else {
          fail(`read back returned ${readBack.length} rows, expected 1`);
        }

        await client.query(`DELETE FROM raw_events WHERE event_id = $1`, [eventId]);
        pass("cleaned up the test row");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/row-level security|permission denied/i.test(message)) {
          fail(
            `write blocked: ${message}`,
            [
              "The connecting role cannot write past RLS.",
              "Connect as the table owner (postgres) or a role with BYPASSRLS,",
              "such as Supabase's service role.",
            ].join("\n")
          );
        } else {
          fail(`write path failed: ${message}`);
        }
      }
    }
  } finally {
    await client.end().catch(() => undefined);
  }

  console.log("");
  if (failures === 0) {
    console.log("All checks passed. The consumer can write to this database.");
  } else {
    console.log(`${failures} check(s) failed - see the remedies above.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
