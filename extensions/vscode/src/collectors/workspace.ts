import * as vscode from "vscode";
import { EVENT_TYPES } from "@ide-collector/event-schema";
import { CollectorRegistration } from "./types";

/** Workspace and project lifecycle events. */
export const registerWorkspaceCollectors: CollectorRegistration = ({
  collector,
  contextProvider,
}) => {
  const disposables: vscode.Disposable[] = [];

  // The extension activates after the workspace is already open, so the
  // "opened" event is emitted once at activation rather than from a listener.
  const folders = vscode.workspace.workspaceFolders ?? [];
  collector.capture({
    eventType: EVENT_TYPES.WORKSPACE_OPENED,
    payload: {
      folder_count: folders.length,
      is_multi_root: folders.length > 1,
      is_untrusted: vscode.workspace.isTrusted === false,
    },
  });

  if (contextProvider.getWorkspaceRoot()) {
    collector.capture({
      eventType: EVENT_TYPES.PROJECT_OPENED,
      payload: { folder_count: folders.length },
    });
  }

  disposables.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      collector.capture({
        eventType: EVENT_TYPES.PROJECT_CHANGED,
        payload: {
          added: event.added.length,
          removed: event.removed.length,
          total: vscode.workspace.workspaceFolders?.length ?? 0,
        },
      });
    })
  );

  disposables.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      // Only the fact that *our* settings changed is interesting; user settings
      // in general are none of this extension's business.
      if (event.affectsConfiguration("telemetry")) {
        collector.capture({
          eventType: EVENT_TYPES.PROJECT_CHANGED,
          payload: { reason: "telemetry_configuration_changed" },
        });
      }
    })
  );

  return disposables;
};
