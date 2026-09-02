import * as vscode from "vscode";
import { EVENT_TYPES } from "@ide-collector/event-schema";
import { isSensitiveFile, toWorkspaceRelative } from "../paths";
import {
  SnapshotStore,
  attributeChanges,
  buildPayload,
  diffLines,
  isReportable,
  readDocumentSymbols,
  splitLines,
} from "../code-structure";
import { CollectorRegistration } from "./types";

/**
 * Turns each save into a structural summary: which functions, classes and
 * variables changed, and how much of the file did not.
 *
 * Save is the unit rather than each keystroke. A save is what a developer
 * means by "a change", it is when the file is syntactically whole enough for a
 * language server to parse, and it keeps this to one provider call per save
 * instead of one per debounce window.
 *
 * The previous contents are held in memory only to compute line numbers. No
 * source line is ever put on an event - see payload.ts.
 */
export const registerCodeStructureCollectors: CollectorRegistration = ({
  collector,
  config,
  contextProvider,
}) => {
  if (!config.capture.codeStructure) return [];

  const disposables: vscode.Disposable[] = [];
  const snapshots = new SnapshotStore();
  const root = () => contextProvider.getWorkspaceRoot();

  // Sensitive files are never even snapshotted: a .env has no functions to
  // report, and holding its contents in memory buys nothing.
  const isTrackable = (document: vscode.TextDocument): boolean =>
    document.uri.scheme === "file" &&
    !document.isUntitled &&
    !isSensitiveFile(document.uri.fsPath);

  const remember = (document: vscode.TextDocument) => {
    if (!isTrackable(document)) return;
    snapshots.set(document.uri.fsPath, document.getText());
  };

  // Files already open when collection starts, so the first save of an
  // existing document is a real diff rather than a whole-file insertion.
  for (const document of vscode.workspace.textDocuments) remember(document);

  disposables.push(vscode.workspace.onDidOpenTextDocument(remember));

  disposables.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      snapshots.delete(document.uri.fsPath);
    })
  );

  disposables.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (!isTrackable(document)) return;

      const path = document.uri.fsPath;
      const before = snapshots.get(path);
      const text = document.getText();

      // Update the snapshot first and unconditionally: if the work below
      // throws or the file is too large to track, the next save must not diff
      // against a stale copy and report the whole file as changed.
      const tracked = snapshots.set(path, text);

      if (!before || !tracked) return;

      const diff = diffLines(before, splitLines(text));
      if (!isReportable(diff)) return;

      // Fire-and-forget: the symbol provider is async and a save must not wait
      // on it. Errors are contained inside readDocumentSymbols.
      void (async () => {
        const { symbols, status } = await readDocumentSymbols(document.uri);

        collector.capture({
          eventType: EVENT_TYPES.CODE_SYMBOLS_CHANGED,
          file: {
            path: toWorkspaceRelative(path, root()),
            language: document.languageId,
          },
          payload: buildPayload(diff, attributeChanges(diff.hunks, symbols), status),
        });
      })();
    })
  );

  disposables.push(new vscode.Disposable(() => snapshots.clear()));

  return disposables;
};
