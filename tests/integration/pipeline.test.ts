import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import jwt from "jsonwebtoken";
import { Pool } from "pg";
import { EVENT_TYPES, IDEEvent } from "@ide-collector/event-schema";
import {
  EventCollector,
  EventQueue,
  InMemoryQueuePersistence,
  mergeConfig,
  EventTransport,
  TransportError,
  TransportResult,
} from "@ide-collector/event-sdk";
import { Logger } from "@ide-collector/shared-utils";
import { buildApp } from "../../services/kafka-producer/src/app";
import { EventPublisher } from "../../services/kafka-producer/src/kafka";
import { ProducerServiceConfig } from "../../services/kafka-producer/src/config";
import { EventProcessor } from "../../services/kafka-consumer/src/processor";
import { PostgresEventStore } from "../../services/kafka-consumer/src/store";
import { InMemoryEventStore } from "../../services/kafka-consumer/src/in-memory-store";
import { createConsumerMetrics } from "../../services/kafka-consumer/src/metrics";

/**
 * End-to-end integration test for the MVP's complete path:
 *
 *   IDE event -> Extension SDK -> local buffer -> ingestion API
 *              -> Kafka -> consumer -> Postgres -> visible in the database
 *
 * Kafka is replaced by an in-memory broker that preserves the real contract
 * (serialized JSON messages with topic/partition/offset, at-least-once
 * redelivery), so the pipeline's semantics - not just its happy path - are
 * exercised without needing a broker in CI.
 *
 * The database is real Postgres when TEST_DATABASE_URL is set (see
 * scripts/test-db.sh); otherwise these tests fall back to the in-memory store,
 * which mirrors the same idempotency semantics.
 */

const JWT_SECRET = "integration-test-secret";
const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const silentLogger = new Logger({ service: "test", level: "error", sink: { write: () => {} } });

// -----------------------------------------------------------------------------
// In-memory Kafka standing in for the broker
// -----------------------------------------------------------------------------
interface BrokerMessage {
  topic: string;
  partition: number;
  offset: string;
  key: string;
  value: string;
}

class InMemoryBroker {
  private topics = new Map<string, BrokerMessage[]>();

  produce(topic: string, key: string, value: string): void {
    const messages = this.topics.get(topic) ?? [];
    // Key-based partitioning, matching the real producer's behavior: all events
    // from one installation land on the same partition.
    const partition = hash(key) % 6;
    messages.push({ topic, partition, offset: String(messages.length), key, value });
    this.topics.set(topic, messages);
  }

  consume(topic: string): BrokerMessage[] {
    return this.topics.get(topic) ?? [];
  }

  size(topic: string): number {
    return this.consume(topic).length;
  }

  clear(): void {
    this.topics.clear();
  }
}

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(h);
}

class BrokerPublisher implements EventPublisher {
  connected = true;
  /** Set to make the next publish throw, simulating a broker outage. */
  failNext = false;

  constructor(private readonly broker: InMemoryBroker) {}

  async connect() {}
  async disconnect() {}
  isConnected() {
    return this.connected;
  }

  async publish(events: IDEEvent[]): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("broker unavailable");
    }
    for (const event of events) {
      this.broker.produce("ide.events.raw", event.installation_id, JSON.stringify(event));
    }
  }

  async publishError(record: Record<string, unknown>): Promise<void> {
    this.broker.produce("ide.events.errors", "error", JSON.stringify(record));
  }
}

// -----------------------------------------------------------------------------
// Transport that carries the SDK's batches into the real ingestion app
// -----------------------------------------------------------------------------
class InjectTransport implements EventTransport {
  constructor(
    private readonly app: ReturnType<typeof buildApp>,
    private readonly token: string
  ) {}

  async send(events: IDEEvent[]): Promise<TransportResult> {
    const response = await this.app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${this.token}` },
      payload: { installation_id: INSTALLATION_ID, events },
    });

    if (response.statusCode >= 500) {
      throw new TransportError(`ingestion ${response.statusCode}`, response.statusCode, true);
    }
    const body = response.json() as { accepted?: string[]; rejected?: string[] };
    return { accepted: body.accepted ?? [], rejected: body.rejected ?? [] };
  }
}

const producerConfig: ProducerServiceConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  logLevel: "error",
  jwtSecret: JWT_SECRET,
  kafka: {
    clientId: "test",
    brokers: ["memory"],
    ssl: false,
    rawTopic: "ide.events.raw",
    errorTopic: "ide.events.errors",
    acks: -1,
    retries: 3,
    requestTimeoutMs: 1000,
  },
  maxBatchEvents: 1000,
  bodyLimitBytes: 5 * 1024 * 1024,
};

// -----------------------------------------------------------------------------
// Harness wiring the whole pipeline together
// -----------------------------------------------------------------------------
interface Pipeline {
  collector: EventCollector;
  broker: InMemoryBroker;
  publisher: BrokerPublisher;
  queue: EventQueue;
  drainToDatabase(): Promise<{ persisted: number; duplicates: number; failed: number }>;
  queryEvents(): Promise<Record<string, unknown>[]>;
  reset(): Promise<void>;
}

let pool: Pool | undefined;
let store: PostgresEventStore | InMemoryEventStore;

/** Projects an IDEEvent onto the column shape `raw_events` stores. */
function toRow(event: IDEEvent): Record<string, unknown> {
  return {
    event_id: event.event_id,
    event_type: event.event_type,
    user_id: event.user_id,
    installation_id: event.installation_id,
    session_id: event.session_id,
    ide_name: event.ide.name,
    timestamp: event.timestamp,
    project_name: event.project?.name ?? null,
    branch: event.repository?.branch ?? null,
    file_path: event.file?.path ?? null,
    language: event.file?.language ?? null,
    payload: event.payload,
    schema_version: event.schema_version,
  };
}

async function buildPipeline(): Promise<Pipeline> {
  const broker = new InMemoryBroker();
  const publisher = new BrokerPublisher(broker);
  const app = buildApp({ config: producerConfig, publisher, logger: silentLogger });

  const token = jwt.sign({ sub: INSTALLATION_ID, user_id: USER_ID }, JWT_SECRET, {
    algorithm: "HS256",
  });

  const queue = new EventQueue({
    maxQueueSize: 10_000,
    persistence: new InMemoryQueuePersistence(),
  });

  const collector = new EventCollector({
    config: mergeConfig({ enabled: true, batchSize: 100, flushIntervalMs: 60_000 }),
    identity: {
      userId: USER_ID,
      installationId: INSTALLATION_ID,
      sessionId: "33333333-3333-4333-8333-333333333333",
    },
    contextProvider: {
      getContext: () => ({
        ide: { name: "vscode", version: "1.90.0" },
        workspace: { id: "ws-1", name: "my-workspace" },
        project: { id: "proj-1", name: "my-project" },
        repository: { id: "repo-1", name: "my-repo", branch: "main" },
      }),
    },
    queue,
    transport: new InjectTransport(app, token),
    logger: silentLogger,
  });
  await collector.start();

  const processor = new EventProcessor({
    store,
    logger: silentLogger,
    metrics: createConsumerMetrics(),
  });

  let consumedOffset = 0;

  return {
    collector,
    broker,
    publisher,
    queue,

    /** Consumes everything not yet read from the raw topic and persists it. */
    async drainToDatabase() {
      const messages = broker.consume("ide.events.raw").slice(consumedOffset);
      consumedOffset += messages.length;
      if (messages.length === 0) return { persisted: 0, duplicates: 0, failed: 0 };

      const result = await processor.processBatch(
        messages.map((m) => ({
          value: m.value,
          topic: m.topic,
          partition: m.partition,
          offset: m.offset,
        }))
      );
      return {
        persisted: result.persisted,
        duplicates: result.duplicates,
        failed: result.failed,
      };
    },

    async queryEvents() {
      if (pool) {
        const result = await pool.query(
          `SELECT event_id, event_type, user_id, installation_id, session_id, ide_name,
                  "timestamp", project_name, branch, file_path, language, payload, schema_version
             FROM raw_events
            WHERE installation_id = $1
            ORDER BY "timestamp" ASC`,
          [INSTALLATION_ID]
        );
        return result.rows;
      }
      // Flatten to the same row shape Postgres returns, so every assertion
      // below is identical whichever store is in play.
      return (store as InMemoryEventStore).all().map(toRow);
    },

    async reset() {
      broker.clear();
      consumedOffset = 0;
      if (pool) {
        await pool.query(`DELETE FROM raw_events WHERE installation_id = $1`, [INSTALLATION_ID]);
        await pool.query(`DELETE FROM event_errors`);
      }
    },
  };
}

beforeAll(async () => {
  if (TEST_DATABASE_URL) {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
    store = new PostgresEventStore(pool);
    // Fail loudly rather than silently downgrading: if a URL was provided, the
    // intent was to test against a real database.
    await pool.query("SELECT 1 FROM raw_events LIMIT 1");
  } else {
    store = new InMemoryEventStore();
  }
});

afterAll(async () => {
  await pool?.end();
});

describe(`end-to-end pipeline (${TEST_DATABASE_URL ? "real Postgres" : "in-memory store"})`, () => {
  let pipeline: Pipeline;

  beforeEach(async () => {
    if (store instanceof InMemoryEventStore) {
      store.events.clear();
      store.errors.length = 0;
    }
    pipeline = await buildPipeline();
    await pipeline.reset();
  });

  it("carries an IDE event all the way to the database", async () => {
    const captured = pipeline.collector.capture({
      eventType: EVENT_TYPES.FILE_SAVED,
      file: { path: "src/index.ts", language: "typescript" },
      payload: { line_count: 42 },
    })!;

    await pipeline.collector.flush();
    expect(pipeline.broker.size("ide.events.raw")).toBe(1);

    const result = await pipeline.drainToDatabase();
    expect(result.persisted).toBe(1);

    const rows = await pipeline.queryEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBe(captured.event_id);
    expect(rows[0].event_type).toBe(EVENT_TYPES.FILE_SAVED);
    expect(rows[0].file_path).toBe("src/index.ts");
    expect(rows[0].language).toBe("typescript");
    expect(rows[0].branch).toBe("main");
    expect(rows[0].schema_version).toBe("1.0.0");
  });

  it("preserves the payload as queryable JSON", async () => {
    pipeline.collector.capture({
      eventType: EVENT_TYPES.BUILD_COMPLETED,
      payload: { task_name: "npm: build", duration_ms: 1234, succeeded: true },
    });
    await pipeline.collector.flush();
    await pipeline.drainToDatabase();

    const rows = await pipeline.queryEvents();
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.task_name).toBe("npm: build");
    expect(payload.duration_ms).toBe(1234);
    expect(payload.succeeded).toBe(true);
  });

  it("carries a realistic multi-event session through in order", async () => {
    const sequence = [
      { eventType: EVENT_TYPES.SESSION_STARTED, payload: {} },
      { eventType: EVENT_TYPES.WORKSPACE_OPENED, payload: { folder_count: 1 } },
      { eventType: EVENT_TYPES.FILE_OPENED, file: { path: "src/a.ts", language: "typescript" } },
      { eventType: EVENT_TYPES.EDITOR_DOCUMENT_CHANGED, payload: { chars_added: 12 } },
      { eventType: EVENT_TYPES.FILE_SAVED, file: { path: "src/a.ts", language: "typescript" } },
      { eventType: EVENT_TYPES.GIT_COMMIT, payload: { commit: "abc123" } },
      { eventType: EVENT_TYPES.TEST_STARTED, payload: { task_name: "npm: test" } },
      { eventType: EVENT_TYPES.TEST_COMPLETED, payload: { exit_code: 0 } },
    ];

    for (const event of sequence) {
      pipeline.collector.capture(event as any);
    }

    await pipeline.collector.flush();
    const result = await pipeline.drainToDatabase();
    expect(result.persisted).toBe(sequence.length);

    const rows = await pipeline.queryEvents();
    expect(rows).toHaveLength(sequence.length);
    expect(rows.map((r) => r.event_type)).toEqual(sequence.map((e) => e.eventType));
  });

  it("is idempotent: replaying the topic creates no duplicate rows", async () => {
    pipeline.collector.capture({ eventType: EVENT_TYPES.FILE_SAVED });
    await pipeline.collector.flush();

    const messages = pipeline.broker.consume("ide.events.raw");
    expect(messages).toHaveLength(1);

    const first = await pipeline.drainToDatabase();
    expect(first.persisted).toBe(1);

    // Simulate a rebalance replaying the same offsets.
    const processor = new EventProcessor({
      store,
      logger: silentLogger,
      metrics: createConsumerMetrics(),
    });
    const replay = await processor.processBatch(
      messages.map((m) => ({
        value: m.value,
        topic: m.topic,
        partition: m.partition,
        offset: m.offset,
      }))
    );

    expect(replay.persisted).toBe(0);
    expect(replay.duplicates).toBe(1);
    expect(await pipeline.queryEvents()).toHaveLength(1);
  });

  it("buffers events locally while ingestion is down, then delivers them", async () => {
    pipeline.publisher.failNext = true;

    pipeline.collector.capture({ eventType: EVENT_TYPES.FILE_SAVED, payload: { n: 1 } });
    await pipeline.collector.flush();

    // Nothing reached Kafka, and the event is still queued for retry.
    expect(pipeline.broker.size("ide.events.raw")).toBe(0);
    expect(pipeline.queue.size).toBe(1);

    // Ingestion recovers; the buffered event goes through on the next flush.
    // (peekReady honors the backoff window, so advance past it.)
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await pipeline.collector.flush();

    expect(pipeline.broker.size("ide.events.raw")).toBe(1);
    await pipeline.drainToDatabase();
    expect(await pipeline.queryEvents()).toHaveLength(1);
  });

  it("never lets a secret reach the database", async () => {
    pipeline.collector.capture({
      eventType: EVENT_TYPES.TERMINAL_COMMAND_EXECUTED,
      payload: {
        command: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY npm run deploy",
        env_token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      },
    });

    await pipeline.collector.flush();
    await pipeline.drainToDatabase();

    const rows = await pipeline.queryEvents();
    const serialized = JSON.stringify(rows[0].payload);
    expect(serialized).not.toContain("wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY");
    expect(serialized).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(serialized).toContain("[REDACTED]");
  });

  it("rejects a batch signed for a different installation", async () => {
    const broker = new InMemoryBroker();
    const app = buildApp({
      config: producerConfig,
      publisher: new BrokerPublisher(broker),
      logger: silentLogger,
    });
    const attackerToken = jwt.sign(
      { sub: "44444444-4444-4444-8444-444444444444", user_id: "attacker" },
      JWT_SECRET
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${attackerToken}` },
      payload: {
        installation_id: INSTALLATION_ID,
        events: [
          {
            event_id: "55555555-5555-4555-8555-555555555555",
            event_type: EVENT_TYPES.FILE_SAVED,
            timestamp: new Date().toISOString(),
            user_id: USER_ID,
            installation_id: INSTALLATION_ID,
            session_id: "s",
            ide: { name: "vscode" },
            payload: {},
            schema_version: "1.0.0",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(broker.size("ide.events.raw")).toBe(0);
  });

  it("routes an invalid event to the error path without blocking valid ones", async () => {
    pipeline.collector.capture({ eventType: EVENT_TYPES.FILE_SAVED });
    await pipeline.collector.flush();

    // Inject a corrupt message directly onto the topic, as a bad producer would.
    pipeline.broker.produce("ide.events.raw", INSTALLATION_ID, "{ not valid json");
    pipeline.collector.capture({ eventType: EVENT_TYPES.FILE_OPENED });
    await pipeline.collector.flush();

    const result = await pipeline.drainToDatabase();
    expect(result.persisted).toBe(2);
    expect(result.failed).toBe(1);
    expect(await pipeline.queryEvents()).toHaveLength(2);
  });

  it("handles a burst of events across multiple batches", async () => {
    for (let i = 0; i < 250; i++) {
      pipeline.collector.capture({
        eventType: EVENT_TYPES.EDITOR_DOCUMENT_CHANGED,
        file: { path: `src/file-${i}.ts`, language: "typescript" },
        payload: { i },
      });
    }

    // batchSize is 100, so this takes three flushes.
    await pipeline.collector.flush();
    await pipeline.collector.flush();
    await pipeline.collector.flush();

    expect(pipeline.broker.size("ide.events.raw")).toBe(250);
    expect(pipeline.queue.size).toBe(0);

    const result = await pipeline.drainToDatabase();
    expect(result.persisted).toBe(250);
    expect(await pipeline.queryEvents()).toHaveLength(250);
  });
});
