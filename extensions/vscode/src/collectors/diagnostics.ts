import * as vscode from "vscode";
import { EVENT_TYPES } from "@ide-collector/event-schema";
import { toWorkspaceRelative } from "../paths";
import { CollectorRegistration } from "./types";

/**
 * Diagnostics (compiler/linter errors and warnings).
 *
 * Diagnostic *messages* are not collected: they routinely quote source code
 * ("Cannot find name 'API_KEY_VALUE'") and would leak content. Only counts by
 * severity and the reporting source are sent, throttled per file.
 */
export const registerDiagnosticsCollectors: CollectorRegistration = ({
  collector,
  config,
  contextProvider,
}) => {
  const disposables: vscode.Disposable[] = [];
  const root = () => contextProvider.getWorkspaceRoot();

  disposables.push(
    vscode.languages.onDidChangeDiagnostics((event) => {
      for (const uri of event.uris) {
        if (uri.scheme !== "file") continue;

        const diagnostics = vscode.languages.getDiagnostics(uri);
        const relativePath = toWorkspaceRelative(uri.fsPath, root());

        const counts = { errors: 0, warnings: 0, infos: 0, hints: 0 };
        const sources = new Set<string>();
        for (const diagnostic of diagnostics) {
          if (diagnostic.source) sources.add(diagnostic.source);
          switch (diagnostic.severity) {
            case vscode.DiagnosticSeverity.Error:
              counts.errors++;
              break;
            case vscode.DiagnosticSeverity.Warning:
              counts.warnings++;
              break;
            case vscode.DiagnosticSeverity.Information:
              counts.infos++;
              break;
            case vscode.DiagnosticSeverity.Hint:
              counts.hints++;
              break;
          }
        }

        collector.capture({
          eventType: EVENT_TYPES.DIAGNOSTICS_REPORTED,
          file: { path: relativePath },
          payload: {
            error_count: counts.errors,
            warning_count: counts.warnings,
            info_count: counts.infos,
            hint_count: counts.hints,
            total: diagnostics.length,
            sources: [...sources],
          },
          throttle: {
            key: `diagnostics:${relativePath}`,
            intervalMs: config.throttle.diagnosticsMs,
          },
        });
      }
    })
  );

  return disposables;
};
