import Fastify, { FastifyInstance } from "fastify";
import { validateEvent, isSupportedSchemaVersion, IDEEvent } from "@ide-collector/event-schema";
import { Redactor } from "@ide-collector/crypto";
import { Logger, MetricsRegistry } from "@ide-collector/shared-utils";
import { ProducerServiceConfig } from "./config";
import { EventPublisher } from "./kafka";
import { AuthError, verifyInstallationToken } from "./auth";

export interface AppDependencies {
  config: ProducerServiceConfig;
  publisher: EventPublisher;
  logger?: Logger;
  redactor?: Redactor;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const { config, publisher } = deps;
  const logger = deps.logger ?? new Logger({ service: "kafka-producer", level: config.logLevel });
  const redactor = deps.redactor ?? new Redactor();

  const registry = new MetricsRegistry();
  const eventsReceived = registry.counter(
    "ingestion_events_received_total",
    "Events received by the ingestion API"
  );
  const eventsAccepted = registry.counter(
    "ingestion_events_accepted_total",
    "Events successfully produced to Kafka"
  );
  const eventsRejected = registry.counter(
    "ingestion_events_rejected_total",
    "Events rejected as invalid"
  );
  const batchesFailed = registry.counter(
    "ingestion_batches_failed_total",
    "Batches that could not be produced to Kafka"
  );
  const produceLatency = registry.histogram(
    "ingestion_produce_duration_ms",
    "Kafka produce latency in milliseconds"
  );
  const requestLatency = registry.histogram(
    "ingestion_request_duration_ms",
    "End-to-end ingestion request latency in milliseconds"
  );

  const app = Fastify({
    logger: false,
    bodyLimit: config.bodyLimitBytes,
    trustProxy: true,
  });

  // ---------------------------------------------------------------------------
  // Health / readiness / metrics
  // ---------------------------------------------------------------------------

  // Liveness: is the process up? Never depends on downstreams, so a broker
  // outage does not cause the orchestrator to kill an otherwise healthy pod.
  app.get("/health", async () => ({ status: "ok", service: "kafka-producer" }));

  // Readiness: should this instance receive traffic? Requires a live broker
  // connection, because without one we cannot durably accept events.
  app.get("/ready", async (_request, reply) => {
    const ready = publisher.isConnected();
    reply.code(ready ? 200 : 503);
    return { status: ready ? "ready" : "not-ready", kafka_connected: publisher.isConnected() };
  });

  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4");
    return registry.expose();
  });

  // ---------------------------------------------------------------------------
  // Ingestion
  // ---------------------------------------------------------------------------
  app.post("/v1/events", async (request, reply) => {
    const startedAt = Date.now();

    let claims;
    try {
      claims = verifyInstallationToken(request.headers.authorization, config.jwtSecret);
    } catch (err) {
      const status = err instanceof AuthError ? err.statusCode : 401;
      reply.code(status);
      return { error: err instanceof Error ? err.message : "Unauthorized" };
    }

    const body = request.body as { installation_id?: string; events?: unknown[] } | undefined;
    if (!body || !Array.isArray(body.events)) {
      reply.code(400);
      return { error: "Request body must include an `events` array" };
    }

    if (body.events.length === 0) {
      return { accepted: [], rejected: [] };
    }

    if (body.events.length > config.maxBatchEvents) {
      reply.code(413);
      return { error: `Batch exceeds max of ${config.maxBatchEvents} events` };
    }

    // The token's installation_id is authoritative; a batch claiming a
    // different installation is a spoofing attempt.
    if (body.installation_id && body.installation_id !== claims.sub) {
      reply.code(403);
      return { error: "installation_id does not match the authenticated installation" };
    }

    eventsReceived.inc({}, body.events.length);

    const valid: IDEEvent[] = [];
    const rejected: string[] = [];
    const rejectionDetails: Array<{ event_id?: string; errors: string[] }> = [];

    for (const candidate of body.events) {
      const result = validateEvent(candidate);
      const candidateId = (candidate as { event_id?: string })?.event_id;

      if (!result.valid || !result.event) {
        if (candidateId) rejected.push(candidateId);
        rejectionDetails.push({ event_id: candidateId, errors: result.errors ?? ["invalid event"] });
        continue;
      }

      if (!isSupportedSchemaVersion(result.event.schema_version)) {
        rejected.push(result.event.event_id);
        rejectionDetails.push({
          event_id: result.event.event_id,
          errors: [`Unsupported schema_version: ${result.event.schema_version}`],
        });
        continue;
      }

      // Stamp server-authoritative identity so a compromised extension cannot
      // attribute events to another user or installation.
      const event: IDEEvent = {
        ...result.event,
        installation_id: claims.sub,
        user_id: claims.user_id,
      };

      // Second redaction pass at the trust boundary: even if an extension
      // build skipped client-side redaction, secrets never reach Kafka.
      valid.push(redactor.redactEvent(event));
    }

    if (rejected.length > 0) {
      eventsRejected.inc({}, rejected.length);
      logger.warn("rejected invalid events", {
        installation_id: claims.sub,
        count: rejected.length,
        sample: rejectionDetails.slice(0, 3),
      });
      // Best-effort: record why events were dropped, but never fail the
      // request because the error topic is unavailable.
      void publisher
        .publishError({
          stage: "ingestion-validation",
          installation_id: claims.sub,
          rejected: rejectionDetails.slice(0, 50),
          occurred_at: new Date().toISOString(),
        })
        .catch(() => undefined);
    }

    if (valid.length === 0) {
      requestLatency.observe(Date.now() - startedAt);
      reply.code(rejected.length > 0 ? 422 : 200);
      return { accepted: [], rejected };
    }

    const produceStartedAt = Date.now();
    try {
      await publisher.publish(valid);
    } catch (err) {
      batchesFailed.inc();
      logger.error("failed to produce batch to kafka", {
        installation_id: claims.sub,
        count: valid.length,
        error: err instanceof Error ? err.message : String(err),
      });
      // 503 tells the extension to keep the events buffered and retry.
      reply.code(503);
      return { error: "Ingestion temporarily unavailable; retry later" };
    }

    produceLatency.observe(Date.now() - produceStartedAt);
    eventsAccepted.inc({}, valid.length);
    requestLatency.observe(Date.now() - startedAt);

    logger.debug("accepted batch", {
      installation_id: claims.sub,
      accepted: valid.length,
      rejected: rejected.length,
    });

    reply.code(202);
    return { accepted: valid.map((e) => e.event_id), rejected };
  });

  return app;
}
