import { Pool } from "pg";
import { Logger, redactDatabaseUrl, resolveDatabaseSsl } from "@ide-collector/shared-utils";
import { loadConfig } from "./config";
import { PostgresApiRepository } from "./repository";
import { buildApiApp } from "./app";

async function main() {
  const config = loadConfig();
  const logger = new Logger({ service: "api", level: config.logLevel });

  // TLS is decided from the connection target, not from NODE_ENV: a managed
  // database (Supabase, RDS, Neon) needs TLS whether or not this happens to be
  // running in "development".
  const ssl = resolveDatabaseSsl({
    databaseUrl: config.databaseUrl,
    mode: config.databaseSslMode,
    caCert: config.databaseCaCert,
  });

  logger.info("connecting to database", {
    url: redactDatabaseUrl(config.databaseUrl),
    tls: ssl === false ? "disabled" : ssl.rejectUnauthorized ? "verified" : "unverified",
  });

  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolSize,
    ssl,
  });

  const repository = new PostgresApiRepository(pool);
  const app = buildApiApp({ config, repository, logger });

  await app.listen({ host: config.host, port: config.port });
  logger.info("api service listening", { host: config.host, port: config.port });

  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    await app.close().catch(() => undefined);
    await repository.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ level: "error", message: "fatal startup error", error: String(err) }));
  process.exit(1);
});
