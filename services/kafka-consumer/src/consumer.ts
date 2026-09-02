import { Kafka, Consumer, Producer, logLevel as kafkaLogLevel } from "kafkajs";
import { Logger } from "@ide-collector/shared-utils";
import { ConsumerServiceConfig } from "./config";
import { EventProcessor, RawMessage } from "./processor";
import { ConsumerMetrics } from "./metrics";

/**
 * Kafka consumer runner.
 *
 * Uses `eachBatch` rather than `eachMessage` so events are written to Postgres
 * in bulk (one INSERT per batch instead of one per event), which is the
 * difference between thousands and tens of thousands of events/sec.
 *
 * Offsets are committed only after a batch is durably persisted. Combined with
 * the ON CONFLICT DO NOTHING upsert, this gives effective exactly-once
 * semantics on top of Kafka's at-least-once delivery.
 */
export class KafkaEventConsumer {
  private readonly kafka: Kafka;
  private readonly consumer: Consumer;
  private readonly producer: Producer;
  private running = false;
  private connected = false;

  constructor(
    private readonly config: ConsumerServiceConfig,
    private readonly processor: EventProcessor,
    private readonly logger: Logger,
    private readonly metrics: ConsumerMetrics
  ) {
    this.kafka = new Kafka({
      clientId: config.kafka.clientId,
      brokers: config.kafka.brokers,
      ssl: config.kafka.ssl,
      sasl: config.kafka.sasl,
      logLevel: kafkaLogLevel.WARN,
      retry: { retries: 10, initialRetryTime: 300 },
    });

    this.consumer = this.kafka.consumer({
      groupId: config.kafka.groupId,
      sessionTimeout: config.kafka.sessionTimeoutMs,
      heartbeatInterval: config.kafka.heartbeatIntervalMs,
      maxBytesPerPartition: config.kafka.maxBytesPerPartition,
    });

    this.producer = this.kafka.producer({ idempotent: true, maxInFlightRequests: 5 });

    this.consumer.on("consumer.crash", (event) => {
      this.connected = false;
      this.logger.error("consumer crashed", { error: String(event.payload.error) });
    });
    this.consumer.on("consumer.disconnect", () => {
      this.connected = false;
      this.logger.warn("consumer disconnected");
    });
    this.consumer.on("consumer.connect", () => {
      this.connected = true;
      this.logger.info("consumer connected", { brokers: config.kafka.brokers });
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    await this.producer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({
      topic: this.config.kafka.rawTopic,
      fromBeginning: this.config.kafka.fromBeginning,
    });

    await this.consumer.run({
      eachBatchAutoResolve: false,
      eachBatch: async ({
        batch,
        resolveOffset,
        heartbeat,
        commitOffsetsIfNecessary,
        isRunning,
        isStale,
      }) => {
        if (!isRunning() || isStale()) return;

        const messages: RawMessage[] = batch.messages.map((m) => ({
          value: m.value ? m.value.toString("utf8") : null,
          topic: batch.topic,
          partition: batch.partition,
          offset: m.offset,
        }));

        // Chunk large Kafka batches so a single INSERT stays within a
        // reasonable parameter count and transaction size.
        for (let i = 0; i < messages.length; i += this.config.writeBatchSize) {
          const chunk = messages.slice(i, i + this.config.writeBatchSize);
          try {
            const result = await this.processor.processBatch(chunk);
            this.metrics.batchesProcessed.inc();
            this.logger.debug("processed chunk", {
              topic: batch.topic,
              partition: batch.partition,
              received: result.received,
              persisted: result.persisted,
              duplicates: result.duplicates,
              failed: result.failed,
            });

            // Only resolve offsets that were durably handled.
            for (const message of chunk) {
              resolveOffset(message.offset);
            }
            await heartbeat();
          } catch (err) {
            // Do not resolve offsets: Kafka redelivers this chunk. Persisting a
            // duplicate later is harmless thanks to the upsert.
            this.metrics.batchesRetried.inc();
            this.logger.error("chunk processing failed, will be redelivered", {
              topic: batch.topic,
              partition: batch.partition,
              error: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }
        }

        this.metrics.consumerLag.set(Number(batch.highWatermark) - Number(batch.lastOffset()) - 1, {
          topic: batch.topic,
          partition: String(batch.partition),
        });

        await commitOffsetsIfNecessary();
      },
    });

    this.running = true;
    this.logger.info("consumer running", {
      topic: this.config.kafka.rawTopic,
      groupId: this.config.kafka.groupId,
    });
  }

  async publishToErrorTopic(record: Record<string, unknown>): Promise<void> {
    await this.producer.send({
      topic: this.config.kafka.errorTopic,
      messages: [{ value: JSON.stringify(record) }],
    });
  }

  async publishToProcessedTopic(events: unknown[]): Promise<void> {
    if (events.length === 0) return;
    await this.producer.send({
      topic: this.config.kafka.processedTopic,
      messages: events.map((event) => ({
        key: (event as { installation_id?: string }).installation_id,
        value: JSON.stringify(event),
      })),
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.consumer.disconnect().catch(() => undefined);
    await this.producer.disconnect().catch(() => undefined);
    this.connected = false;
  }
}
