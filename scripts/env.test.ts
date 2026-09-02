import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadDotEnv } from "./env";

describe("loadDotEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("strips inline comments from unquoted values and keeps the last assignment", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-loader-"));

    try {
      writeFileSync(
        join(dir, ".env"),
        [
          "DATABASE_URL=postgresql://user:pass@host:5432/db # first comment",
          "DATABASE_CA_CERT_FILE=./certs/supabase-ca.crt      # host commands",
          "DATABASE_CA_CERT_FILE=/app/certs/supabase-ca.crt   # Dockerised services",
        ].join("\n"),
      );

      loadDotEnv(join(dir, ".env"));

      expect(process.env.DATABASE_URL).toBe(
        "postgresql://user:pass@host:5432/db",
      );
      expect(process.env.DATABASE_CA_CERT_FILE).toBe(
        "/app/certs/supabase-ca.crt",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves quoted values containing # characters", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-loader-"));

    try {
      writeFileSync(
        join(dir, ".env"),
        'PASSWORD="abc#123" # comment\nDATABASE_CA_CERT_FILE="./certs/supabase-ca.crt" # host command',
      );

      loadDotEnv(join(dir, ".env"));

      expect(process.env.PASSWORD).toBe("abc#123");
      expect(process.env.DATABASE_CA_CERT_FILE).toBe("./certs/supabase-ca.crt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
