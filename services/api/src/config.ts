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

export interface ApiServiceConfig {
  nodeEnv: string;
  host: string;
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  jwtSecret: string;
  /** Installation tokens are long-lived but not permanent; extensions re-register on expiry. */
  tokenTtlSeconds: number;
  enrollmentCodeTtlSeconds: number;
  databaseUrl: string;
  databasePoolSize: number;
  /** DATABASE_SSL: disable | require | no-verify | verify. Omit to auto-detect from the host. */
  databaseSslMode?: string;
  /** PEM CA bundle for a provider using a private certificate authority. */
  databaseCaCert?: string;
  /** Guards the operator-only endpoints (enrollment code issuance, revocation). */
  adminApiKey: string;
  /**
   * Development convenience: allow an extension to self-enroll without a
   * pre-issued code. MUST be false in production.
   */
  allowOpenEnrollment: boolean;
}

export function loadConfig(): ApiServiceConfig {
  const nodeEnv = optional("NODE_ENV", "development");
  const isProd = nodeEnv === "production";

  return {
    nodeEnv,
    host: optional("HOST", "0.0.0.0"),
    port: optionalInt("PORT", 8081),
    logLevel: optional("LOG_LEVEL", "info") as ApiServiceConfig["logLevel"],
    jwtSecret: isProd ? required("JWT_SECRET") : optional("JWT_SECRET", "dev-only-insecure-secret"),
    tokenTtlSeconds: optionalInt("TOKEN_TTL_SECONDS", 60 * 60 * 24 * 365),
    enrollmentCodeTtlSeconds: optionalInt("ENROLLMENT_CODE_TTL_SECONDS", 60 * 15),
    databaseUrl: isProd
      ? required("DATABASE_URL")
      : optional("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/ide_events"),
    databasePoolSize: optionalInt("DATABASE_POOL_SIZE", 10),
    databaseSslMode: process.env.DATABASE_SSL,
    databaseCaCert: readCaCertFromEnv(),
    adminApiKey: isProd ? required("ADMIN_API_KEY") : optional("ADMIN_API_KEY", "dev-admin-key"),
    allowOpenEnrollment: isProd ? false : optional("ALLOW_OPEN_ENROLLMENT", "true") === "true",
  };
}
