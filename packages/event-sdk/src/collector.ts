import { createHash } from "crypto";
import { createEvent, CreateEventInput, IDEEvent } from "@ide-collector/event-schema";
import { Redactor } from "@ide-collector/crypto";
import { Logger } from "@ide-collector/shared-utils";
import { CollectorConfig, DEFAULT_CONFIG } from "./config";
import { CollectorIdentity, ContextProvider } from "./context";
import { EventQueue } from "./queue";
import { EventTransport, TransportError } from "./transport";
import { CollectorMetrics, createEmptyMetrics } from "./metrics";

export interface CaptureInput {
  eventType: string;
  file?: IDEEvent["file"];
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /** Overrides the context provider's repository info for this event. */
  repository?: IDEEvent["repository"];
  /** Throttle key + interval; identical keys collapse within the interval. */
  throttle?: { key: string; intervalMs: number };
}

export interface EventCollectorOptions {
  config: CollectorConfig;
  identity: CollectorIdentity;
  contextProvider: ContextProvider;
  queue: EventQueue;
  transport: EventTransport;
  logger?: Logger;
  redactor?: Redactor;
}

/**
 * The heart of the SDK: takes normalized capture calls from any IDE adapter,
 * applies opt-out/throttle/redaction policy, buffers locally, and drains the
 * buffer to the ingestion service in batches on a timer.
 *
 * Every public method is non-blocking. `capture()` does synchronous work only
 * (policy checks + an array push) so it is safe to call from IDE event
 * handlers on the UI thread.
 */
export class EventCollector {
  private readonly config: CollectorConfig;
  private readonly identity: CollectorIdentity;
  private readonly contextProvider: ContextProvider;
  private readonly queue: EventQueue;
  private readonly transport: EventTransport;
  private readonly logger: Logger;
  private readonly redactor: Redactor;

  private readonly throttleState = new Map<string, number>();
  private metrics: CollectorMetrics = createEmptyMetrics();
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private flushInFlight = false;
  private disposed = false;

  constructor(options: EventCollectorOptions) {
    this.config = options.config ?? DEFAULT_CONFIG;
    this.identity = options.identity;
    this.contextProvider = options.contextProvider;
    this.queue = options.queue;
    this.transport = options.transport;
    this.logger =
      options.logger ?? new Logger({ service: "event-sdk", level: this.config.logLevel });
    this.redactor = options.redactor ?? new Redactor();
  }

  async start(): Promise<void> {
    await this.queue.init();
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.config.flushIntervalMs);
    // Node's unref keeps the timer from holding the host process open.
    (this.flushTimer as unknown as { unref?: () => void }).unref?.();
    this.logger.info("event collector started", {
      queueSize: this.queue.size,
      flushIntervalMs: this.config.flushIntervalMs,
    });
  }

  /**
   * Records an event. Returns the event that was queued, or `undefined` when
   * policy (opt-out, filter, throttle) suppressed it.
   */
  capture(input: CaptureInput): IDEEvent | undefined {
    if (this.disposed || !this.config.enabled) return undefined;

    if (this.config.disabledEventTypes.includes(input.eventType)) {
      this.metrics.eventsFiltered++;
      return undefined;
    }

    if (!this.isCategoryEnabled(input.eventType)) {
      this.metrics.eventsFiltered++;
      return undefined;
    }

    if (input.throttle && this.isThrottled(input.throttle.key, input.throttle.intervalMs)) {
      this.metrics.eventsThrottled++;
      return undefined;
    }

    const context = this.contextProvider.getContext();
    const eventInput: CreateEventInput = {
      eventType: input.eventType,
      userId: this.identity.userId,
      installationId: this.identity.installationId,
      sessionId: this.identity.sessionId,
      ide: context.ide,
      workspace: context.workspace,
      project: context.project,
      repository: input.repository ?? context.repository,
      file: this.normalizeFile(input.file),
      payload: input.payload,
      metadata: input.metadata,
    };

    let event = createEvent(eventInput);
    if (this.config.redactSecrets) {
      event = this.redactor.redactEvent(event);
    }

    this.queue.enqueue(event);
    this.metrics.eventsCaptured++;
    this.metrics.queueSize = this.queue.size;
    return event;
  }

  /** Drains one batch from the queue to the transport. Safe to call concurrently. */
  async flush(): Promise<void> {
    if (this.flushInFlight || this.disposed || !this.config.enabled) return;

    const batch = this.queue.peekReady(this.config.batchSize);
    if (batch.length === 0) return;

    // Drop poison-pill events that have exhausted their retry budget so a
    // single permanently-failing event cannot block the queue forever.
    const exhausted = batch.filter((i) => i.attempts >= this.config.maxDeliveryAttempts);
    if (exhausted.length > 0) {
      this.queue.ack(exhausted.map((i) => i.event.event_id));
      this.metrics.eventsDropped += exhausted.length;
      this.logger.warn("dropping events after exhausting delivery attempts", {
        count: exhausted.length,
      });
    }

    const sendable = batch.filter((i) => i.attempts < this.config.maxDeliveryAttempts);
    if (sendable.length === 0) return;

    this.flushInFlight = true;
    const startedAt = Date.now();
    try {
      const result = await this.transport.send(sendable.map((i) => i.event));
      const settled = [...result.accepted, ...result.rejected];
      this.queue.ack(settled);
      this.metrics.eventsSent += result.accepted.length;
      this.metrics.eventsRejected += result.rejected.length;
      this.metrics.flushSuccesses++;
      this.metrics.lastFlushLatencyMs = Date.now() - startedAt;
      this.metrics.lastFlushAt = new Date().toISOString();
      this.metrics.queueSize = this.queue.size;

      if (result.rejected.length > 0) {
        this.logger.warn("ingestion rejected events", { count: result.rejected.length });
      }
    } catch (err) {
      // Leave the events in the queue; nack applies exponential backoff.
      this.queue.nack(sendable.map((i) => i.event.event_id));
      this.metrics.flushFailures++;
      this.metrics.retryCount += sendable.length;
      this.metrics.queueSize = this.queue.size;
      this.metrics.lastErrorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn("flush failed, events retained for retry", {
        error: this.metrics.lastErrorMessage,
        queueSize: this.queue.size,
        retryable: err instanceof TransportError ? err.retryable : true,
      });
    } finally {
      this.flushInFlight = false;
    }
  }

  getMetrics(): CollectorMetrics {
    return { ...this.metrics, queueSize: this.queue.size };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    // Persist whatever is left so it survives the IDE restart.
    await this.queue.dispose();
    this.logger.info("event collector disposed", { queueSize: this.queue.size });
  }

  private isThrottled(key: string, intervalMs: number): boolean {
    if (intervalMs <= 0) return false;
    const now = Date.now();
    const last = this.throttleState.get(key);
    if (last !== undefined && now - last < intervalMs) return true;
    this.throttleState.set(key, now);
    return false;
  }

  private isCategoryEnabled(eventType: string): boolean {
    const category = eventType.split(".")[0];
    const capture = this.config.capture;
    switch (category) {
      case "workspace":
      case "project":
        return capture.workspace;
      case "file":
        return capture.file;
      case "editor":
        return capture.editor;
      case "terminal":
        return capture.terminal;
      case "git":
        return capture.git;
      case "build":
      case "test":
      case "debugger":
      case "breakpoint":
      case "diagnostics":
        return capture.buildTestDebug;
      case "ai":
        return capture.ai;
      default:
        // session.*/extension.* lifecycle events are always allowed.
        return true;
    }
  }

  private normalizeFile(file: IDEEvent["file"]): IDEEvent["file"] {
    if (!file) return file;
    if (!this.config.hashFilePaths || !file.path) return file;
    return {
      ...file,
      path: `sha256:${createHash("sha256").update(file.path).digest("hex").slice(0, 32)}`,
    };
  }
}
