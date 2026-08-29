import * as vscode from "vscode";
import { AdapterCapabilities, EventCollector, IdeAdapter } from "@ide-collector/event-sdk";
import { CollectorConfig } from "@ide-collector/event-sdk";
import { VSCodeContextProvider } from "./context-provider";
import { GitIntegration } from "./git-integration";
import { CollectorDeps } from "./collectors/types";
import { registerWorkspaceCollectors } from "./collectors/workspace";
import { registerFileCollectors } from "./collectors/files";
import { registerEditorCollectors } from "./collectors/editor";
import { registerTerminalCollectors } from "./collectors/terminal";
import { registerGitCollectors } from "./collectors/git";
import { registerDebugCollectors } from "./collectors/debug";
import { registerTaskCollectors } from "./collectors/tasks";
import { registerDiagnosticsCollectors } from "./collectors/diagnostics";
import { registerAiCollectors, probeAiCapabilities } from "./collectors/ai";

/**
 * The VS Code implementation of `IdeAdapter`. This is the *only* VS Code-aware
 * layer in the pipeline: everything downstream (SDK, schema, Kafka, database)
 * is IDE-agnostic. A new IDE means a new class like this one and nothing else.
 *
 * Cursor and Windsurf are VS Code forks, so they reuse this adapter with a
 * different `ideName` (see extensions/cursor and extensions/windsurf).
 */
export class VSCodeAdapter implements IdeAdapter {
  private disposables: vscode.Disposable[] = [];

  constructor(
    readonly ideName: string,
    private readonly config: CollectorConfig,
    private readonly contextProvider: VSCodeContextProvider,
    private readonly git: GitIntegration
  ) {}

  get capabilities(): AdapterCapabilities {
    const ai = probeAiCapabilities();
    const windowApi = vscode.window as unknown as Record<string, unknown>;
    return {
      workspace: true,
      file: true,
      editor: true,
      terminal: true,
      // Shell integration is only present in recent VS Code builds.
      terminalCommandCapture: typeof windowApi.onDidStartTerminalShellExecution === "function",
      git: this.git.isAvailable(),
      build: true,
      test: true,
      debug: true,
      diagnostics: true,
      ai: ai.observableAssistant,
      aiToolCalls: false,
    };
  }

  activate(collector: EventCollector): void {
    const deps: CollectorDeps = {
      collector,
      config: this.config,
      contextProvider: this.contextProvider,
      git: this.git,
    };

    const registrations = [
      registerWorkspaceCollectors,
      registerFileCollectors,
      registerEditorCollectors,
      registerTerminalCollectors,
      registerGitCollectors,
      registerDebugCollectors,
      registerTaskCollectors,
      registerDiagnosticsCollectors,
      registerAiCollectors,
    ];

    for (const register of registrations) {
      try {
        this.disposables.push(...register(deps));
      } catch (err) {
        // A single collector failing to attach must never prevent the others
        // from working or break the host IDE.
        // eslint-disable-next-line no-console
        console.error("[ide-collector] collector registration failed", err);
      }
    }
  }

  deactivate(): void {
    for (const disposable of this.disposables) {
      try {
        disposable.dispose();
      } catch {
        // Ignore: we are shutting down.
      }
    }
    this.disposables = [];
  }
}
