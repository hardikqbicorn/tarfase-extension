import { describe, expect, it, beforeEach } from "vitest";
import { createEvent, EVENT_TYPES, IDEEvent } from "@ide-collector/event-schema";
import { Logger } from "@ide-collector/shared-utils";
import { EventProcessor, RawMessage } from "./processor";
import { InMemoryEventStore } from "./in-memory-store";
import { createConsumerMetrics } from "./metrics";

const silentLogger = new Logger({ service: "test", level: "error", sink: { write: () => {} } });

function makeEvent(overrides: Partial<Parameters<typeof createEvent>[0]> = {}): IDEEvent {
  return createEvent({
    eventType: EVENT_TYPES.FILE_SAVED,
    userId: "user-1",
    installationId: "install-1",
    sessionId: "session-1",
    ide: { name: "vscode", version: "1.90.0" },
    file: { path: "src/index.ts", language: "typescript" },
    ...overrides,
  });
}

function asMessage(value: unknown, offset = "0"): RawMessage {
  return {
    value: typeof value === "string" ? value : JSON.stringify(value),
    topic: "ide.events.raw",
    partition: 0,
    offset,
  };
}

describe("EventProcessor", () => {
  let store: InMemoryEventStore;
  let processor: EventProcessor;

  beforeEach(() => {
    store = new InMemoryEventStore();
    processor = new EventProcessor({
      store,
      logger: silentLogger,
      metrics: createConsumerMetrics(),
    });
  });

  it("persists a valid event", async () => {
    const event = makeEvent();
    const result = await processor.processBatch([asMessage(event)]);

    expect(result.persisted).toBe(1);
    expect(result.failed).toBe(0);
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0].event_id).toBe(event.event_id);
  });

  it("is idempotent: redelivering the same event creates no duplicate", async () => {
    const event = makeEvent();
    const first = await processor.processBatch([asMessage(event)]);
    const second = await processor.processBatch([asMessage(event)]);

    expect(first.persisted).toBe(1);
    expect(second.persisted).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(store.all()).toHaveLength(1);
  });

  it("collapses duplicates that arrive within a single batch", async () => {
    const event = makeEvent();
    const result = await processor.processBatch([
      asMessage(event, "0"),
      asMessage(event, "1"),
      asMessage(event, "2"),
    ]);

    expect(result.persisted).toBe(1);
    expect(result.duplicates).toBe(2);
    expect(store.all()).toHaveLength(1);
  });

  it("routes malformed JSON to the error path without losing the batch", async () => {
    const good = makeEvent();
    const result = await processor.processBatch([
      asMessage("{ not json"),
      asMessage(good, "1"),
    ]);

    expect(result.persisted).toBe(1);
    expect(result.failed).toBe(1);
    expect(store.errors[0].stage).toBe("validation");
    expect(store.all()).toHaveLength(1);
  });

  it("routes schema-invalid events to the error path", async () => {
    const invalid = { ...makeEvent(), event_type: "not.a.known.type" };
    const result = await processor.processBatch([asMessage(invalid)]);

    expect(result.persisted).toBe(0);
    expect(result.failed).toBe(1);
    expect(store.errors[0].message).toContain("schema validation");
    expect(store.errors[0].eventId).toBe(invalid.event_id);
  });

  it("rejects an unsupported schema version", async () => {
    const future = { ...makeEvent(), schema_version: "42.0.0" };
    const result = await processor.processBatch([asMessage(future)]);

    expect(result.failed).toBe(1);
    expect(store.errors[0].message).toContain("Unsupported schema_version");
  });

  it("handles an empty message value", async () => {
    const result = await processor.processBatch([
      { value: null, topic: "ide.events.raw", partition: 0, offset: "0" },
    ]);
    expect(result.failed).toBe(1);
    expect(store.errors[0].message).toBe("Empty message value");
  });

  it("redacts secrets that reached Kafka before persisting", async () => {
    // Simulates an older/compromised extension bypassing client-side redaction.
    const leaky = makeEvent({
      eventType: EVENT_TYPES.TERMINAL_COMMAND_EXECUTED,
      payload: { command: "DATABASE_PASSWORD=supersecret123 psql" },
    });
    await processor.processBatch([asMessage(leaky)]);

    const stored = JSON.stringify(store.all()[0].payload);
    expect(stored).not.toContain("supersecret123");
    expect(stored).toContain("[REDACTED]");
  });

  it("enriches events with Kafka provenance metadata", async () => {
    await processor.processBatch([asMessage(makeEvent(), "42")]);
    const stored = store.all()[0];
    const ingest = (stored.metadata as any)._ingest;
    expect(ingest.topic).toBe("ide.events.raw");
    expect(ingest.partition).toBe(0);
    expect(ingest.offset).toBe("42");
    expect(ingest.processed_at).toBeTruthy();
  });

  it("throws on a database outage so Kafka redelivers the batch", async () => {
    store.failNextWrite = true;
    await expect(processor.processBatch([asMessage(makeEvent())])).rejects.toThrow(
      "database unavailable"
    );
    expect(store.all()).toHaveLength(0);
  });

  it("persists the batch on redelivery after a transient outage", async () => {
    const event = makeEvent();
    store.failNextWrite = true;
    await expect(processor.processBatch([asMessage(event)])).rejects.toThrow();

    const retry = await processor.processBatch([asMessage(event)]);
    expect(retry.persisted).toBe(1);
    expect(store.all()).toHaveLength(1);
  });

  it("publishes failures to the dead-letter topic when configured", async () => {
    const dlq: Record<string, unknown>[] = [];
    const withDlq = new EventProcessor({
      store,
      logger: silentLogger,
      metrics: createConsumerMetrics(),
      publishToErrorTopic: async (record) => {
        dlq.push(record);
      },
    });

    await withDlq.processBatch([asMessage("{ broken")]);
    expect(dlq).toHaveLength(1);
    expect(dlq[0].stage).toBe("validation");
  });

  it("does not fail the batch when error recording itself fails", async () => {
    const brokenStore = new InMemoryEventStore();
    brokenStore.recordErrors = async () => {
      throw new Error("errors table unavailable");
    };
    const resilient = new EventProcessor({
      store: brokenStore,
      logger: silentLogger,
      metrics: createConsumerMetrics(),
    });

    const good = makeEvent();
    const result = await resilient.processBatch([asMessage("{ broken"), asMessage(good, "1")]);
    expect(result.persisted).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("processes a mixed batch of many events", async () => {
    const messages = [
      ...Array.from({ length: 20 }, (_, i) => asMessage(makeEvent({ payload: { i } }), String(i))),
      asMessage("{ broken", "20"),
      asMessage({ ...makeEvent(), event_type: "bogus" }, "21"),
    ];
    const result = await processor.processBatch(messages);

    expect(result.received).toBe(22);
    expect(result.persisted).toBe(20);
    expect(result.failed).toBe(2);
  });

  it("records metrics for processed events", async () => {
    const metrics = createConsumerMetrics();
    const instrumented = new EventProcessor({ store, logger: silentLogger, metrics });
    await instrumented.processBatch([asMessage(makeEvent())]);

    expect(metrics.eventsReceived.get()).toBe(1);
    expect(metrics.eventsPersisted.get()).toBe(1);
    const exposed = metrics.registry.expose();
    expect(exposed).toContain("consumer_events_persisted_total");
  });
});
