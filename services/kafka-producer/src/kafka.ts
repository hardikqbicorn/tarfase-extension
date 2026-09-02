import { Kafka, Producer, CompressionTypes, logLevel as kafkaLogLevel } from "kafkajs";
import { IDEEvent } from "@ide-collector/event-schema";
import { Logger } from "@ide-collector/shared-utils";
import { ProducerServiceConfig } from "./config";

export interface EventPublisher {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  publish(events: IDEEvent[]): Promise<void>;
  publishError(record: Record<string, unknown>): Promise<void>;
  isConnected(): boolean;
}

/**
 * Idempotent Kafka producer.
 *
 * `idempotent: true` gives exactly-once semantics *per producer session* at
 * the broker level (dedupe by producer id + sequence number), which prevents
 * a retry storm from writing duplicates. End-to-end dedupe across producer
 * restarts is still handled downstream by the consumer's upsert on event_id.
 *
 * Partitioning: the message key is `installation_id`, so all events from one
 * installation land on one partition and therefore preserve per-installation
 * ordering while still spreading load across the cluster.
 */
export class KafkaEventPublisher implements EventPublisher {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private connected = false;

  constructor(
    private readonly config: ProducerServiceConfig,
    private readonly logger: Logger
  ) {
    this.kafka = new Kafka({
      clientId: config.kafka.clientId,
      brokers: config.kafka.brokers,
      ssl: config.kafka.ssl,
      sasl: config.kafka.sasl,
      requestTimeout: config.kafka.requestTimeoutMs,
      retry: { retries: config.kafka.retries, initialRetryTime: 300 },
      logLevel: kafkaLogLevel.WARN,
    });

    this.producer = this.kafka.producer({
      idempotent: true,
      // Idempotent producers require maxInFlightRequests <= 5 to preserve ordering.
      maxInFlightRequests: 5,
      retry: { retries: config.kafka.retries },
    });

    this.producer.on("producer.connect", () => {
      this.connected = true;
      this.logger.info("kafka producer connected", { brokers: config.kafka.brokers });
    });
    this.producer.on("producer.disconnect", () => {
      this.connected = false;
      this.logger.warn("kafka producer disconnected");
    });
  }

  async connect(): Promise<void> {
    await this.producer.connect();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    await this.producer.disconnect();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async publish(events: IDEEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.producer.send({
      topic: this.config.kafka.rawTopic,
      acks: this.config.kafka.acks,
      compression: CompressionTypes.GZIP,
      messages: events.map((event) => ({
        key: event.installation_id,
        value: JSON.stringify(event),
        headers: {
          event_id: event.event_id,
          event_type: event.event_type,
          schema_version: event.schema_version,
          ide_name: event.ide.name,
        },
        timestamp: String(Date.parse(event.timestamp)),
      })),
    });
  }

  async publishError(record: Record<string, unknown>): Promise<void> {
    await this.producer.send({
      topic: this.config.kafka.errorTopic,
      acks: this.config.kafka.acks,
      messages: [{ value: JSON.stringify(record) }],
    });
  }
}
