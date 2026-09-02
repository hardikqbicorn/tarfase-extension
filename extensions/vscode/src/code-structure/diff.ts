/**
 * Line diff between two versions of a file.
 *
 * Answers "which lines changed, and how many did not" - the input to symbol
 * attribution. Kept free of any vscode import so the algorithm is directly
 * testable, and deliberately hand-rolled: this runs on every save, inside the
 * extension host, over the user's source. A dependency in that position is
 * both supply-chain surface and a thing that can be slow on a file we do not
 * control the size of.
 *
 * Line numbers throughout are 0-based and expressed in the NEW file, because
 * that is the coordinate space the document symbol tree uses.
 */

export type HunkKind = "added" | "removed" | "modified";

export interface Hunk {
  kind: HunkKind;
  /** First affected line in the new file. */
  startLine: number;
  /**
   * Last affected line in the new file, inclusive. For a pure removal there
   * is no new line to point at, so this equals startLine - the position where
   * the removed lines used to be.
   */
  endLine: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface LineDiff {
  hunks: Hunk[];
  linesAdded: number;
  linesRemoved: number;
  /** Lines present in both versions, untouched. */
  linesUnchanged: number;
  /**
   * True when the middle section was too large to diff exactly and one coarse
   * hunk was produced instead. Reported rather than hidden: a consumer should
   * know the difference between "this function changed" and "somewhere in
   * these 4000 lines something changed".
   */
  approximate: boolean;
}

/**
 * Above this many cells the LCS table is not worth building. A full rewrite of
 * a 2000-line file is 4M cells, which is seconds of work and ~32MB - on the
 * extension host, on every save. Past it, report one coarse hunk.
 */
const DEFAULT_MAX_MATRIX_CELLS = 1_000_000;

export function diffLines(
  before: readonly string[],
  after: readonly string[],
  options: { maxMatrixCells?: number } = {}
): LineDiff {
  const maxCells = options.maxMatrixCells ?? DEFAULT_MAX_MATRIX_CELLS;

  // Trimming the common prefix and suffix first is what makes the usual case -
  // a couple of lines changed in a long file - linear rather than quadratic.
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = Math.min(before.length - prefix, after.length - prefix);
  while (
    suffix < maxSuffix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midBefore = before.slice(prefix, before.length - suffix);
  const midAfter = after.slice(prefix, after.length - suffix);

  if (midBefore.length === 0 && midAfter.length === 0) {
    return {
      hunks: [],
      linesAdded: 0,
      linesRemoved: 0,
      linesUnchanged: after.length,
      approximate: false,
    };
  }

  const unchanged = prefix + suffix;

  if (midBefore.length === 0) {
    return {
      hunks: [
        {
          kind: "added",
          startLine: prefix,
          endLine: prefix + midAfter.length - 1,
          linesAdded: midAfter.length,
          linesRemoved: 0,
        },
      ],
      linesAdded: midAfter.length,
      linesRemoved: 0,
      linesUnchanged: unchanged,
      approximate: false,
    };
  }

  if (midAfter.length === 0) {
    return {
      hunks: [
        {
          kind: "removed",
          startLine: prefix,
          endLine: prefix,
          linesAdded: 0,
          linesRemoved: midBefore.length,
        },
      ],
      linesAdded: 0,
      linesRemoved: midBefore.length,
      linesUnchanged: unchanged,
      approximate: false,
    };
  }

  if (midBefore.length * midAfter.length > maxCells) {
    return {
      hunks: [
        {
          kind: "modified",
          startLine: prefix,
          endLine: prefix + midAfter.length - 1,
          linesAdded: midAfter.length,
          linesRemoved: midBefore.length,
        },
      ],
      linesAdded: midAfter.length,
      linesRemoved: midBefore.length,
      linesUnchanged: unchanged,
      approximate: true,
    };
  }

  return fromEditScript(editScript(midBefore, midAfter), prefix, unchanged);
}

type Op = { kind: "equal" | "insert" | "delete" };

/** Longest common subsequence, backtracked into a line-by-line edit script. */
function editScript(before: readonly string[], after: readonly string[]): Op[] {
  const rows = before.length + 1;
  const cols = after.length + 1;
  const table = new Uint32Array(rows * cols);

  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        before[i] === after[j]
          ? table[(i + 1) * cols + (j + 1)] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + (j + 1)]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;

  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ kind: "equal" });
      i++;
      j++;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + (j + 1)]) {
      ops.push({ kind: "delete" });
      i++;
    } else {
      ops.push({ kind: "insert" });
      j++;
    }
  }
  while (i < before.length) {
    ops.push({ kind: "delete" });
    i++;
  }
  while (j < after.length) {
    ops.push({ kind: "insert" });
    j++;
  }

  return ops;
}

/**
 * Coalesces the edit script into hunks. Adjacent inserts and deletes become
 * one "modified" hunk rather than a separate add and remove, because a
 * rewritten line is one edit to a reader and two to a diff algorithm.
 */
function fromEditScript(ops: Op[], offset: number, unchangedOutsideMiddle: number): LineDiff {
  const hunks: Hunk[] = [];
  let newLine = offset;
  let totalAdded = 0;
  let totalRemoved = 0;
  let unchangedInMiddle = 0;

  let index = 0;
  while (index < ops.length) {
    if (ops[index].kind === "equal") {
      unchangedInMiddle++;
      newLine++;
      index++;
      continue;
    }

    const startLine = newLine;
    let added = 0;
    let removed = 0;

    while (index < ops.length && ops[index].kind !== "equal") {
      if (ops[index].kind === "insert") {
        added++;
        newLine++;
      } else {
        removed++;
      }
      index++;
    }

    hunks.push({
      kind: added > 0 && removed > 0 ? "modified" : added > 0 ? "added" : "removed",
      startLine,
      // A hunk that only removed lines has no new line to span.
      endLine: added > 0 ? newLine - 1 : startLine,
      linesAdded: added,
      linesRemoved: removed,
    });

    totalAdded += added;
    totalRemoved += removed;
  }

  return {
    hunks,
    linesAdded: totalAdded,
    linesRemoved: totalRemoved,
    linesUnchanged: unchangedOutsideMiddle + unchangedInMiddle,
    approximate: false,
  };
}
