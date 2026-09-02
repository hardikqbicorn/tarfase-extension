import * as vscode from "vscode";
import { SymbolNode } from "./attribute";

/**
 * Reads the document symbol tree from whichever language server owns the file.
 *
 * VS Code's provider returns one of two shapes depending on the extension
 * behind it: a hierarchical DocumentSymbol[] (TypeScript, Python, Rust, Go)
 * or a flat SymbolInformation[] (older providers). Both are handled - a flat
 * list simply yields a flat tree, which attribution copes with.
 *
 * A language with no installed server returns nothing. That is reported as a
 * status on the event rather than as an empty result, so "this file has no
 * functions" and "nothing here can tell us what a function is" stay
 * distinguishable in the data.
 */

export type SymbolsStatus = "ok" | "unsupported_language" | "unavailable";

export interface SymbolsResult {
  symbols: SymbolNode[];
  status: SymbolsStatus;
}

/** Cuts off a language server that is slow, reindexing, or wedged. */
const PROVIDER_TIMEOUT_MS = 2000;

export async function readDocumentSymbols(
  uri: vscode.Uri,
  timeoutMs = PROVIDER_TIMEOUT_MS
): Promise<SymbolsResult> {
  let raw: unknown;

  try {
    raw = await withTimeout(
      vscode.commands.executeCommand<vscode.DocumentSymbol[] | vscode.SymbolInformation[]>(
        "vscode.executeDocumentSymbolProvider",
        uri
      ),
      timeoutMs
    );
  } catch {
    // A save must never fail because a language server did.
    return { symbols: [], status: "unavailable" };
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    return { symbols: [], status: "unsupported_language" };
  }

  return { symbols: convert(raw as Array<vscode.DocumentSymbol | vscode.SymbolInformation>), status: "ok" };
}

function convert(
  raw: Array<vscode.DocumentSymbol | vscode.SymbolInformation>
): SymbolNode[] {
  return raw.map((symbol) => {
    if (isDocumentSymbol(symbol)) {
      return {
        name: symbol.name,
        kind: kindName(symbol.kind),
        startLine: symbol.range.start.line,
        endLine: symbol.range.end.line,
        selectionLine: symbol.selectionRange.start.line,
        children: convert(symbol.children ?? []),
      };
    }

    const range = symbol.location.range;
    return {
      name: symbol.name,
      kind: kindName(symbol.kind),
      startLine: range.start.line,
      endLine: range.end.line,
      // A flat provider gives no separate name range; the first line is the
      // best available anchor for "the declaration".
      selectionLine: range.start.line,
      children: [],
    };
  });
}

function isDocumentSymbol(
  symbol: vscode.DocumentSymbol | vscode.SymbolInformation
): symbol is vscode.DocumentSymbol {
  return (symbol as vscode.DocumentSymbol).range !== undefined;
}

/**
 * SymbolKind is a numeric enum; its reverse mapping gives "Function",
 * "Variable" and so on. Lower-cased here so the values are stable strings in
 * the payload rather than numbers whose meaning depends on a VS Code version.
 */
function kindName(kind: vscode.SymbolKind): string {
  return (vscode.SymbolKind[kind] ?? "unknown").toLowerCase();
}

function withTimeout<T>(promise: Thenable<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("symbol provider timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
