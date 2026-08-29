import { createHash, randomBytes, timingSafeEqual } from "crypto";
import Fastify, { FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { Logger, MetricsRegistry } from "@ide-collector/shared-utils";
import { ApiServiceConfig } from "./config";
import { ApiRepository } from "./repository";

export interface ApiAppDependencies {
  config: ApiServiceConfig;
  repository: ApiRepository;
  logger?: Logger;
}

/** Enrollment codes and installation tokens are only ever stored hashed. */
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function buildApiApp(deps: ApiAppDependencies): FastifyInstance {
  const { config, repository } = deps;
  const logger = deps.logger ?? new Logger({ service: "api", level: config.logLevel });

  const registry = new MetricsRegistry();
  const registrations = registry.counter(
    "api_installations_registered_total",
    "Installations successfully registered"
  );
  const registrationFailures = registry.counter(
    "api_registration_failures_total",
    "Failed installation registration attempts"
  );
  const revocations = registry.counter(
    "api_installations_revoked_total",
    "Installations revoked"
  );

  const app = Fastify({ logger: false, trustProxy: true });

  const requireAdmin = (header: string | undefined): boolean => {
    if (!header) return false;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    const provided = match ? match[1] : header.trim();
    return constantTimeEquals(provided, config.adminApiKey);
  };

  // ---------------------------------------------------------------------------
  // Operational endpoints
  // ---------------------------------------------------------------------------
  app.get("/health", async () => ({ status: "ok", service: "api" }));

  app.get("/ready", async (_request, reply) => {
    const dbOk = await repository.healthCheck();
    reply.code(dbOk ? 200 : 503);
    return { status: dbOk ? "ready" : "not-ready", database: dbOk };
  });

  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4");
    return registry.expose();
  });

  // ---------------------------------------------------------------------------
  // Enrollment code issuance (operator/console endpoint)
  // ---------------------------------------------------------------------------
  app.post("/v1/enrollment-codes", async (request, reply) => {
    if (!requireAdmin(request.headers.authorization)) {
      reply.code(401);
      return { error: "Admin credentials required" };
    }

    const body = (request.body ?? {}) as { email?: string; external_id?: string };
    const user = await repository.findOrCreateUser(body.email ?? null, body.external_id ?? null);

    // 32 bytes of entropy, shown to the operator exactly once.
    const code = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + config.enrollmentCodeTtlSeconds * 1000);
    await repository.createEnrollmentCode(user.id, sha256(code), expiresAt);

    reply.code(201);
    return {
      enrollment_code: code,
      user_id: user.id,
      expires_at: expiresAt.toISOString(),
    };
  });

  // ---------------------------------------------------------------------------
  // Installation registration
  //
  //   Extension -> POST /v1/installations/register (enrollment_code)
  //             <- { installation_id, installation_token, user_id }
  //
  // The plaintext token is returned once and never stored; only its hash is
  // persisted, so a database compromise cannot yield usable credentials.
  // ---------------------------------------------------------------------------
  app.post("/v1/installations/register", async (request, reply) => {
    const body = (request.body ?? {}) as {
      enrollment_code?: string;
      ide_name?: string;
      ide_version?: string;
      extension_version?: string;
      machine_id?: string;
      platform?: string;
      email?: string;
    };

    if (!body.ide_name) {
      registrationFailures.inc({ reason: "missing_ide_name" });
      reply.code(400);
      return { error: "ide_name is required" };
    }

    let userId: string | undefined;

    if (body.enrollment_code) {
      const record = await repository.consumeEnrollmentCode(sha256(body.enrollment_code));
      if (!record) {
        registrationFailures.inc({ reason: "invalid_code" });
        logger.warn("registration rejected: invalid or expired enrollment code");
        reply.code(401);
        return { error: "Invalid, expired, or already-used enrollment code" };
      }
      userId = record.user_id;
    } else if (config.allowOpenEnrollment) {
      // Development mode only: mint a user on the fly so `docker compose up`
      // gives a working end-to-end path with no manual setup.
      const user = await repository.findOrCreateUser(body.email ?? null, null);
      userId = user.id;
      logger.warn("open enrollment used - this must be disabled in production");
    } else {
      registrationFailures.inc({ reason: "missing_code" });
      reply.code(401);
      return { error: "enrollment_code is required" };
    }

    // The token is a JWT so the ingestion service can verify it statelessly;
    // its hash is stored so it can be revoked and audited.
    const installationToken = jwt.sign({ user_id: userId }, config.jwtSecret, {
      algorithm: "HS256",
      expiresIn: config.tokenTtlSeconds,
      subject: "pending",
    });

    const installation = await repository.createInstallation({
      userId: userId!,
      ideName: body.ide_name,
      ideVersion: body.ide_version,
      extensionVersion: body.extension_version,
      machineId: body.machine_id,
      platform: body.platform,
      tokenHash: sha256(installationToken),
    });

    // Re-sign with the real installation id now that the row exists, so the
    // ingestion service can trust `sub` as the installation identity.
    const finalToken = jwt.sign(
      { user_id: userId, ide_name: body.ide_name },
      config.jwtSecret,
      { algorithm: "HS256", expiresIn: config.tokenTtlSeconds, subject: installation.id }
    );

    registrations.inc({ ide_name: body.ide_name });
    logger.info("installation registered", {
      installation_id: installation.id,
      ide_name: body.ide_name,
    });

    reply.code(201);
    return {
      installation_id: installation.id,
      installation_token: finalToken,
      user_id: userId,
      expires_in: config.tokenTtlSeconds,
    };
  });

  // ---------------------------------------------------------------------------
  // Revocation
  // ---------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    "/v1/installations/:id/revoke",
    async (request, reply) => {
      if (!requireAdmin(request.headers.authorization)) {
        reply.code(401);
        return { error: "Admin credentials required" };
      }
      const revoked = await repository.revokeInstallation(request.params.id);
      if (!revoked) {
        reply.code(404);
        return { error: "Installation not found or already revoked" };
      }
      revocations.inc();
      return { status: "revoked", installation_id: request.params.id };
    }
  );

  // ---------------------------------------------------------------------------
  // Event query (verification/debugging; dashboards read Supabase directly)
  // ---------------------------------------------------------------------------
  app.get("/v1/events", async (request, reply) => {
    if (!requireAdmin(request.headers.authorization)) {
      reply.code(401);
      return { error: "Admin credentials required" };
    }
    const query = request.query as Record<string, string | undefined>;
    const limit = Math.min(Number.parseInt(query.limit ?? "50", 10) || 50, 500);

    const events = await repository.queryEvents({
      userId: query.user_id,
      installationId: query.installation_id,
      sessionId: query.session_id,
      eventType: query.event_type,
      since: query.since,
      limit,
    });
    return { count: events.length, events };
  });

  return app;
}
