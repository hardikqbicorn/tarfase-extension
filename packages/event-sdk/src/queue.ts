import { IDEEvent } from "@ide-collector/event-schema";
import { computeBackoffDelay } from "@ide-collector/shared-utils";
import { QueuePersistence } from "./persistence";

export interface QueuedEvent {
  event: IDEEvent;
  attempts: number;
  nextRetryAt: number;
  enqueuedAt: number;
}

export interface EventQueueOptions {
  maxQueueSize: number;
  persistence: QueuePersistence;
  /** How often (ms) the in-memory queue is flushed to persistent storage. */
  persistDebounceMs?: number;
  onDrop?: (dropped: QueuedEvent, reason: "queue-full") => void;
}

interface SerializedQueue {
  version: 1;
  items: QueuedEvent[];
}

/**
 * Ordered, bounded, crash-recoverable local event buffer. Preserves FIFO
 * ordering, enforces a max size (dropping the oldest event when full so a
 * network outage cannot grow memory/disk unbounded), and persists to disk
 * so events survive an IDE restart.
 */
export class EventQueue {
  private items: QueuedEvent[] = [];
  private droppedCount = 0;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private loaded = false;

  constructor(private readonly options: EventQueueOptions) {}

  async init(): Promise<void> {
    if (this.loaded) return;
    const raw = await this.options.persistence.load();
    if (raw) {
      try {
        const parsed: SerializedQueue = JSON.parse(raw);
        this.items = parsed.items ?? [];
      } catch {
        this.items = [];
      }
    }
    this.loaded = true;
  }

  get size(): number {
    return this.items.length;
  }

  get totalDropped(): number {
    return this.droppedCount;
  }

  enqueue(event: IDEEvent): void {
    if (this.items.length >= this.options.maxQueueSize) {
      const dropped = this.items.shift();
      this.droppedCount++;
      if (dropped) this.options.onDrop?.(dropped, "queue-full");
    }
    this.items.push({ event, attempts: 0, nextRetryAt: 0, enqueuedAt: Date.now() });
    this.schedulePersist();
  }

  /** Returns up to `limit` events currently eligible to send, oldest first. */
  peekReady(limit: number): QueuedEvent[] {
    const now = Date.now();
    const ready: QueuedEvent[] = [];
    for (const item of this.items) {
      if (item.nextRetryAt <= now) {
        ready.push(item);
        if (ready.length >= limit) break;
      }
    }
    return ready;
  }

  /** Removes successfully delivered events from the queue. */
  ack(eventIds: string[]): void {
    const ids = new Set(eventIds);
    this.items = this.items.filter((item) => !ids.has(item.event.event_id));
    this.schedulePersist();
  }

  /** Marks events as failed, bumping their attempt count and next retry time. */
  nack(eventIds: string[]): void {
    const ids = new Set(eventIds);
    for (const item of this.items) {
      if (ids.has(item.event.event_id)) {
        item.attempts += 1;
        item.nextRetryAt = Date.now() + computeBackoffDelay(item.attempts - 1);
      }
    }
    this.schedulePersist();
  }

  private schedulePersist(debounceMs = this.options.persistDebounceMs ?? 250): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.flushToDisk();
    }, debounceMs);
  }

  async flushToDisk(): Promise<void> {
    const serialized: SerializedQueue = { version: 1, items: this.items };
    await this.options.persistence.save(JSON.stringify(serialized));
  }

  async dispose(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    await this.flushToDisk();
  }
}
