/**
 * All configuration comes from environment variables. No secret is ever
 * committed or defaulted to a real value: the service refuses to start in
 * production without an explicitly provided JWT secret.
 */

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

export interface ProducerServiceConfig {
  nodeEnv: string;
  host: string;
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";

  jwtSecret: string;

  kafka: {
    clientId: string;
    brokers: string[];
    ssl: boolean;
    sasl?: KafkaSaslConfig;
    rawTopic: string;
    errorTopic: string;
    /** `-1` (all) waits for every in-sync replica; the safest ack setting. */
    acks: number;
    retries: number;
    requestTimeoutMs: number;
  };

  maxBatchEvents: number;
  bodyLimitBytes: number;
}

export function loadConfig(): ProducerServiceConfig {
  const nodeEnv = optional("NODE_ENV", "development");
  const isProd = nodeEnv === "production";

  return {
    nodeEnv,
    host: optional("HOST", "0.0.0.0"),
    port: optionalInt("PORT", 8080),
    logLevel: optional("LOG_LEVEL", "info") as ProducerServiceConfig["logLevel"],

    // In development a well-known dev secret keeps `docker compose up` working
    // out of the box; production must supply its own.
    jwtSecret: isProd ? required("JWT_SECRET") : optional("JWT_SECRET", "dev-only-insecure-secret"),

    kafka: {
      clientId: optional("KAFKA_CLIENT_ID", "ide-collector-producer"),
      brokers: optional("KAFKA_BROKERS", "localhost:9092").split(",").map((b) => b.trim()),
      ssl: optionalBool("KAFKA_SSL", false),
      sasl: readSaslConfig(),
      rawTopic: optional("KAFKA_TOPIC_RAW", "ide.events.raw"),
      errorTopic: optional("KAFKA_TOPIC_ERRORS", "ide.events.errors"),
      acks: optionalInt("KAFKA_ACKS", -1),
      retries: optionalInt("KAFKA_RETRIES", 8),
      requestTimeoutMs: optionalInt("KAFKA_REQUEST_TIMEOUT_MS", 30_000),
    },

    maxBatchEvents: optionalInt("MAX_BATCH_EVENTS", 1000),
    bodyLimitBytes: optionalInt("BODY_LIMIT_BYTES", 5 * 1024 * 1024),
  };
}
