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

/**
 * A PEM pasted into a .env file cannot contain real newlines, so it arrives
 * with literal backslash-n sequences. Node's TLS stack needs real ones.
 */
export function normalizePem(value: string): string {
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

/**
 * Reads the CA certificate from the environment.
 *
 * `DATABASE_CA_CERT_FILE` (a path) is the ergonomic form - providers hand you
 * a .crt download, and a multi-line PEM does not belong in a .env file.
 * `DATABASE_CA_CERT` holds the PEM inline for deployments that inject secrets
 * as environment variables rather than files.
 */
export function readCaCertFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (path) =>
    // Required lazily so this module stays importable where fs is unavailable.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require("fs") as typeof import("fs")).readFileSync(path, "utf8")
): string | undefined {
  const inline = env.DATABASE_CA_CERT;
  if (inline && inline.trim()) return normalizePem(inline);

  const path = env.DATABASE_CA_CERT_FILE;
  if (path && path.trim()) {
    try {
      return readFile(path.trim());
    } catch (err) {
      throw new Error(
        `Could not read DATABASE_CA_CERT_FILE at "${path}": ` +
          (err instanceof Error ? err.message : String(err))
      );
    }
  }

  return undefined;
}

export interface DatabaseErrorDescription {
  /** Short reason, safe to return to a client. */
  summary: string;
  /** Operator-facing remedy. Logged, never returned to a client. */
  remedy: string;
}

/**
 * Maps a driver-level connection failure to a human remedy.
 *
 * Raw driver errors are actively misleading here: an IPv6-only Supabase host
 * surfaces as `ENETUNREACH <ipv6>:5432`, which reads like a network outage
 * rather than "this host has no A record and containers have no IPv6". The
 * remedies below name the actual fix.
 *
 * The summary is deliberately generic - it is safe to return to an extension -
 * while the remedy (which can name hosts and addresses) is for logs only.
 */
export function describeDatabaseError(err: unknown): DatabaseErrorDescription | undefined {
  const code = (err as { code?: string })?.code ?? "";
  const message = err instanceof Error ? err.message : String(err ?? "");

  if (code === "ENETUNREACH" || code === "EHOSTUNREACH" || /ENETUNREACH|EHOSTUNREACH/.test(message)) {
    const looksIpv6 = /:[0-9a-f]*:[0-9a-f]*:/i.test(message);
    return {
      summary: "The service cannot reach the database.",
      remedy: looksIpv6
        ? [
            "The database resolved to an IPv6 address and this host has no IPv6 route.",
            "Docker containers have no IPv6 by default, which is why this works from",
            "your shell but not from a container.",
            "",
            "Fix: use Supabase's Session pooler (IPv4) in DATABASE_URL:",
            "  Project Settings -> Database -> Connection string -> Session pooler",
            "  postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres",
            "The user becomes postgres.<project-ref>, not plain postgres.",
          ].join("\n")
        : "The database host is unreachable from this network.",
    };
  }

  if (code === "ENOTFOUND" || /ENOTFOUND|EAI_AGAIN/.test(message)) {
    return {
      summary: "The service cannot resolve the database host.",
      remedy: "DATABASE_URL names a host that does not resolve. Check it for typos.",
    };
  }

  if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(message)) {
    return {
      summary: "The database refused the connection.",
      remedy:
        "Nothing is listening there. Against Supabase this is usually the wrong port " +
        "(5432 direct/session pooler, 6543 transaction pooler) or a paused project.",
    };
  }

  if (/self.signed|unable to verify|certificate/i.test(message)) {
    return {
      summary: "The service could not establish a secure database connection.",
      remedy: [
        "TLS certificate verification failed. Supabase signs its database",
        "certificates with its own CA, which is not in the system trust store.",
        "Set DATABASE_CA_CERT_FILE to the downloaded CA (Project Settings ->",
        "Database -> SSL configuration), or DATABASE_SSL=require to skip",
        "verification.",
      ].join("\n"),
    };
  }

  if (/password authentication failed|SASL|SCRAM/i.test(message)) {
    return {
      summary: "The service could not authenticate to the database.",
      remedy:
        "Check the password in DATABASE_URL. With the pooler the user must be " +
        "postgres.<project-ref>. Percent-encode special characters (@ -> %40).",
    };
  }

  if (/timeout|ETIMEDOUT/i.test(message)) {
    return {
      summary: "The database connection timed out.",
      remedy: "The host may be firewalled, paused, or unreachable from this network.",
    };
  }

  return undefined;
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
