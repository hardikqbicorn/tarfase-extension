import { describe, expect, it } from "vitest";
import {
  describeDatabaseError,
  parseDatabaseHost,
  parseSslMode,
  readCaCertFromEnv,
  redactDatabaseUrl,
  resolveDatabaseSsl,
} from "./database";

const LOCAL = "postgresql://postgres:postgres@localhost:5432/ide_events";
const DOCKER = "postgresql://postgres:postgres@postgres:5432/ide_events";
const SUPABASE_POOLER =
  "postgresql://postgres.abcdefgh:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres";
const SUPABASE_DIRECT = "postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres";

describe("resolveDatabaseSsl", () => {
  it("disables TLS for localhost", () => {
    expect(resolveDatabaseSsl({ databaseUrl: LOCAL })).toBe(false);
  });

  it("disables TLS for a Docker Compose service name", () => {
    expect(resolveDatabaseSsl({ databaseUrl: DOCKER })).toBe(false);
  });

  it("enables verified TLS for a remote managed database", () => {
    // The regression this guards: TLS used to be gated on NODE_ENV, so a
    // development-mode service pointed at Supabase would connect in plaintext
    // (or fail), depending on nothing to do with the actual target.
    expect(resolveDatabaseSsl({ databaseUrl: SUPABASE_POOLER })).toEqual({
      rejectUnauthorized: true,
    });
    expect(resolveDatabaseSsl({ databaseUrl: SUPABASE_DIRECT })).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("honors an explicit disable override", () => {
    expect(resolveDatabaseSsl({ databaseUrl: SUPABASE_POOLER, mode: "disable" })).toBe(false);
  });

  it("honors require/no-verify as encrypted-but-unverified", () => {
    for (const mode of ["require", "no-verify"]) {
      expect(resolveDatabaseSsl({ databaseUrl: SUPABASE_POOLER, mode })).toEqual({
        rejectUnauthorized: false,
      });
    }
  });

  it("attaches a custom CA when one is supplied", () => {
    const result = resolveDatabaseSsl({
      databaseUrl: SUPABASE_POOLER,
      caCert: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
    });
    expect(result).toMatchObject({ rejectUnauthorized: true });
    expect((result as { ca?: string }).ca).toContain("BEGIN CERTIFICATE");
  });

  it("reads sslmode from the connection string", () => {
    expect(resolveDatabaseSsl({ databaseUrl: `${LOCAL}?sslmode=require` })).toEqual({
      rejectUnauthorized: false,
    });
    expect(resolveDatabaseSsl({ databaseUrl: `${SUPABASE_POOLER}?sslmode=disable` })).toBe(false);
  });

  it("lets an explicit mode win over sslmode in the URL", () => {
    expect(
      resolveDatabaseSsl({ databaseUrl: `${SUPABASE_POOLER}?sslmode=disable`, mode: "verify" })
    ).toEqual({ rejectUnauthorized: true });
  });

  it("falls back safely on an unparseable URL", () => {
    // Unknown host, so it is treated as remote and gets TLS rather than
    // silently connecting in the clear.
    expect(resolveDatabaseSsl({ databaseUrl: "not a url" })).toEqual({
      rejectUnauthorized: true,
    });
  });
});

describe("parseDatabaseHost / parseSslMode", () => {
  it("extracts the host", () => {
    expect(parseDatabaseHost(SUPABASE_POOLER)).toBe("aws-0-ap-south-1.pooler.supabase.com");
  });

  it("extracts sslmode when present", () => {
    expect(parseSslMode(`${LOCAL}?sslmode=require`)).toBe("require");
    expect(parseSslMode(LOCAL)).toBeUndefined();
  });
});

describe("readCaCertFromEnv", () => {
  const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

  it("returns undefined when neither variable is set", () => {
    expect(readCaCertFromEnv({})).toBeUndefined();
  });

  it("reads an inline PEM", () => {
    expect(readCaCertFromEnv({ DATABASE_CA_CERT: PEM })).toBe(PEM);
  });

  it("converts literal backslash-n to real newlines, as a .env file forces", () => {
    const escaped = "-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----";
    expect(readCaCertFromEnv({ DATABASE_CA_CERT: escaped })).toBe(PEM);
  });

  it("reads from a file path", () => {
    const result = readCaCertFromEnv({ DATABASE_CA_CERT_FILE: "/certs/ca.crt" }, (path) => {
      expect(path).toBe("/certs/ca.crt");
      return PEM;
    });
    expect(result).toBe(PEM);
  });

  it("trims whitespace around the path", () => {
    const result = readCaCertFromEnv({ DATABASE_CA_CERT_FILE: "  /certs/ca.crt  " }, (path) => {
      expect(path).toBe("/certs/ca.crt");
      return PEM;
    });
    expect(result).toBe(PEM);
  });

  it("prefers the inline PEM over the file path", () => {
    const result = readCaCertFromEnv(
      { DATABASE_CA_CERT: PEM, DATABASE_CA_CERT_FILE: "/certs/ca.crt" },
      () => {
        throw new Error("should not read the file");
      }
    );
    expect(result).toBe(PEM);
  });

  it("ignores an empty value rather than treating it as a certificate", () => {
    expect(readCaCertFromEnv({ DATABASE_CA_CERT: "   " })).toBeUndefined();
  });

  it("reports the path when the file cannot be read", () => {
    expect(() =>
      readCaCertFromEnv({ DATABASE_CA_CERT_FILE: "/missing/ca.crt" }, () => {
        throw new Error("ENOENT");
      })
    ).toThrow(/\/missing\/ca\.crt/);
  });
});

describe("redactDatabaseUrl", () => {
  it("removes the password so the URL is safe to log", () => {
    const redacted = redactDatabaseUrl(SUPABASE_POOLER);
    expect(redacted).not.toContain("pw@");
    expect(redacted).toContain("***");
    expect(redacted).toContain("aws-0-ap-south-1.pooler.supabase.com");
  });

  it("does not leak an unparseable string", () => {
    expect(redactDatabaseUrl("postgres://bad url with spaces")).toBe(
      "[unparseable connection string]"
    );
  });
});

describe("describeDatabaseError", () => {
  function withCode(message: string, code?: string): Error {
    const err = new Error(message);
    if (code) (err as NodeJS.ErrnoException).code = code;
    return err;
  }

  it("names the IPv6/pooler remedy for the real Supabase-in-Docker failure", () => {
    const described = describeDatabaseError(
      withCode(
        "connect ENETUNREACH 2406:da1c:61c:d600:49ba:908b:bc94:3507:5432 - Local (:::0)",
        "ENETUNREACH"
      )
    );
    expect(described?.remedy).toContain("Session pooler");
    expect(described?.remedy).toContain("IPv6");
    // The summary is client-facing, so it must not carry the address.
    expect(described?.summary).not.toContain("2406");
  });

  it("does not claim IPv6 for an IPv4 unreachable error", () => {
    const described = describeDatabaseError(
      withCode("connect ENETUNREACH 10.0.0.5:5432", "ENETUNREACH")
    );
    expect(described?.remedy).not.toContain("IPv6");
  });

  it("recognises TLS verification failures", () => {
    const described = describeDatabaseError(
      new Error("self-signed certificate in certificate chain")
    );
    expect(described?.remedy).toContain("DATABASE_CA_CERT_FILE");
  });

  it("recognises authentication failures and names the pooler user format", () => {
    const described = describeDatabaseError(new Error("password authentication failed for user"));
    expect(described?.remedy).toContain("postgres.<project-ref>");
  });

  it("recognises refused connections and unresolvable hosts", () => {
    expect(describeDatabaseError(withCode("connect ECONNREFUSED", "ECONNREFUSED"))?.remedy)
      .toContain("6543");
    expect(describeDatabaseError(withCode("getaddrinfo ENOTFOUND db.x", "ENOTFOUND"))?.remedy)
      .toContain("does not resolve");
  });

  it("returns undefined for an unrelated error, so it is not mislabelled", () => {
    expect(describeDatabaseError(new Error("something else entirely"))).toBeUndefined();
  });
});
