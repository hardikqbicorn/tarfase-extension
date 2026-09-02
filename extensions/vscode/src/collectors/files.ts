import * as vscode from "vscode";
import { EVENT_TYPES } from "@ide-collector/event-schema";
import { isSensitiveFile, toWorkspaceRelative } from "../paths";
import { CollectorRegistration } from "./types";

/**
 * File lifecycle events. Only real files on disk are reported: VS Code fires
 * document events for output channels, git diff views, settings editors, and
 * other virtual documents, which are noise (and in the git case can carry file
 * contents in the URI).
 */
export const registerFileCollectors: CollectorRegistration = ({
  collector,
  contextProvider,
}) => {
  const disposables: vscode.Disposable[] = [];
  const root = () => contextProvider.getWorkspaceRoot();

  const isRealFile = (document: vscode.TextDocument): boolean => document.uri.scheme === "file";

  const fileInfo = (document: vscode.TextDocument) => ({
    path: toWorkspaceRelative(document.uri.fsPath, root()),
    language: document.languageId,
  });

  disposables.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (!isRealFile(document)) return;
      collector.capture({
        eventType: EVENT_TYPES.FILE_OPENED,
        file: fileInfo(document),
        payload: {
          line_count: document.lineCount,
          is_untitled: document.isUntitled,
          is_sensitive: isSensitiveFile(document.uri.fsPath),
        },
      });
    })
  );

  disposables.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (!isRealFile(document)) return;
      collector.capture({
        eventType: EVENT_TYPES.FILE_CLOSED,
        file: fileInfo(document),
        payload: { line_count: document.lineCount },
      });
    })
  );

  disposables.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (!isRealFile(document)) return;
      collector.capture({
        eventType: EVENT_TYPES.FILE_SAVED,
        file: fileInfo(document),
        payload: {
          line_count: document.lineCount,
          size_bytes: document.getText().length,
        },
      });
    })
  );

  disposables.push(
    vscode.workspace.onDidCreateFiles((event) => {
      for (const uri of event.files) {
        collector.capture({
          eventType: EVENT_TYPES.FILE_CREATED,
          file: { path: toWorkspaceRelative(uri.fsPath, root()) },
          payload: {},
        });
      }
    })
  );

  disposables.push(
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const uri of event.files) {
        collector.capture({
          eventType: EVENT_TYPES.FILE_DELETED,
          file: { path: toWorkspaceRelative(uri.fsPath, root()) },
          payload: {},
        });
      }
    })
  );

  disposables.push(
    vscode.workspace.onDidRenameFiles((event) => {
      for (const { oldUri, newUri } of event.files) {
        collector.capture({
          eventType: EVENT_TYPES.FILE_RENAMED,
          file: { path: toWorkspaceRelative(newUri.fsPath, root()) },
          payload: {
            old_path: toWorkspaceRelative(oldUri.fsPath, root()),
            new_path: toWorkspaceRelative(newUri.fsPath, root()),
          },
        });
      }
    })
  );

  return disposables;
};
