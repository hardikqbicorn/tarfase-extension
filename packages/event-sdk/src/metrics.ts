/** Lightweight in-process counters an adapter can surface in an IDE status bar. */
export interface CollectorMetrics {
  eventsCaptured: number;
  eventsThrottled: number;
  eventsFiltered: number;
  eventsSent: number;
  eventsRejected: number;
  eventsDropped: number;
  flushSuccesses: number;
  flushFailures: number;
  retryCount: number;
  queueSize: number;
  lastFlushLatencyMs: number;
  lastFlushAt?: string;
  lastErrorMessage?: string;
}

export function createEmptyMetrics(): CollectorMetrics {
  return {
    eventsCaptured: 0,
    eventsThrottled: 0,
    eventsFiltered: 0,
    eventsSent: 0,
    eventsRejected: 0,
    eventsDropped: 0,
    flushSuccesses: 0,
    flushFailures: 0,
    retryCount: 0,
    queueSize: 0,
    lastFlushLatencyMs: 0,
  };
}
