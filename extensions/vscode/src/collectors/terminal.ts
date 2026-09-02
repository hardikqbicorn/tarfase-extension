import * as vscode from "vscode";
import { EVENT_TYPES } from "@ide-collector/event-schema";
import { CollectorRegistration } from "./types";

/**
 * Terminal events.
 *
 * Command capture uses the shell-integration API (VS Code 1.93+), which is
 * proposed/unstable in some builds, so it is accessed defensively and simply
 * reported as unavailable where absent.
 *
 * Terminal output is NEVER captured: it routinely contains tokens, connection
 * strings, and credentials. Only the command line is captured, and only after
 * passing through the redactor - so `export AWS_SECRET_ACCESS_KEY=...` reaches
 * the backend with the value stripped.
 */
export const registerTerminalCollectors: CollectorRegistration = ({ collector }) => {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.window.onDidOpenTerminal((terminal) => {
      collector.capture({
        eventType: EVENT_TYPES.TERMINAL_CREATED,
        payload: {
          name: terminal.name,
          shell_integration_available: Boolean((terminal as { shellIntegration?: unknown }).shellIntegration),
        },
      });
    })
  );

  disposables.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      collector.capture({
        eventType: EVENT_TYPES.TERMINAL_CLOSED,
        payload: { name: terminal.name, exit_code: terminal.exitStatus?.code ?? null },
      });
    })
  );

  disposables.push(
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      if (!terminal) return;
      collector.capture({
        eventType: EVENT_TYPES.TERMINAL_OPENED,
        payload: { name: terminal.name },
      });
    })
  );

  // ---- Shell integration (command execution + exit codes) -------------------
  const windowApi = vscode.window as unknown as {
    onDidStartTerminalShellExecution?: (
      listener: (event: {
        terminal: vscode.Terminal;
        execution: { commandLine?: { value?: string } };
      }) => void
    ) => vscode.Disposable;
    onDidEndTerminalShellExecution?: (
      listener: (event: {
        terminal: vscode.Terminal;
        execution: { commandLine?: { value?: string } };
        exitCode?: number;
      }) => void
    ) => vscode.Disposable;
  };

  if (typeof windowApi.onDidStartTerminalShellExecution === "function") {
    disposables.push(
      windowApi.onDidStartTerminalShellExecution((event) => {
        const commandLine = event.execution?.commandLine?.value;
        collector.capture({
          eventType: EVENT_TYPES.TERMINAL_COMMAND_EXECUTED,
          payload: {
            terminal_name: event.terminal?.name,
            // Redacted by the SDK before it leaves this process.
            command: commandLine,
            command_name: firstToken(commandLine),
          },
        });
      })
    );
  }

  if (typeof windowApi.onDidEndTerminalShellExecution === "function") {
    disposables.push(
      windowApi.onDidEndTerminalShellExecution((event) => {
        const commandLine = event.execution?.commandLine?.value;
        collector.capture({
          eventType: EVENT_TYPES.TERMINAL_COMMAND_COMPLETED,
          payload: {
            terminal_name: event.terminal?.name,
            command: commandLine,
            command_name: firstToken(commandLine),
            exit_code: event.exitCode ?? null,
            succeeded: event.exitCode === 0,
          },
        });
      })
    );
  }

  return disposables;
};

/**
 * The bare executable name (`npm`, `git`, `psql`). Safe to aggregate on even
 * when the full command line is redacted.
 */
function firstToken(commandLine: string | undefined): string | undefined {
  if (!commandLine) return undefined;
  const trimmed = commandLine.trim();
  if (!trimmed) return undefined;
  // Skip leading env-var assignments (`FOO=bar cmd`), which could carry secrets.
  const tokens = trimmed.split(/\s+/);
  for (const token of tokens) {
    if (!token.includes("=")) return token;
  }
  return undefined;
}
