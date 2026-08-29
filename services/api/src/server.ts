import { Pool } from "pg";
import { Logger } from "@ide-collector/shared-utils";
import { loadConfig } from "./config";
import { PostgresApiRepository } from "./repository";
import { buildApiApp } from "./app";

async function main() {
  const config = loadConfig();
  const logger = new Logger({ service: "api", level: config.logLevel });

  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    // Supabase and most managed Postgres providers require TLS. `rejectUnauthorized`
    // stays on unless the operator explicitly opts out for a self-signed dev cert.
    ssl: config.databaseUrl.includes("sslmode=disable")
      ? false
      : config.nodeEnv === "production"
        ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" }
        : false,
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
