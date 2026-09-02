import * as vscode from "vscode";
import { EVENT_TYPES } from "@ide-collector/event-schema";
import { toWorkspaceRelative } from "../paths";
import { CollectorRegistration } from "./types";

/**
 * Debugger and breakpoint events. Debug configuration *values* are not
 * collected - launch configs routinely embed connection strings and tokens in
 * `env`. Only the configuration's name and type are reported.
 */
export const registerDebugCollectors: CollectorRegistration = ({
  collector,
  contextProvider,
}) => {
  const disposables: vscode.Disposable[] = [];
  const root = () => contextProvider.getWorkspaceRoot();
  const sessionStartTimes = new Map<string, number>();

  disposables.push(
    vscode.debug.onDidStartDebugSession((session) => {
      sessionStartTimes.set(session.id, Date.now());
      collector.capture({
        eventType: EVENT_TYPES.DEBUGGER_STARTED,
        payload: {
          session_name: session.name,
          debug_type: session.type,
          parent_session: session.parentSession?.id ?? null,
        },
      });
    })
  );

  disposables.push(
    vscode.debug.onDidTerminateDebugSession((session) => {
      const startedAt = sessionStartTimes.get(session.id);
      sessionStartTimes.delete(session.id);
      collector.capture({
        eventType: EVENT_TYPES.DEBUGGER_STOPPED,
        payload: {
          session_name: session.name,
          debug_type: session.type,
          duration_ms: startedAt ? Date.now() - startedAt : null,
        },
      });
    })
  );

  disposables.push(
    vscode.debug.onDidChangeBreakpoints((event) => {
      for (const breakpoint of event.added) {
        collector.capture({
          eventType: EVENT_TYPES.BREAKPOINT_ADDED,
          file: locationOf(breakpoint, root()),
          payload: {
            enabled: breakpoint.enabled,
            // The *presence* of a condition is signal; the expression itself
            // can reference sensitive values, so it is not collected.
            has_condition: Boolean(breakpoint.condition),
            has_hit_condition: Boolean(breakpoint.hitCondition),
          },
        });
      }
      for (const breakpoint of event.removed) {
        collector.capture({
          eventType: EVENT_TYPES.BREAKPOINT_REMOVED,
          file: locationOf(breakpoint, root()),
          payload: { enabled: breakpoint.enabled },
        });
      }
    })
  );

  return disposables;
};

function locationOf(
  breakpoint: vscode.Breakpoint,
  workspaceRoot: string | undefined
): { path?: string } | undefined {
  const source = breakpoint as vscode.SourceBreakpoint;
  if (!source.location) return undefined;
  return { path: toWorkspaceRelative(source.location.uri.fsPath, workspaceRoot) };
}
