import { EventCollector } from "./collector";

/**
 * The contract every IDE integration implements. Adding a new IDE means
 * writing one class that satisfies this interface under `extensions/<ide>/`
 * — the SDK, schema, ingestion service, and database stay untouched.
 */
export interface IdeAdapter {
  /** Stable identifier written to `ide.name` on every event, e.g. "vscode". */
  readonly ideName: string;

  /** Wires the IDE's native listeners up to `collector.capture(...)`. */
  activate(collector: EventCollector): Promise<void> | void;

  /** Tears listeners down. The SDK flushes the queue separately. */
  deactivate(): Promise<void> | void;

  /**
   * Declares which event categories this IDE can actually produce. Anything
   * absent is reported once as `ai.feature_unavailable`-style metadata rather
   * than silently missing, so downstream analytics can tell "no data" apart
   * from "not supported here".
   */
  readonly capabilities: AdapterCapabilities;
}

export interface AdapterCapabilities {
  workspace: boolean;
  file: boolean;
  editor: boolean;
  terminal: boolean;
  terminalCommandCapture: boolean;
  git: boolean;
  build: boolean;
  test: boolean;
  debug: boolean;
  diagnostics: boolean;
  ai: boolean;
  aiToolCalls: boolean;
}

export const NO_CAPABILITIES: AdapterCapabilities = {
  workspace: false,
  file: false,
  editor: false,
  terminal: false,
  terminalCommandCapture: false,
  git: false,
  build: false,
  test: false,
  debug: false,
  diagnostics: false,
  ai: false,
  aiToolCalls: false,
};
