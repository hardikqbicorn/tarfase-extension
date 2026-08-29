import { IDEEvent } from "@ide-collector/event-schema";

export interface TransportResult {
  /** Event IDs the server confirmed it accepted (persisted to Kafka). */
  accepted: string[];
  /** Event IDs the server permanently rejected (invalid schema) - do not retry. */
  rejected: string[];
}

export interface EventTransport {
  send(events: IDEEvent[]): Promise<TransportResult>;
}

export class TransportError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    /** Whether the caller should retry this batch later. */
    readonly retryable: boolean = true
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export interface HttpTransportOptions {
  endpoint: string;
  /** Returns the current installation credential; re-read each call so a refresh is picked up. */
  getAuthToken: () => Promise<string | undefined>;
  installationId: string;
  timeoutMs?: number;
  /** Injectable for tests / non-Node hosts. */
  fetchImpl?: typeof fetch;
}

/**
 * Ships batches to the ingestion service over HTTPS. The extension never
 * talks to Kafka directly: brokers are not exposed to end-user machines,
 * and the ingestion service owns authentication and validation.
 */
export class HttpEventTransport implements EventTransport {
  constructor(private readonly options: HttpTransportOptions) {}

  async send(events: IDEEvent[]): Promise<TransportResult> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new TransportError("No fetch implementation available", undefined, false);
    }

    const token = await this.options.getAuthToken();
    if (!token) {
      throw new TransportError("Missing installation credential", 401, true);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);

    try {
      const response = await fetchImpl(`${this.options.endpoint}/v1/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          installation_id: this.options.installationId,
          events,
        }),
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        throw new TransportError("Installation credential rejected", response.status, true);
      }

      if (response.status === 400 || response.status === 422) {
        // Permanently invalid batch: the server tells us which events to drop.
        const body = (await response.json().catch(() => ({}))) as {
          rejected?: string[];
          accepted?: string[];
        };
        return {
          accepted: body.accepted ?? [],
          rejected: body.rejected ?? events.map((e) => e.event_id),
        };
      }

      if (!response.ok) {
        throw new TransportError(
          `Ingestion returned ${response.status}`,
          response.status,
          response.status >= 500 || response.status === 429
        );
      }

      const body = (await response.json().catch(() => ({}))) as {
        accepted?: string[];
        rejected?: string[];
      };
      return {
        accepted: body.accepted ?? events.map((e) => e.event_id),
        rejected: body.rejected ?? [],
      };
    } catch (err) {
      if (err instanceof TransportError) throw err;
      throw new TransportError(
        err instanceof Error ? err.message : "Unknown transport failure",
        undefined,
        true
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
