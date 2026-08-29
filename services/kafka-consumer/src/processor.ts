import { IDEEvent, isSupportedSchemaVersion, validateEvent } from "@ide-collector/event-schema";
import { Redactor } from "@ide-collector/crypto";
import { Logger } from "@ide-collector/shared-utils";
import { EventErrorRecord, EventStore } from "./store";
import { ConsumerMetrics } from "./metrics";

export interface RawMessage {
  value: string | null;
  topic: string;
  partition: number;
  offset: string;
}

export interface ProcessResult {
  received: number;
  persisted: number;
  duplicates: number;
  failed: number;
  errors: EventErrorRecord[];
}

export interface ProcessorOptions {
  store: EventStore;
  logger: Logger;
  metrics: ConsumerMetrics;
  redactor?: Redactor;
  /** Optional sink for the dead-letter topic. */
  publishToErrorTopic?: (record: Record<string, unknown>) => Promise<void>;
  /** Optional sink for the processed topic. */
  publishToProcessedTopic?: (events: IDEEvent[]) => Promise<void>;
}

/**
 * Validate -> enrich -> redact -> dedupe -> persist.
 *
 * Every stage is fail-soft at the *event* level and fail-hard at the *batch*
 * level: a single malformed event goes to the dead-letter path and the rest of
 * the batch proceeds, but a database outage throws so Kafka offsets are not
 * committed and the batch is redelivered.
 */
export class EventProcessor {
  private readonly redactor: Redactor;

  constructor(private readonly options: ProcessorOptions) {
    this.redactor = options.redactor ?? new Redactor();
  }

  async processBatch(messages: RawMessage[]): Promise<ProcessResult> {
    const startedAt = Date.now();
    const valid: IDEEvent[] = [];
    const errors: EventErrorRecord[] = [];

    // ---- Stage 1: parse + validate ----------------------------------------
    for (const message of messages) {
      if (!message.value) {
        errors.push({
          stage: "validation",
          message: "Empty message value",
          topic: message.topic,
          partition: message.partition,
          offset: message.offset,
        });
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(message.value);
      } catch (err) {
        errors.push({
          stage: "validation",
          message: `Malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
          rawPayload: message.value.slice(0, 2000),
          topic: message.topic,
          partition: message.partition,
          offset: message.offset,
        });
        continue;
      }

      const result = validateEvent(parsed);
      if (!result.valid || !result.event) {
        const candidate = parsed as Partial<IDEEvent>;
        errors.push({
          eventId: candidate?.event_id,
          installationId: candidate?.installation_id,
          userId: candidate?.user_id,
          eventType: candidate?.event_type,
          stage: "validation",
          message: "Event failed schema validation",
          details: { errors: result.errors },
          rawPayload: parsed,
          topic: message.topic,
          partition: message.partition,
          offset: message.offset,
        });
        continue;
      }

      if (!isSupportedSchemaVersion(result.event.schema_version)) {
        errors.push({
          eventId: result.event.event_id,
          installationId: result.event.installation_id,
          userId: result.event.user_id,
          eventType: result.event.event_type,
          stage: "validation",
          message: `Unsupported schema_version: ${result.event.schema_version}`,
          rawPayload: parsed,
          topic: message.topic,
          partition: message.partition,
          offset: message.offset,
        });
        continue;
      }

      // ---- Stage 2: enrich ------------------------------------------------
      // ---- Stage 3: redact (last line of defense before the database) -----
      valid.push(this.redactor.redactEvent(this.enrich(result.event, message)));
    }

    // ---- Stage 4: in-batch dedupe -----------------------------------------
    // The database constraint is the real guarantee; collapsing here first
    // avoids `ON CONFLICT` firing against rows in the *same* INSERT, which
    // Postgres rejects ("cannot affect row a second time").
    const seen = new Set<string>();
    const deduped: IDEEvent[] = [];
    let inBatchDuplicates = 0;
    for (const event of valid) {
      const key = `${event.event_id}|${event.timestamp}`;
      if (seen.has(key)) {
        inBatchDuplicates++;
        continue;
      }
      seen.add(key);
      deduped.push(event);
    }

    // ---- Stage 5: persist --------------------------------------------------
    let persisted = 0;
    let duplicates = inBatchDuplicates;

    if (deduped.length > 0) {
      const writeStartedAt = Date.now();
      // A throw here propagates: offsets stay uncommitted and Kafka redelivers.
      const result = await this.options.store.persistEvents(deduped);
      this.options.metrics.dbWriteLatency.observe(Date.now() - writeStartedAt);
      persisted = result.inserted;
      duplicates += result.duplicates;

      for (const event of deduped) {
        this.options.metrics.eventsByType.inc({
          event_type: event.event_type,
          ide_name: event.ide.name,
        });
      }

      // Maintain the ide_sessions dimension. Done once per distinct session in
      // the batch rather than per event, so a 200-event batch from one IDE
      // window costs one write, not two hundred. Never allowed to fail the
      // batch: the events are already durably stored, and losing a dimension
      // row is recoverable from raw_events.
      const sessionRepresentatives = new Map<string, { event: IDEEvent; count: number }>();
      for (const event of deduped) {
        const existing = sessionRepresentatives.get(event.session_id);
        if (!existing) {
          sessionRepresentatives.set(event.session_id, { event, count: 1 });
        } else {
          existing.count += 1;
          if (event.timestamp > existing.event.timestamp) existing.event = event;
        }
      }
      for (const { event, count } of sessionRepresentatives.values()) {
        await this.options.store.upsertSession(event, count).catch((err) =>
          this.options.logger.warn("failed to upsert session dimension", {
            session_id: event.session_id,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }

      if (this.options.publishToProcessedTopic) {
        await this.options
          .publishToProcessedTopic(deduped)
          .catch((err) =>
            this.options.logger.warn("failed to publish to processed topic", {
              error: err instanceof Error ? err.message : String(err),
            })
          );
      }
    }

    // ---- Stage 6: dead-letter handling ------------------------------------
    if (errors.length > 0) {
      // Recording errors must never fail the batch: a failure here would send
      // the whole batch (including the good events) around again forever.
      await this.options.store.recordErrors(errors).catch((err) =>
        this.options.logger.error("failed to record event errors", {
          error: err instanceof Error ? err.message : String(err),
          count: errors.length,
        })
      );

      if (this.options.publishToErrorTopic) {
        for (const error of errors) {
          await this.options
            .publishToErrorTopic({ ...error, occurred_at: new Date().toISOString() })
            .catch(() => undefined);
        }
      }
    }

    this.options.metrics.eventsReceived.inc({}, messages.length);
    this.options.metrics.eventsPersisted.inc({}, persisted);
    this.options.metrics.eventsDuplicate.inc({}, duplicates);
    this.options.metrics.eventsFailed.inc({}, errors.length);
    this.options.metrics.batchLatency.observe(Date.now() - startedAt);

    return {
      received: messages.length,
      persisted,
      duplicates,
      failed: errors.length,
      errors,
    };
  }

  /**
   * Adds server-side context the extension cannot know. Kept deliberately
   * small: enrichment that needs a lookup (repo metadata, team membership)
   * belongs in a downstream job reading ide.events.processed, not on the
   * hot ingestion path.
   */
  private enrich(event: IDEEvent, message: RawMessage): IDEEvent {
    return {
      ...event,
      metadata: {
        ...(event.metadata ?? {}),
        _ingest: {
          topic: message.topic,
          partition: message.partition,
          offset: message.offset,
          processed_at: new Date().toISOString(),
        },
      },
    };
  }
}
