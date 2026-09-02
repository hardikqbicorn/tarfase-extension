import { LineDiff } from "./diff";
import { Attribution, MAX_REPORTED_SYMBOLS, SymbolChange } from "./attribute";

/**
 * Builds the `code.symbols_changed` payload.
 *
 * Everything here is structure: names, kinds, counts, and line numbers. No
 * line of source is included, which is what keeps the promise the consent
 * notice makes ("never records the contents of your files") true while still
 * answering "what changed - was it a function or a variable".
 */

export interface CodeChangePayload {
  // The collector's capture() takes an open JSON object; this index signature
  // is what lets a precisely typed payload satisfy it.
  [key: string]: unknown;

  lines_added: number;
  lines_removed: number;
  lines_unchanged: number;
  hunk_count: number;
  symbols_changed: SymbolChange[];
  symbols_changed_count: number;
  symbols_unchanged_count: number;
  symbols_total: number;
  /** Kinds touched, deduplicated - cheap to group by without unnesting. */
  kinds_changed: string[];
  unattributed_hunks: number;
  unattributed_lines_added: number;
  unattributed_lines_removed: number;
  /** True when symbols_changed was capped; the counts above are still exact. */
  symbols_truncated: boolean;
  /** True when the file was too large to diff exactly. */
  approximate: boolean;
  /** Why the symbol tree was empty, when it was. */
  symbols_status: "ok" | "unsupported_language" | "unavailable";
}

export function buildPayload(
  diff: LineDiff,
  attribution: Attribution,
  symbolsStatus: CodeChangePayload["symbols_status"]
): CodeChangePayload {
  const reported = attribution.changed.slice(0, MAX_REPORTED_SYMBOLS);

  return {
    lines_added: diff.linesAdded,
    lines_removed: diff.linesRemoved,
    lines_unchanged: diff.linesUnchanged,
    hunk_count: diff.hunks.length,
    symbols_changed: reported,
    symbols_changed_count: attribution.changed.length,
    symbols_unchanged_count: attribution.unchanged_count,
    symbols_total: attribution.total_count,
    kinds_changed: [...new Set(attribution.changed.map((s) => s.kind))].sort(),
    unattributed_hunks: attribution.unattributed_hunks,
    unattributed_lines_added: attribution.unattributed_lines_added,
    unattributed_lines_removed: attribution.unattributed_lines_removed,
    symbols_truncated: attribution.changed.length > reported.length,
    approximate: diff.approximate,
    symbols_status: symbolsStatus,
  };
}

/**
 * Whether a save is worth an event at all. A save with no textual change -
 * Ctrl+S on an unmodified file, or a format-on-save that changed nothing - is
 * noise, and there are a lot of them.
 */
export function isReportable(diff: LineDiff): boolean {
  return diff.hunks.length > 0;
}
