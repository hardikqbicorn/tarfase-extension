import { IDEEvent } from "@ide-collector/event-schema";
import { EventErrorRecord, EventStore, PersistResult } from "./store";

/**
 * In-memory EventStore mirroring the Postgres implementation's idempotency
 * semantics: a repeated (event_id, timestamp) is a no-op, not a duplicate row.
 * Used by unit and integration tests.
 */
export class InMemoryEventStore implements EventStore {
  readonly events = new Map<string, IDEEvent>();
  readonly errors: EventErrorRecord[] = [];
  readonly sessions = new Map<string, { count: number; lastSeen: string }>();
  healthy = true;
  /** Set to make the next persistEvents call throw, simulating a DB outage. */
  failNextWrite = false;

  private key(event: IDEEvent): string {
    return `${event.event_id}|${event.timestamp}`;
  }

  async persistEvents(events: IDEEvent[]): Promise<PersistResult> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("database unavailable");
    }
    let inserted = 0;
    let duplicates = 0;
    for (const event of events) {
      const key = this.key(event);
      if (this.events.has(key)) {
        duplicates++;
        continue;
      }
      this.events.set(key, event);
      inserted++;
    }
    return { inserted, duplicates };
  }

  async recordErrors(errors: EventErrorRecord[]): Promise<void> {
    this.errors.push(...errors);
  }

  async upsertSession(event: IDEEvent): Promise<void> {
    const existing = this.sessions.get(event.session_id);
    this.sessions.set(event.session_id, {
      count: (existing?.count ?? 0) + 1,
      lastSeen: event.timestamp,
    });
  }

  async healthCheck(): Promise<boolean> {
    return this.healthy;
  }

  async close(): Promise<void> {}

  /** Test helper: all stored events, in insertion order. */
  all(): IDEEvent[] {
    return [...this.events.values()];
  }
}
