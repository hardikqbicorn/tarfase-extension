import { describe, expect, it, beforeEach } from "vitest";
import { createHash } from "crypto";
import jwt from "jsonwebtoken";
import { Logger } from "@ide-collector/shared-utils";
import { buildApiApp } from "./app";
import { InMemoryApiRepository } from "./in-memory-repository";
import { ApiServiceConfig } from "./config";

const ADMIN_KEY = "test-admin-key";
const JWT_SECRET = "test-secret";

const baseConfig: ApiServiceConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  logLevel: "error",
  jwtSecret: JWT_SECRET,
  tokenTtlSeconds: 3600,
  enrollmentCodeTtlSeconds: 900,
  databaseUrl: "memory",
  adminApiKey: ADMIN_KEY,
  allowOpenEnrollment: false,
};

const silentLogger = new Logger({ service: "test", level: "error", sink: { write: () => {} } });

function build(overrides: Partial<ApiServiceConfig> = {}) {
  const repository = new InMemoryApiRepository();
  const app = buildApiApp({
    config: { ...baseConfig, ...overrides },
    repository,
    logger: silentLogger,
  });
  return { app, repository };
}

describe("enrollment codes", () => {
  it("issues a code for an admin caller", async () => {
    const { app } = build();
    const response = await app.inject({
      method: "POST",
      url: "/v1/enrollment-codes",
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { email: "dev@example.com" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().enrollment_code).toBeTruthy();
    expect(response.json().user_id).toBeTruthy();
  });

  it("refuses to issue a code without admin credentials", async () => {
    const { app } = build();
    const response = await app.inject({
      method: "POST",
      url: "/v1/enrollment-codes",
      payload: { email: "dev@example.com" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("stores only the hash of the code, never the plaintext", async () => {
    const { app, repository } = build();
    const response = await app.inject({
      method: "POST",
      url: "/v1/enrollment-codes",
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: {},
    });
    const code = response.json().enrollment_code as string;
    const stored = [...repository.enrollmentCodes.keys()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toBe(code);
    expect(stored[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("installation registration", () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  async function issueCode(): Promise<string> {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/enrollment-codes",
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { email: "dev@example.com" },
    });
    return response.json().enrollment_code;
  }

  it("exchanges a valid code for installation credentials", async () => {
    const code = await issueCode();
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/installations/register",
      payload: { enrollment_code: code, ide_name: "vscode", ide_version: "1.90.0" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.installation_id).toBeTruthy();
    expect(body.installation_token).toBeTruthy();
    expect(body.user_id).toBeTruthy();

    // The token must be verifiable by the ingestion service with sub = installation id.
    const claims = jwt.verify(body.installation_token, JWT_SECRET) as Record<string, unknown>;
    expect(claims.sub).toBe(body.installation_id);
    expect(claims.user_id).toBe(body.user_id);
  });

  it("rejects an unknown enrollment code", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/installations/register",
      payload: { enrollment_code: "not-a-real-code", ide_name: "vscode" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("makes enrollment codes single-use", async () => {
    const code = await issueCode();
    const first = await ctx.app.inject({
      method: "POST",
      url: "/v1/installations/register",
      payload: { enrollment_code: code, ide_name: "vscode" },
    });
    expect(first.statusCode).toBe(201);

    const second = await ctx.app.inject({
      method: "POST",
      url: "/v1/installations/register",
      payload: { enrollment_code: code, ide_name: "vscode" },
    });
    expect(second.statusCode).toBe(401);
  });

  it("rejects an expired enrollment code", async () => {
    const { app, repository } = build({ enrollmentCodeTtlSeconds: -1 });
    const issued = await app.inject({
      method: "POST",
      url: "/v1/enrollment-codes",
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: {},
    });
    expect(repository.enrollmentCodes.size).toBe(1);

    const response = await app.inject({
      method: "POST",
      url: "/v1/installations/register",
      payload: { enrollment_code: issued.json().enrollment_code, ide_name: "vscode" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("requires an enrollment code when open enrollment is disabled", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/installations/register",
      payload: { ide_name: "vscode" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("allows codeless registration only when open enrollment is on (dev mode)", async () => {
    const { app } = build({ allowOpenEnrollment: true });
    const response = await app.inject({
      method: "POST",
      url: "/v1/installations/register",
      payload: { ide_name: "vscode" },
    });
    expect(response.statusCode).toBe(201);
  });

  it("requires ide_name", async () => {
    const { app } = build({ allowOpenEnrollment: true });
    const response = await app.inject({
      method: "POST",
      url: "/v1/installations/register",
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it("stores the hash of the token it actually issued", async () => {
    // Regression guard: an earlier version signed a placeholder token, stored
    // its hash, then re-signed with the real installation id - leaving the
    // stored hash pointing at a token that was never issued, so revocation
    // lookup and audit by token hash could never match.
    const code = await issueCode();
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/installations/register",
      payload: { enrollment_code: code, ide_name: "vscode" },
    });

    const body = response.json();
    const expectedHash = createHash("sha256").update(body.installation_token).digest("hex");
    const stored = ctx.repository.installationTokenHashes.get(body.installation_id);

    expect(stored).toBe(expectedHash);
  });

  it("issues a token whose subject is the persisted installation id", async () => {
    const code = await issueCode();
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/installations/register",
      payload: { enrollment_code: code, ide_name: "vscode" },
    });

    const body = response.json();
    const claims = jwt.verify(body.installation_token, JWT_SECRET) as Record<string, unknown>;
    expect(claims.sub).toBe(body.installation_id);
    expect(ctx.repository.installations.has(body.installation_id)).toBe(true);
  });

  it("never stores the plaintext installation token", async () => {
    const code = await issueCode();
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/installations/register",
      payload: { enrollment_code: code, ide_name: "vscode" },
    });
    const token = response.json().installation_token as string;
    const serializedState = JSON.stringify([...ctx.repository.installations.values()]);
    expect(serializedState).not.toContain(token);
  });
});

describe("revocation", () => {
  it("revokes an installation for an admin caller", async () => {
    const { app } = build({ allowOpenEnrollment: true });
    const registered = await app.inject({
      method: "POST",
      url: "/v1/installations/register",
      payload: { ide_name: "vscode" },
    });
    const installationId = registered.json().installation_id;

    const response = await app.inject({
      method: "POST",
      url: `/v1/installations/${installationId}/revoke`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(response.statusCode).toBe(200);

    const repeat = await app.inject({
      method: "POST",
      url: `/v1/installations/${installationId}/revoke`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(repeat.statusCode).toBe(404);
  });

  it("refuses revocation without admin credentials", async () => {
    const { app } = build();
    const response = await app.inject({
      method: "POST",
      url: "/v1/installations/some-id/revoke",
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("database outage handling", () => {
  /** Reproduces the real failure: an IPv6-only Supabase host from a container. */
  function unreachableError(): Error {
    const err = new Error(
      "connect ENETUNREACH 2406:da1c:61c:d600:49ba:908b:bc94:3507:5432 - Local (:::0)"
    );
    (err as NodeJS.ErrnoException).code = "ENETUNREACH";
    return err;
  }

  it("returns 503, not 500, when the database is unreachable", async () => {
    const { app, repository } = build({ allowOpenEnrollment: true });
    repository.findOrCreateUser = async () => {
      throw unreachableError();
    };

    const response = await app.inject({
      method: "POST",
      url: "/v1/installations/register",
      payload: { ide_name: "vscode" },
    });

    // 503 tells the extension this is transient and worth retrying; the old
    // behavior was a 500, which reads as "your request is broken".
    expect(response.statusCode).toBe(503);
  });

  it("never leaks the database address to the client", async () => {
    const { app, repository } = build({ allowOpenEnrollment: true });
    repository.findOrCreateUser = async () => {
      throw unreachableError();
    };

    const response = await app.inject({
      method: "POST",
      url: "/v1/installations/register",
      payload: { ide_name: "vscode" },
    });

    // An IDE extension has no business seeing the database host or IP.
    expect(response.body).not.toContain("2406:da1c");
    expect(response.body).not.toContain("ENETUNREACH");
    expect(response.json().error).toContain("cannot reach the database");
  });

  it("does not leak internals for a non-database failure either", async () => {
    const { app, repository } = build({ allowOpenEnrollment: true });
    repository.findOrCreateUser = async () => {
      throw new Error("secret internal detail");
    };

    const response = await app.inject({
      method: "POST",
      url: "/v1/installations/register",
      payload: { ide_name: "vscode" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("secret internal detail");
  });
});

describe("operational endpoints", () => {
  it("is healthy even when the database is down", async () => {
    const { app, repository } = build();
    repository.healthy = false;
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
  });

  it("is not ready when the database is down", async () => {
    const { app, repository } = build();
    repository.healthy = false;
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503);
  });

  it("requires admin credentials to query events", async () => {
    const { app } = build();
    const response = await app.inject({ method: "GET", url: "/v1/events" });
    expect(response.statusCode).toBe(401);
  });
});
