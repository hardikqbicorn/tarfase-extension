import * as vscode from "vscode";
import { CollectorConfig, mergeConfig } from "@ide-collector/event-sdk";

/**
 * Maps VS Code's settings (`telemetry.*` under this extension's contribution)
 * onto the IDE-agnostic SDK config. This is the only place VS Code settings
 * are read, so other IDE adapters can supply their own mapping without the
 * SDK knowing anything about VS Code.
 */
export function readConfig(): CollectorConfig {
  const cfg = vscode.workspace.getConfiguration("telemetry");

  return mergeConfig({
    enabled: cfg.get<boolean>("enabled", false),
    ingestionEndpoint: cfg.get<string>(
      "ingestionEndpoint",
      "http://localhost:8080",
    ),
    registrationEndpoint: cfg.get<string>(
      "registrationEndpoint",
      "http://localhost:8081",
    ),
    batchSize: cfg.get<number>("batchSize", 50),
    flushIntervalMs: cfg.get<number>("flushInterval", 5000),
    maxQueueSize: cfg.get<number>("maxQueueSize", 10_000),
    redactSecrets: cfg.get<boolean>("redactSecrets", true),
    hashFilePaths: cfg.get<boolean>("hashFilePaths", false),
    encryptLocalQueue: cfg.get<boolean>("encryptLocalQueue", true),
    disabledEventTypes: cfg.get<string[]>("disabledEventTypes", []),
    logLevel: cfg.get<CollectorConfig["logLevel"]>("logLevel", "info"),
    capture: {
      workspace: cfg.get<boolean>("capture.workspace", true),
      file: cfg.get<boolean>("capture.file", true),
      editor: cfg.get<boolean>("capture.editor", true),
      terminal: cfg.get<boolean>("capture.terminal", true),
      git: cfg.get<boolean>("capture.git", true),
      buildTestDebug: cfg.get<boolean>("capture.buildTestDebug", true),
      ai: cfg.get<boolean>("capture.ai", true),
      aiContent: cfg.get<boolean>("capture.aiContent", false),
    },
    throttle: {
      cursorMovedMs: cfg.get<number>("throttle.cursorMovedMs", 2000),
      selectionChangedMs: cfg.get<number>("throttle.selectionChangedMs", 1000),
      documentChangedMs: cfg.get<number>("throttle.documentChangedMs", 1000),
      diagnosticsMs: cfg.get<number>("throttle.diagnosticsMs", 5000),
    },
  });
}
