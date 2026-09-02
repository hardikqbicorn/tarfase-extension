import { Pool } from "pg";
import { IDEEvent } from "@ide-collector/event-schema";

export interface PersistResult {
  /** Rows actually inserted (i.e. not already present). */
  inserted: number;
  /** Events skipped because the same event_id was already stored. */
  duplicates: number;
}

export interface EventErrorRecord {
  eventId?: string;
  installationId?: string;
  userId?: string;
  eventType?: string;
  stage: "validation" | "enrichment" | "persistence";
  message: string;
  details?: Record<string, unknown>;
  rawPayload?: unknown;
  topic?: string;
  partition?: number;
  offset?: string;
}

export interface EventStore {
  persistEvents(events: IDEEvent[]): Promise<PersistResult>;
  recordErrors(errors: EventErrorRecord[]): Promise<void>;
  upsertSession(event: IDEEvent, eventCount: number): Promise<void>;
  healthCheck(): Promise<boolean>;
  close(): Promise<void>;
}

/** Columns written for each event, in the order used by the bulk INSERT. */
const EVENT_COLUMNS = [
  "event_id",
  "user_id",
  "installation_id",
  "session_id",
  "event_type",
  "ide_name",
  "ide_version",
  "timestamp",
  "workspace_id",
  "workspace_name",
  "project_id",
  "project_name",
  "repository_id",
  "repository_name",
  "branch",
  "file_path",
  "language",
  "payload",
  "metadata",
  "schema_version",
] as const;

export class PostgresEventStore implements EventStore {
  private ensuredPartitions = new Set<string>();

  constructor(private readonly pool: Pool) {}

  /**
   * Bulk-inserts events with `ON CONFLICT (event_id, timestamp) DO NOTHING`.
   *
   * This is what makes the consumer idempotent: Kafka guarantees at-least-once
   * delivery, so the same event can arrive twice after a rebalance or an
   * offset-commit failure. The unique constraint turns the redelivery into a
   * no-op, and `rowCount` tells us how many were genuinely new.
   */
  async persistEvents(events: IDEEvent[]): Promise<PersistResult> {
    if (events.length === 0) return { inserted: 0, duplicates: 0 };

    await this.ensurePartitionsFor(events);

    const values: unknown[] = [];
    const rows: string[] = [];

    events.forEach((event, index) => {
      const base = index * EVENT_COLUMNS.length;
      const placeholders = EVENT_COLUMNS.map((_, i) => `$${base + i + 1}`);
      rows.push(`(${placeholders.join(", ")})`);
      values.push(
        event.event_id,
        event.user_id,
        event.installation_id,
        event.session_id,
        event.event_type,
        event.ide.name,
        event.ide.version ?? null,
        event.timestamp,
        event.workspace?.id ?? null,
        event.workspace?.name ?? null,
        event.project?.id ?? null,
        event.project?.name ?? null,
        event.repository?.id ?? null,
        event.repository?.name ?? null,
        event.repository?.branch ?? null,
        event.file?.path ?? null,
        event.file?.language ?? null,
        JSON.stringify(event.payload ?? {}),
        event.metadata ? JSON.stringify(event.metadata) : null,
        event.schema_version
      );
    });

    const quotedColumns = EVENT_COLUMNS.map((c) => `"${c}"`).join(", ");
    const result = await this.pool.query(
      `INSERT INTO raw_events (${quotedColumns})
       VALUES ${rows.join(", ")}
       ON CONFLICT (event_id, "timestamp") DO NOTHING`,
      values
    );

    const inserted = result.rowCount ?? 0;
    return { inserted, duplicates: events.length - inserted };
  }

  async recordErrors(errors: EventErrorRecord[]): Promise<void> {
    if (errors.length === 0) return;
    for (const error of errors) {
      await this.pool.query(
        `INSERT INTO event_errors
           (event_id, installation_id, user_id, event_type, error_stage, error_message,
            error_details, raw_payload, kafka_topic, kafka_partition, kafka_offset)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          // event_id is a UUID column; a malformed value would abort the insert,
          // so anything non-UUID is kept in error_details instead.
          isUuid(error.eventId) ? error.eventId : null,
          error.installationId ?? null,
          error.userId ?? null,
          error.eventType ?? null,
          error.stage,
          error.message,
          error.details ? JSON.stringify(error.details) : null,
          error.rawPayload !== undefined ? JSON.stringify(error.rawPayload) : null,
          error.topic ?? null,
          error.partition ?? null,
          error.offset ? Number.parseInt(error.offset, 10) : null,
        ]
      );
    }
  }

  /**
   * Maintains the ide_sessions dimension so session-level analytics stay
   * cheap. `eventCount` is the number of events just persisted for this
   * session, so one call per batch keeps the running total accurate.
   *
   * Note this is not idempotent under redelivery: a replayed batch inflates
   * event_count even though raw_events correctly no-ops. That is an accepted
   * trade -- the dimension is a convenience, and the authoritative count is a
   * COUNT(*) over raw_events.
   */
  async upsertSession(event: IDEEvent, eventCount: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO ide_sessions (external_id, ide_name, ide_version, started_at, event_count)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (external_id) DO UPDATE
         SET event_count = ide_sessions.event_count + EXCLUDED.event_count,
             started_at = LEAST(ide_sessions.started_at, EXCLUDED.started_at),
             ended_at = GREATEST(COALESCE(ide_sessions.ended_at, EXCLUDED.started_at), EXCLUDED.started_at)`,
      [event.session_id, event.ide.name, event.ide.version ?? null, event.timestamp, eventCount]
    );
  }

  /**
   * Creates the monthly partition for each event's timestamp if missing.
   * Cached in-process so this costs one query per new month, not per batch.
   */
  private async ensurePartitionsFor(events: IDEEvent[]): Promise<void> {
    const months = new Set<string>();
    for (const event of events) {
      const date = new Date(event.timestamp);
      if (Number.isNaN(date.getTime())) continue;
      months.add(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`);
    }
    for (const month of months) {
      if (this.ensuredPartitions.has(month)) continue;
      await this.pool.query("SELECT ensure_raw_events_partition($1::date)", [month]);
      this.ensuredPartitions.add(month);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string | undefined): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
