/**
 * Database connection helpers shared by the API and consumer services.
 *
 * TLS is decided from the connection target, NOT from NODE_ENV. Tying it to
 * NODE_ENV is a trap: pointing a development-mode service at a managed
 * database (Supabase, RDS, Neon) would silently disable TLS, and the
 * connection would simply be refused - or worse, succeed in plaintext.
 */

export interface DatabaseSslOptions {
  rejectUnauthorized: boolean;
  ca?: string;
}

export type ResolvedDatabaseSsl = false | DatabaseSslOptions;

export interface ResolveSslInput {
  databaseUrl: string;
  /**
   * Explicit override, from DATABASE_SSL:
   *   "disable"    - no TLS (local development only)
   *   "require"    - TLS, certificate not verified
   *   "no-verify"  - alias for "require"
   *   "verify"     - TLS with full certificate verification (default for remote hosts)
   * Omit to auto-detect from the host.
   */
  mode?: string;
  /** PEM certificate authority, from DATABASE_CA_CERT. Implies verification. */
  caCert?: string;
}

/** Hosts that are unambiguously local, where plaintext is acceptable. */
function isLocalHost(host: string): boolean {
  if (!host) return false;
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "localhost" || bare === "127.0.0.1" || bare === "::1") return true;
  // Docker Compose service names ("postgres", "db") have no dots and are not
  // public DNS, so they are treated as local.
  if (!bare.includes(".") && !bare.includes(":")) return true;
  return false;
}

export function parseDatabaseHost(databaseUrl: string): string {
  try {
    return new URL(databaseUrl).hostname;
  } catch {
    return "";
  }
}

/** Reads `sslmode` from the connection string's query parameters, if present. */
export function parseSslMode(databaseUrl: string): string | undefined {
  try {
    return new URL(databaseUrl).searchParams.get("sslmode") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decides the `ssl` option to hand to `pg.Pool`.
 *
 * Precedence: explicit DATABASE_SSL > sslmode in the URL > host-based
 * auto-detection (remote hosts get verified TLS, local hosts get none).
 */
export function resolveDatabaseSsl(input: ResolveSslInput): ResolvedDatabaseSsl {
  const { databaseUrl, caCert } = input;
  const mode = (input.mode ?? parseSslMode(databaseUrl) ?? "").toLowerCase();

  if (mode === "disable") return false;

  if (mode === "require" || mode === "no-verify" || mode === "prefer") {
    // libpq's "require" encrypts but does not verify the certificate chain.
    return { rejectUnauthorized: false };
  }

  if (mode === "verify" || mode === "verify-ca" || mode === "verify-full") {
    return { rejectUnauthorized: true, ...(caCert ? { ca: caCert } : {}) };
  }

  // No explicit mode: decide from the host.
  const host = parseDatabaseHost(databaseUrl);
  if (isLocalHost(host)) return false;

  // Remote database: verify by default. A managed provider using a private CA
  // needs DATABASE_CA_CERT, or DATABASE_SSL=require to skip verification.
  return { rejectUnauthorized: true, ...(caCert ? { ca: caCert } : {}) };
}

/** Redacts the password so a connection string is safe to log. */
export function redactDatabaseUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "[unparseable connection string]";
  }
}
