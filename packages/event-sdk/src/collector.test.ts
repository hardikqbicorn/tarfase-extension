import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EVENT_TYPES, IDEEvent, validateEvent } from "@ide-collector/event-schema";
import { Logger } from "@ide-collector/shared-utils";
import { EventCollector } from "./collector";
import { EventQueue } from "./queue";
import { InMemoryQueuePersistence } from "./persistence";
import { mergeConfig } from "./config";
import { EventTransport, TransportError, TransportResult } from "./transport";
import { ContextProvider } from "./context";

class FakeTransport implements EventTransport {
  sent: IDEEvent[][] = [];
  failNext = 0;
  rejectIds: string[] = [];

  async send(events: IDEEvent[]): Promise<TransportResult> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new TransportError("network down", undefined, true);
    }
    this.sent.push(events);
    const rejected = events.filter((e) => this.rejectIds.includes(e.event_id)).map((e) => e.event_id);
    return {
      accepted: events.filter((e) => !rejected.includes(e.event_id)).map((e) => e.event_id),
      rejected,
    };
  }
}

const contextProvider: ContextProvider = {
  getContext: () => ({
    ide: { name: "vscode", version: "1.90.0" },
    workspace: { id: "ws-1", name: "my-workspace" },
    project: { id: "proj-1", name: "my-project" },
    repository: { id: "repo-1", name: "my-repo", branch: "main" },
  }),
};

async function buildCollector(overrides: Parameters<typeof mergeConfig>[0] = {}) {
  const persistence = new InMemoryQueuePersistence();
  const queue = new EventQueue({ maxQueueSize: 100, persistence });
  const transport = new FakeTransport();
  const collector = new EventCollector({
    config: mergeConfig({ enabled: true, batchSize: 10, flushIntervalMs: 60_000, ...overrides }),
    identity: { userId: "user-1", installationId: "install-1", sessionId: "session-1" },
    contextProvider,
    queue,
    transport,
    logger: new Logger({ service: "test", level: "error", sink: { write: () => {} } }),
  });
  await collector.start();
  return { collector, queue, transport, persistence };
}

describe("EventCollector capture", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("normalizes a capture call into a valid canonical event", async () => {
    const { collector } = await buildCollector();
    const event = collector.capture({
      eventType: EVENT_TYPES.FILE_SAVED,
      file: { path: "src/index.ts", language: "typescript" },
      payload: { lineCount: 10 },
    });

    expect(event).toBeDefined();
    expect(validateEvent(event).valid).toBe(true);
    expect(event!.ide.name).toBe("vscode");
    expect(event!.project?.name).toBe("my-project");
    expect(event!.repository?.branch).toBe("main");
    expect(event!.schema_version).toBe("1.0.0");
  });

  it("captures nothing when telemetry is disabled", async () => {
    const { collector, queue } = await buildCollector({ enabled: false });
    const event = collector.capture({ eventType: EVENT_TYPES.FILE_SAVED });
    expect(event).toBeUndefined();
    expect(queue.size).toBe(0);
  });

  it("respects per-event-type opt-outs", async () => {
    const { collector, queue } = await buildCollector({
      disabledEventTypes: [EVENT_TYPES.EDITOR_CURSOR_MOVED],
    });
    collector.capture({ eventType: EVENT_TYPES.EDITOR_CURSOR_MOVED });
    collector.capture({ eventType: EVENT_TYPES.FILE_SAVED });
    expect(queue.size).toBe(1);
  });

  it("respects category opt-outs", async () => {
    const { collector, queue } = await buildCollector({ capture: { terminal: false } as any });
    collector.capture({ eventType: EVENT_TYPES.TERMINAL_CREATED });
    collector.capture({ eventType: EVENT_TYPES.FILE_SAVED });
    expect(queue.size).toBe(1);
  });

  it("throttles high-frequency events sharing a throttle key", async () => {
    const { collector, queue } = await buildCollector();
    for (let i = 0; i < 5; i++) {
      collector.capture({
        eventType: EVENT_TYPES.EDITOR_CURSOR_MOVED,
        throttle: { key: "cursor:file.ts", intervalMs: 1000 },
      });
    }
    expect(queue.size).toBe(1);
    expect(collector.getMetrics().eventsThrottled).toBe(4);
  });

  it("redacts secrets out of payloads before queueing", async () => {
    const { collector } = await buildCollector();
    const event = collector.capture({
      eventType: EVENT_TYPES.TERMINAL_COMMAND_EXECUTED,
      payload: { command: "export OPENAI_API_KEY=sk-supersecretvalue123456" },
    });
    expect(JSON.stringify(event!.payload)).not.toContain("sk-supersecretvalue123456");
    expect(JSON.stringify(event!.payload)).toContain("[REDACTED]");
  });

  it("hashes file paths when configured", async () => {
    const { collector } = await buildCollector({ hashFilePaths: true });
    const event = collector.capture({
      eventType: EVENT_TYPES.FILE_OPENED,
      file: { path: "/Users/alice/secret-project/main.ts", language: "typescript" },
    });
    expect(event!.file?.path).toMatch(/^sha256:/);
    expect(event!.file?.path).not.toContain("alice");
    expect(event!.file?.language).toBe("typescript");
  });
});

describe("EventCollector flush", () => {
  it("sends queued events and clears them from the queue", async () => {
    const { collector, queue, transport } = await buildCollector();
    collector.capture({ eventType: EVENT_TYPES.FILE_SAVED });
    collector.capture({ eventType: EVENT_TYPES.FILE_OPENED });

    await collector.flush();

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toHaveLength(2);
    expect(queue.size).toBe(0);
    expect(collector.getMetrics().eventsSent).toBe(2);
  });

  it("retains events in the queue when the transport fails (offline)", async () => {
    const { collector, queue, transport } = await buildCollector();
    transport.failNext = 1;
    collector.capture({ eventType: EVENT_TYPES.FILE_SAVED });

    await collector.flush();

    expect(queue.size).toBe(1);
    expect(collector.getMetrics().flushFailures).toBe(1);
    expect(transport.sent).toHaveLength(0);
  });

  it("delivers buffered events once the transport recovers", async () => {
    const { collector, queue, transport } = await buildCollector();
    transport.failNext = 1;
    collector.capture({ eventType: EVENT_TYPES.FILE_SAVED });
    await collector.flush();
    expect(queue.size).toBe(1);

    // Clear the backoff window so the event is eligible again.
    vi.setSystemTime(Date.now() + 60_000);
    await collector.flush();

    expect(queue.size).toBe(0);
    expect(transport.sent).toHaveLength(1);
    vi.useRealTimers();
  });

  it("drops permanently rejected events instead of retrying forever", async () => {
    const { collector, queue, transport } = await buildCollector();
    const event = collector.capture({ eventType: EVENT_TYPES.FILE_SAVED })!;
    transport.rejectIds = [event.event_id];

    await collector.flush();

    expect(queue.size).toBe(0);
    expect(collector.getMetrics().eventsRejected).toBe(1);
  });

  it("respects batchSize", async () => {
    const { collector, transport } = await buildCollector({ batchSize: 2 });
    for (let i = 0; i < 5; i++) {
      collector.capture({ eventType: EVENT_TYPES.FILE_SAVED, payload: { i } });
    }
    await collector.flush();
    expect(transport.sent[0]).toHaveLength(2);
  });

  it("gives up on poison-pill events after maxDeliveryAttempts", async () => {
    const { collector, queue } = await buildCollector({ maxDeliveryAttempts: 2 });
    const event = collector.capture({ eventType: EVENT_TYPES.FILE_SAVED })!;
    // Simulate two prior failed attempts.
    queue.nack([event.event_id]);
    queue.nack([event.event_id]);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 300_000);
    await collector.flush();
    vi.useRealTimers();

    expect(queue.size).toBe(0);
    expect(collector.getMetrics().eventsDropped).toBe(1);
  });
});
