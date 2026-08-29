import Fastify from "fastify";
import { Pool } from "pg";
import { Logger } from "@ide-collector/shared-utils";
import { loadConfig } from "./config";
import { PostgresEventStore } from "./store";
import { EventProcessor } from "./processor";
import { KafkaEventConsumer } from "./consumer";
import { createConsumerMetrics } from "./metrics";

async function main() {
  const config = loadConfig();
  const logger = new Logger({ service: "kafka-consumer", level: config.logLevel });
  const metrics = createConsumerMetrics();

  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolSize,
    ssl:
      config.nodeEnv === "production" && !config.databaseUrl.includes("sslmode=disable")
        ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" }
        : false,
  });

  const store = new PostgresEventStore(pool);

  // Constructed before the processor so the processor can publish to the DLQ.
  let consumer: KafkaEventConsumer;

  const processor = new EventProcessor({
    store,
    logger,
    metrics,
    publishToErrorTopic: (record) => consumer.publishToErrorTopic(record),
    publishToProcessedTopic: config.emitProcessedEvents
      ? (events) => consumer.publishToProcessedTopic(events)
      : undefined,
  });

  consumer = new KafkaEventConsumer(config, processor, logger, metrics);

  // ---- Observability endpoints ---------------------------------------------
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ status: "ok", service: "kafka-consumer" }));

  app.get("/ready", async (_request, reply) => {
    const dbOk = await store.healthCheck();
    const ready = dbOk && consumer.isConnected() && consumer.isRunning();
    reply.code(ready ? 200 : 503);
    return {
      status: ready ? "ready" : "not-ready",
      database: dbOk,
      kafka_connected: consumer.isConnected(),
      consumer_running: consumer.isRunning(),
    };
  });

  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4");
    return metrics.registry.expose();
  });

  await app.listen({ host: config.host, port: config.port });
  logger.info("consumer observability endpoints listening", {
    host: config.host,
    port: config.port,
  });

  // ---- Start consuming (retrying until brokers are reachable) --------------
  const startWithRetry = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await consumer.start();
        return;
      } catch (err) {
        const delay = Math.min(1000 * 2 ** attempt, 30_000);
        logger.warn("consumer start failed, retrying", {
          attempt: attempt + 1,
          delayMs: delay,
          error: err instanceof Error ? err.message : String(err),
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  };
  void startWithRetry();

  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    await app.close().catch(() => undefined);
    await consumer.stop().catch(() => undefined);
    await store.close().catch(() => undefined);
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
