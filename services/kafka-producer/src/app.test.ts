import { describe, expect, it, beforeEach } from "vitest";
import jwt from "jsonwebtoken";
import { createEvent, EVENT_TYPES, IDEEvent } from "@ide-collector/event-schema";
import { Logger } from "@ide-collector/shared-utils";
import { buildApp } from "./app";
import { EventPublisher } from "./kafka";
import { ProducerServiceConfig } from "./config";

const JWT_SECRET = "test-secret";
const INSTALLATION_ID = "install-abc";
const USER_ID = "user-abc";

class FakePublisher implements EventPublisher {
  published: IDEEvent[][] = [];
  errors: Record<string, unknown>[] = [];
  connected = true;
  failNext = false;

  async connect() {}
  async disconnect() {}
  isConnected() {
    return this.connected;
  }
  async publish(events: IDEEvent[]) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("broker unavailable");
    }
    this.published.push(events);
  }
  async publishError(record: Record<string, unknown>) {
    this.errors.push(record);
  }
}

const config: ProducerServiceConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  logLevel: "error",
  jwtSecret: JWT_SECRET,
  kafka: {
    clientId: "test",
    brokers: ["localhost:9092"],
    ssl: false,
    rawTopic: "ide.events.raw",
    errorTopic: "ide.events.errors",
    acks: -1,
    retries: 3,
    requestTimeoutMs: 1000,
  },
  maxBatchEvents: 100,
  bodyLimitBytes: 1024 * 1024,
};

function token(overrides: Record<string, unknown> = {}) {
  return jwt.sign({ sub: INSTALLATION_ID, user_id: USER_ID, ...overrides }, JWT_SECRET, {
    algorithm: "HS256",
  });
}

function makeEvent(overrides: Partial<Parameters<typeof createEvent>[0]> = {}) {
  return createEvent({
    eventType: EVENT_TYPES.FILE_SAVED,
    userId: USER_ID,
    installationId: INSTALLATION_ID,
    sessionId: "session-1",
    ide: { name: "vscode", version: "1.90.0" },
    file: { path: "src/index.ts", language: "typescript" },
    ...overrides,
  });
}

describe("ingestion API", () => {
  let publisher: FakePublisher;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    publisher = new FakePublisher();
    app = buildApp({
      config,
      publisher,
      logger: new Logger({ service: "test", level: "error", sink: { write: () => {} } }),
    });
  });

  it("accepts a valid batch and produces it to Kafka", async () => {
    const event = makeEvent();
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token()}` },
      payload: { installation_id: INSTALLATION_ID, events: [event] },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().accepted).toEqual([event.event_id]);
    expect(publisher.published).toHaveLength(1);
    expect(publisher.published[0][0].event_id).toBe(event.event_id);
  });

  it("rejects requests without a token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: { events: [makeEvent()] },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const badToken = jwt.sign({ sub: INSTALLATION_ID, user_id: USER_ID }, "wrong-secret");
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${badToken}` },
      payload: { events: [makeEvent()] },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a batch claiming a different installation_id than the token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token()}` },
      payload: { installation_id: "someone-elses-install", events: [makeEvent()] },
    });
    expect(response.statusCode).toBe(403);
    expect(publisher.published).toHaveLength(0);
  });

  it("overrides client-supplied identity with the token's claims", async () => {
    const spoofed = makeEvent({ userId: "victim-user", installationId: INSTALLATION_ID });
    await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token()}` },
      payload: { events: [spoofed] },
    });
    expect(publisher.published[0][0].user_id).toBe(USER_ID);
    expect(publisher.published[0][0].installation_id).toBe(INSTALLATION_ID);
  });

  it("rejects schema-invalid events with 422 and reports which ones", async () => {
    const bad = { ...makeEvent(), event_type: "not.a.real.type" };
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token()}` },
      payload: { events: [bad] },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().rejected).toContain(bad.event_id);
    expect(publisher.published).toHaveLength(0);
  });

  it("accepts the valid part of a mixed batch", async () => {
    const good = makeEvent();
    const bad = { ...makeEvent(), event_type: "nope" };
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token()}` },
      payload: { events: [good, bad] },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().accepted).toEqual([good.event_id]);
    expect(response.json().rejected).toEqual([bad.event_id]);
  });

  it("redacts secrets that a client failed to redact", async () => {
    const leaky = makeEvent({
      eventType: EVENT_TYPES.TERMINAL_COMMAND_EXECUTED,
      payload: { command: "export AWS_SECRET_ACCESS_KEY=abcdefghijklmnop1234" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token()}` },
      payload: { events: [leaky] },
    });
    const produced = JSON.stringify(publisher.published[0][0].payload);
    expect(produced).not.toContain("abcdefghijklmnop1234");
    expect(produced).toContain("[REDACTED]");
  });

  it("returns 503 when Kafka is unavailable so the client retries", async () => {
    publisher.failNext = true;
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token()}` },
      payload: { events: [makeEvent()] },
    });
    expect(response.statusCode).toBe(503);
  });

  it("rejects oversized batches", async () => {
    const events = Array.from({ length: 101 }, () => makeEvent());
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token()}` },
      payload: { events },
    });
    expect(response.statusCode).toBe(413);
  });

  it("rejects an unsupported schema_version", async () => {
    const future = { ...makeEvent(), schema_version: "99.0.0" };
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token()}` },
      payload: { events: [future] },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().rejected).toContain(future.event_id);
  });
});

describe("operational endpoints", () => {
  it("reports healthy regardless of broker state", async () => {
    const publisher = new FakePublisher();
    publisher.connected = false;
    const app = buildApp({ config, publisher });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
  });

  it("reports not-ready when Kafka is disconnected", async () => {
    const publisher = new FakePublisher();
    publisher.connected = false;
    const app = buildApp({ config, publisher });
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503);
  });

  it("exposes Prometheus metrics", async () => {
    const publisher = new FakePublisher();
    const app = buildApp({ config, publisher });
    await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token()}` },
      payload: { events: [makeEvent()] },
    });
    const response = await app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("ingestion_events_accepted_total");
  });
});
