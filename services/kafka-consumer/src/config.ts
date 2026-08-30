import { readCaCertFromEnv } from "@ide-collector/shared-utils";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "true" || raw === "1";
}

/**
 * Mirrors kafkajs's discriminated `SASLOptions` union so the config can be
 * handed to the client without a cast.
 */
export type KafkaSaslConfig =
  | { mechanism: "plain"; username: string; password: string }
  | { mechanism: "scram-sha-256"; username: string; password: string }
  | { mechanism: "scram-sha-512"; username: string; password: string };

const SUPPORTED_SASL_MECHANISMS = ["plain", "scram-sha-256", "scram-sha-512"] as const;

export function readSaslConfig(): KafkaSaslConfig | undefined {
  const mechanism = process.env.KAFKA_SASL_MECHANISM;
  const username = process.env.KAFKA_SASL_USERNAME;
  const password = process.env.KAFKA_SASL_PASSWORD;
  if (!mechanism || !username || !password) return undefined;

  if (!(SUPPORTED_SASL_MECHANISMS as readonly string[]).includes(mechanism)) {
    throw new Error(
      `Unsupported KAFKA_SASL_MECHANISM "${mechanism}". Supported: ${SUPPORTED_SASL_MECHANISMS.join(", ")}`
    );
  }
  return { mechanism, username, password } as KafkaSaslConfig;
}

export interface ConsumerServiceConfig {
  nodeEnv: string;
  logLevel: "debug" | "info" | "warn" | "error";
  /** Port for the /health, /ready, /metrics endpoints. */
  port: number;
  host: string;

  kafka: {
    clientId: string;
    groupId: string;
    brokers: string[];
    ssl: boolean;
    sasl?: KafkaSaslConfig;
    rawTopic: string;
    errorTopic: string;
    processedTopic: string;
    sessionTimeoutMs: number;
    heartbeatIntervalMs: number;
    maxBytesPerPartition: number;
    fromBeginning: boolean;
  };

  databaseUrl: string;
  databasePoolSize: number;
  /** DATABASE_SSL: disable | require | no-verify | verify. Omit to auto-detect from the host. */
  databaseSslMode?: string;
  /** PEM CA bundle for a provider using a private certificate authority. */
  databaseCaCert?: string;
  /** Rows per INSERT. Large batches amortize round-trips; too large blows past statement limits. */
  writeBatchSize: number;
  /** Publish successfully persisted events to ide.events.processed for downstream consumers. */
  emitProcessedEvents: boolean;
}

export function loadConfig(): ConsumerServiceConfig {
  const nodeEnv = optional("NODE_ENV", "development");
  const isProd = nodeEnv === "production";

  return {
    nodeEnv,
    logLevel: optional("LOG_LEVEL", "info") as ConsumerServiceConfig["logLevel"],
    port: optionalInt("PORT", 8082),
    host: optional("HOST", "0.0.0.0"),

    kafka: {
      clientId: optional("KAFKA_CLIENT_ID", "ide-collector-consumer"),
      groupId: optional("KAFKA_GROUP_ID", "ide-events-persister"),
      brokers: optional("KAFKA_BROKERS", "localhost:9092").split(",").map((b) => b.trim()),
      ssl: optionalBool("KAFKA_SSL", false),
      sasl: readSaslConfig(),
      rawTopic: optional("KAFKA_TOPIC_RAW", "ide.events.raw"),
      errorTopic: optional("KAFKA_TOPIC_ERRORS", "ide.events.errors"),
      processedTopic: optional("KAFKA_TOPIC_PROCESSED", "ide.events.processed"),
      sessionTimeoutMs: optionalInt("KAFKA_SESSION_TIMEOUT_MS", 30_000),
      heartbeatIntervalMs: optionalInt("KAFKA_HEARTBEAT_INTERVAL_MS", 3_000),
      maxBytesPerPartition: optionalInt("KAFKA_MAX_BYTES_PER_PARTITION", 1_048_576),
      fromBeginning: optionalBool("KAFKA_FROM_BEGINNING", true),
    },

    databaseUrl: isProd
      ? required("DATABASE_URL")
      : optional("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/ide_events"),
    databasePoolSize: optionalInt("DATABASE_POOL_SIZE", 10),
    databaseSslMode: process.env.DATABASE_SSL,
    databaseCaCert: readCaCertFromEnv(),
    writeBatchSize: optionalInt("WRITE_BATCH_SIZE", 200),
    emitProcessedEvents: optionalBool("EMIT_PROCESSED_EVENTS", false),
  };
}
