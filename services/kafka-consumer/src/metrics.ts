import { Counter, Gauge, Histogram, MetricsRegistry } from "@ide-collector/shared-utils";

export interface ConsumerMetrics {
  registry: MetricsRegistry;
  eventsReceived: Counter;
  eventsPersisted: Counter;
  eventsDuplicate: Counter;
  eventsFailed: Counter;
  eventsByType: Counter;
  batchesProcessed: Counter;
  batchesRetried: Counter;
  consumerLag: Gauge;
  batchLatency: Histogram;
  dbWriteLatency: Histogram;
}

export function createConsumerMetrics(): ConsumerMetrics {
  const registry = new MetricsRegistry();
  return {
    registry,
    eventsReceived: registry.counter(
      "consumer_events_received_total",
      "Messages consumed from the raw topic"
    ),
    eventsPersisted: registry.counter(
      "consumer_events_persisted_total",
      "Events newly written to the database"
    ),
    eventsDuplicate: registry.counter(
      "consumer_events_duplicate_total",
      "Events skipped because they were already stored (idempotency hits)"
    ),
    eventsFailed: registry.counter(
      "consumer_events_failed_total",
      "Events routed to the dead-letter path"
    ),
    eventsByType: registry.counter(
      "consumer_events_by_type_total",
      "Persisted events broken down by event type and IDE"
    ),
    batchesProcessed: registry.counter(
      "consumer_batches_processed_total",
      "Batches processed successfully"
    ),
    batchesRetried: registry.counter(
      "consumer_batches_retried_total",
      "Batches that threw and will be redelivered"
    ),
    consumerLag: registry.gauge("consumer_lag_messages", "Approximate consumer lag per partition"),
    batchLatency: registry.histogram(
      "consumer_batch_duration_ms",
      "Time to process one batch end to end"
    ),
    dbWriteLatency: registry.histogram(
      "consumer_db_write_duration_ms",
      "Database write latency per batch"
    ),
  };
}
