import * as vscode from "vscode";
import { EVENT_TYPES } from "@ide-collector/event-schema";
import { toWorkspaceRelative } from "../paths";
import { CollectorRegistration } from "./types";

/**
 * Editor events. These are the highest-frequency signals in the IDE - a
 * document-change event fires on every keystroke - so each one is throttled
 * per file via the SDK's throttle keys. Never any document *content*: only
 * shape (line/character counts).
 */
export const registerEditorCollectors: CollectorRegistration = ({
  collector,
  config,
  contextProvider,
}) => {
  const disposables: vscode.Disposable[] = [];
  const root = () => contextProvider.getWorkspaceRoot();

  disposables.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor || editor.document.uri.scheme !== "file") return;
      collector.capture({
        eventType: EVENT_TYPES.EDITOR_ACTIVE_CHANGED,
        file: {
          path: toWorkspaceRelative(editor.document.uri.fsPath, root()),
          language: editor.document.languageId,
        },
        payload: { line_count: editor.document.lineCount },
      });
    })
  );

  disposables.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      const document = event.textEditor.document;
      if (document.uri.scheme !== "file") return;

      const relativePath = toWorkspaceRelative(document.uri.fsPath, root());
      const primary = event.selections[0];
      const hasSelection = primary ? !primary.isEmpty : false;

      // A collapsed selection is a cursor move; a non-empty one is a selection.
      const eventType = hasSelection
        ? EVENT_TYPES.EDITOR_SELECTION_CHANGED
        : EVENT_TYPES.EDITOR_CURSOR_MOVED;
      const intervalMs = hasSelection
        ? config.throttle.selectionChangedMs
        : config.throttle.cursorMovedMs;

      collector.capture({
        eventType,
        file: { path: relativePath, language: document.languageId },
        payload: {
          selection_count: event.selections.length,
          // Positions are structural, not content.
          line: primary?.active.line,
          selected_lines: hasSelection
            ? Math.abs(primary.end.line - primary.start.line) + 1
            : 0,
          kind: event.kind !== undefined ? vscode.TextEditorSelectionChangeKind[event.kind] : undefined,
        },
        throttle: { key: `${eventType}:${relativePath}`, intervalMs },
      });
    })
  );

  disposables.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme !== "file") return;
      if (event.contentChanges.length === 0) return;

      const relativePath = toWorkspaceRelative(event.document.uri.fsPath, root());
      const charsAdded = event.contentChanges.reduce((sum, c) => sum + c.text.length, 0);
      const charsRemoved = event.contentChanges.reduce((sum, c) => sum + c.rangeLength, 0);

      collector.capture({
        eventType: EVENT_TYPES.EDITOR_DOCUMENT_CHANGED,
        file: { path: relativePath, language: event.document.languageId },
        payload: {
          change_count: event.contentChanges.length,
          chars_added: charsAdded,
          chars_removed: charsRemoved,
          line_count: event.document.lineCount,
          // A large single insertion is a strong signal of a paste or an AI
          // completion; the text itself is never collected.
          likely_bulk_insert: charsAdded > 200 && event.contentChanges.length === 1,
        },
        throttle: {
          key: `document_changed:${relativePath}`,
          intervalMs: config.throttle.documentChangedMs,
        },
      });

      collector.capture({
        eventType: EVENT_TYPES.FILE_MODIFIED,
        file: { path: relativePath, language: event.document.languageId },
        payload: { is_dirty: event.document.isDirty },
        throttle: {
          key: `file_modified:${relativePath}`,
          intervalMs: config.throttle.documentChangedMs,
        },
      });
    })
  );

  return disposables;
};
