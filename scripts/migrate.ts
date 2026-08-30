/**
 * Applies database migrations to any PostgreSQL target, including Supabase.
 *
 *   npm run migrate
 *   DATABASE_URL='postgresql://...' npm run migrate
 *   npm run migrate -- --dry-run
 *
 * Supabase cannot use Docker's docker-entrypoint-initdb.d, so this is the
 * supported path for a hosted database. It is also safe to re-run: applied
 * migrations are recorded in schema_migrations and skipped.
 *
 * Uses `pg` rather than shelling out to psql, so it works without the
 * PostgreSQL client tools installed.
 */
import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { Client } from "pg";
import { redactDatabaseUrl, resolveDatabaseSsl } from "../packages/shared-utils/src";
import { loadDotEnv, requireDatabaseUrl } from "./env";

loadDotEnv();

const MIGRATIONS_DIR = resolve(__dirname, "../database/supabase/migrations");
const dryRun = process.argv.includes("--dry-run");

interface Migration {
  filename: string;
  sql: string;
  checksum: string;
}

function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((filename) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, filename), "utf8");
      return {
        filename,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex").slice(0, 16),
      };
    });
}

async function main() {
  const databaseUrl = requireDatabaseUrl();
  const ssl = resolveDatabaseSsl({
    databaseUrl,
    mode: process.env.DATABASE_SSL,
    caCert: process.env.DATABASE_CA_CERT,
  });

  console.log(`==> Target:  ${redactDatabaseUrl(databaseUrl)}`);
  console.log(
    `==> TLS:     ${ssl === false ? "disabled" : ssl.rejectUnauthorized ? "verified" : "unverified"}`
  );

  const client = new Client({ connectionString: databaseUrl, ssl });

  try {
    await client.connect();
  } catch (err) {
    console.error(`\n!! Could not connect: ${err instanceof Error ? err.message : String(err)}`);
    console.error("   Run `npm run check:db` for a connectivity diagnosis.");
    process.exit(1);
  }

  try {
    const { rows: versionRows } = await client.query("SELECT version()");
    console.log(`==> Server:  ${String(versionRows[0].version).split(",")[0]}`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const { rows: appliedRows } = await client.query<{ filename: string; checksum: string }>(
      "SELECT filename, checksum FROM schema_migrations"
    );
    const applied = new Map(appliedRows.map((r) => [r.filename, r.checksum]));

    const migrations = loadMigrations();
    if (migrations.length === 0) {
      console.error("!! No migrations found in database/supabase/migrations");
      process.exit(1);
    }

    let appliedCount = 0;

    for (const migration of migrations) {
      const previousChecksum = applied.get(migration.filename);

      if (previousChecksum) {
        if (previousChecksum !== migration.checksum) {
          // Editing an applied migration means the database and the repo have
          // silently diverged. Refuse rather than guess.
          console.error(
            `\n!! ${migration.filename} was already applied but its contents changed.` +
              `\n   applied checksum: ${previousChecksum}` +
              `\n   current checksum: ${migration.checksum}` +
              `\n   Add a new migration instead of editing an applied one.`
          );
          process.exit(1);
        }
        console.log(`    ${migration.filename}  (already applied)`);
        continue;
      }

      if (dryRun) {
        console.log(`    ${migration.filename}  (would apply)`);
        appliedCount++;
        continue;
      }

      process.stdout.write(`    ${migration.filename}  applying... `);
      try {
        // Each migration runs in its own transaction, so a failure leaves no
        // partial schema behind.
        await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
          [migration.filename, migration.checksum]
        );
        await client.query("COMMIT");
        console.log("ok");
        appliedCount++;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        console.log("FAILED");
        console.error(`\n!! ${migration.filename}: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    }

    if (appliedCount === 0) {
      console.log("\n==> Schema is already up to date.");
    } else {
      console.log(
        `\n==> ${dryRun ? "Would apply" : "Applied"} ${appliedCount} migration(s).`
      );
    }

    if (!dryRun) {
      const { rows } = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          ORDER BY table_name`
      );
      console.log(`==> Tables:  ${rows.map((r) => r.table_name).join(", ")}`);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
