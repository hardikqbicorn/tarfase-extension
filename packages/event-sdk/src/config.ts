/**
 * SDK configuration shared by every IDE adapter. Adapters map their own
 * IDE-native settings (VS Code `workspace.getConfiguration`, JetBrains
 * `PersistentStateComponent`, ...) onto this shape.
 */
export interface CollectorConfig {
  /** Master opt-in switch. When false the SDK captures nothing at all. */
  enabled: boolean;

  /** Ingestion API base URL, e.g. http://localhost:8080 */
  ingestionEndpoint: string;

  /** Registration endpoint used to obtain an installation credential. */
  registrationEndpoint: string;

  batchSize: number;
  flushIntervalMs: number;
  maxQueueSize: number;

  /** Max delivery attempts before an event is dropped to avoid a poison pill. */
  maxDeliveryAttempts: number;

  /** Per-event-type throttling in ms. 0 = no throttling. */
  throttle: {
    cursorMovedMs: number;
    selectionChangedMs: number;
    documentChangedMs: number;
    diagnosticsMs: number;
  };

  /** Event types the user has explicitly disabled. */
  disabledEventTypes: string[];

  /** Category-level opt-outs. */
  capture: {
    workspace: boolean;
    file: boolean;
    editor: boolean;
    terminal: boolean;
    git: boolean;
    buildTestDebug: boolean;
    ai: boolean;
    aiContent: boolean;
  };

  /** When true, file paths are hashed rather than sent verbatim. */
  hashFilePaths: boolean;

  /** When true, the local offline queue is encrypted at rest. */
  encryptLocalQueue: boolean;

  /** Redact payloads before they leave the IDE process. Strongly recommended. */
  redactSecrets: boolean;

  logLevel: "debug" | "info" | "warn" | "error";
}

export const DEFAULT_CONFIG: CollectorConfig = {
  enabled: false, // opt-in by default; the user must explicitly turn telemetry on
  ingestionEndpoint: "http://localhost:8080",
  registrationEndpoint: "http://localhost:8081",
  batchSize: 50,
  flushIntervalMs: 5000,
  maxQueueSize: 10_000,
  maxDeliveryAttempts: 10,
  throttle: {
    cursorMovedMs: 2000,
    selectionChangedMs: 1000,
    documentChangedMs: 1000,
    diagnosticsMs: 5000,
  },
  disabledEventTypes: [],
  capture: {
    workspace: true,
    file: true,
    editor: true,
    terminal: true,
    git: true,
    buildTestDebug: true,
    ai: true,
    aiContent: false,
  },
  hashFilePaths: false,
  encryptLocalQueue: true,
  redactSecrets: true,
  logLevel: "info",
};

export function mergeConfig(
  partial: Partial<CollectorConfig>,
): CollectorConfig {
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    throttle: { ...DEFAULT_CONFIG.throttle, ...(partial.throttle ?? {}) },
    capture: { ...DEFAULT_CONFIG.capture, ...(partial.capture ?? {}) },
  };
}
