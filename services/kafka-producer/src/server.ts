import { Logger } from "@ide-collector/shared-utils";
import { loadConfig } from "./config";
import { KafkaEventPublisher } from "./kafka";
import { buildApp } from "./app";

async function main() {
  const config = loadConfig();
  const logger = new Logger({ service: "kafka-producer", level: config.logLevel });

  const publisher = new KafkaEventPublisher(config, logger);
  const app = buildApp({ config, publisher, logger });

  // Connect to Kafka in the background so the process becomes live (and its
  // /health endpoint answers) even while brokers are still starting up.
  // /ready stays 503 until the connection succeeds.
  const connectWithRetry = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await publisher.connect();
        return;
      } catch (err) {
        const delay = Math.min(1000 * 2 ** attempt, 30_000);
        logger.warn("kafka connect failed, retrying", {
          attempt: attempt + 1,
          delayMs: delay,
          error: err instanceof Error ? err.message : String(err),
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  };
  void connectWithRetry();

  await app.listen({ host: config.host, port: config.port });
  logger.info("ingestion service listening", { host: config.host, port: config.port });

  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    try {
      await app.close();
      await publisher.disconnect();
    } catch (err) {
      logger.error("error during shutdown", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
