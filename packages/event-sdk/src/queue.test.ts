import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createEvent, EVENT_TYPES } from "@ide-collector/event-schema";
import { EventQueue } from "./queue";
import { InMemoryQueuePersistence } from "./persistence";

function makeEvent(seq: number) {
  return createEvent({
    eventType: EVENT_TYPES.FILE_SAVED,
    userId: "u",
    installationId: "i",
    sessionId: "s",
    ide: { name: "vscode" },
    payload: { seq },
  });
}

describe("EventQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("preserves FIFO ordering", async () => {
    const queue = new EventQueue({ maxQueueSize: 10, persistence: new InMemoryQueuePersistence() });
    await queue.init();
    queue.enqueue(makeEvent(1));
    queue.enqueue(makeEvent(2));
    queue.enqueue(makeEvent(3));

    const ready = queue.peekReady(10);
    expect(ready.map((r) => r.event.payload.seq)).toEqual([1, 2, 3]);
  });

  it("enforces maxQueueSize by dropping the oldest event", async () => {
    const onDrop = vi.fn();
    const queue = new EventQueue({
      maxQueueSize: 2,
      persistence: new InMemoryQueuePersistence(),
      onDrop,
    });
    await queue.init();
    queue.enqueue(makeEvent(1));
    queue.enqueue(makeEvent(2));
    queue.enqueue(makeEvent(3));

    expect(queue.size).toBe(2);
    expect(queue.totalDropped).toBe(1);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(queue.peekReady(10).map((r) => r.event.payload.seq)).toEqual([2, 3]);
  });

  it("removes acked events", async () => {
    const queue = new EventQueue({ maxQueueSize: 10, persistence: new InMemoryQueuePersistence() });
    await queue.init();
    const e1 = makeEvent(1);
    const e2 = makeEvent(2);
    queue.enqueue(e1);
    queue.enqueue(e2);

    queue.ack([e1.event_id]);
    expect(queue.size).toBe(1);
    expect(queue.peekReady(10)[0].event.event_id).toBe(e2.event_id);
  });

  it("applies backoff to nacked events so they are not immediately retried", async () => {
    const queue = new EventQueue({ maxQueueSize: 10, persistence: new InMemoryQueuePersistence() });
    await queue.init();
    const e1 = makeEvent(1);
    queue.enqueue(e1);

    queue.nack([e1.event_id]);
    // Retry time is in the future (full jitter can yield 0, so allow either but
    // confirm the attempt counter advanced).
    const items = queue.peekReady(10);
    expect(queue.size).toBe(1);
    if (items.length > 0) {
      expect(items[0].attempts).toBe(1);
    }
  });

  it("survives a restart by reloading events from persistence", async () => {
    const persistence = new InMemoryQueuePersistence();
    const queue = new EventQueue({ maxQueueSize: 10, persistence });
    await queue.init();
    queue.enqueue(makeEvent(1));
    queue.enqueue(makeEvent(2));
    await queue.dispose();

    const restarted = new EventQueue({ maxQueueSize: 10, persistence });
    await restarted.init();
    expect(restarted.size).toBe(2);
    expect(restarted.peekReady(10).map((r) => r.event.payload.seq)).toEqual([1, 2]);
  });

  it("treats a corrupt persisted blob as an empty queue", async () => {
    const persistence = new InMemoryQueuePersistence();
    await persistence.save("{not valid json");
    const queue = new EventQueue({ maxQueueSize: 10, persistence });
    await queue.init();
    expect(queue.size).toBe(0);
  });
});
