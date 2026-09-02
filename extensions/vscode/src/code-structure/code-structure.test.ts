import { describe, expect, it } from "vitest";
import { diffLines } from "./diff";
import { attributeChanges, MAX_REPORTED_SYMBOLS, type SymbolNode } from "./attribute";
import { SnapshotStore, splitLines } from "./snapshots";
import { buildPayload, isReportable } from "./payload";

const lines = (text: string) => splitLines(text);

describe("diffLines", () => {
  it("reports nothing for an identical file", () => {
    const file = lines("a\nb\nc");
    const diff = diffLines(file, file);

    expect(diff.hunks).toEqual([]);
    expect(diff.linesUnchanged).toBe(3);
    expect(isReportable(diff)).toBe(false);
  });

  it("locates a two-line change in the middle of a long file", () => {
    const before = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[100] = "line 100 edited";
    after[101] = "line 101 edited";

    const diff = diffLines(before, after);

    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]).toMatchObject({
      kind: "modified",
      startLine: 100,
      endLine: 101,
      linesAdded: 2,
      linesRemoved: 2,
    });
    expect(diff.linesUnchanged).toBe(198);
  });

  it("separates two edits into two hunks", () => {
    const before = lines("a\nb\nc\nd\ne\nf\ng");
    const after = lines("a\nB\nc\nd\ne\nF\ng");

    const diff = diffLines(before, after);

    expect(diff.hunks.map((h) => h.startLine)).toEqual([1, 5]);
    expect(diff.hunks.every((h) => h.kind === "modified")).toBe(true);
  });

  it("distinguishes a pure insertion from a rewrite", () => {
    const diff = diffLines(lines("a\nb"), lines("a\nnew\nb"));

    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]).toMatchObject({
      kind: "added",
      startLine: 1,
      linesAdded: 1,
      linesRemoved: 0,
    });
    expect(diff.linesUnchanged).toBe(2);
  });

  it("anchors a pure deletion at the position the lines occupied", () => {
    const diff = diffLines(lines("a\ngone\nb"), lines("a\nb"));

    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]).toMatchObject({
      kind: "removed",
      startLine: 1,
      endLine: 1,
      linesAdded: 0,
      linesRemoved: 1,
    });
  });

  it("handles a file created from nothing and emptied to nothing", () => {
    expect(diffLines([], lines("a\nb")).hunks[0]).toMatchObject({
      kind: "added",
      linesAdded: 2,
    });
    expect(diffLines(lines("a\nb"), []).hunks[0]).toMatchObject({
      kind: "removed",
      linesRemoved: 2,
    });
  });

  it("degrades to one coarse hunk instead of building a huge table", () => {
    // A full rewrite: no common prefix or suffix to trim, so the table would
    // be 500x500 - over the cap set here.
    const before = Array.from({ length: 500 }, (_, i) => `old ${i}`);
    const after = Array.from({ length: 500 }, (_, i) => `new ${i}`);

    const diff = diffLines(before, after, { maxMatrixCells: 1000 });

    expect(diff.approximate).toBe(true);
    expect(diff.hunks).toHaveLength(1);
    expect(diff.linesAdded).toBe(500);
    expect(diff.linesRemoved).toBe(500);
  });

  it("stays exact for a small edit even under a tiny cell budget", () => {
    // Prefix/suffix trimming is what keeps the common case cheap, so the cap
    // should never kick in for it.
    const before = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[2500] = "changed";

    const diff = diffLines(before, after, { maxMatrixCells: 4 });

    expect(diff.approximate).toBe(false);
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0].startLine).toBe(2500);
  });
});

/**
 *   0  import { z } from "zod";
 *   1
 *   2  const MAX_RETRIES = 3;
 *   3
 *   4  class OrderService {
 *   5    private rate = 0.2;
 *   6
 *   7    calculateTotal(items) {
 *   8      return items.length;
 *   9    }
 *  10  }
 *  11
 *  12  function formatMoney(value) {
 *  13    return `$${value}`;
 *  14  }
 */
const symbols: SymbolNode[] = [
  { name: "MAX_RETRIES", kind: "variable", startLine: 2, endLine: 2, selectionLine: 2, children: [] },
  {
    name: "OrderService",
    kind: "class",
    startLine: 4,
    endLine: 10,
    selectionLine: 4,
    children: [
      { name: "rate", kind: "property", startLine: 5, endLine: 5, selectionLine: 5, children: [] },
      {
        name: "calculateTotal",
        kind: "method",
        startLine: 7,
        endLine: 9,
        selectionLine: 7,
        children: [],
      },
    ],
  },
  { name: "formatMoney", kind: "function", startLine: 12, endLine: 14, selectionLine: 12, children: [] },
];

describe("attributeChanges", () => {
  it("names the method a change landed in, not its enclosing class", () => {
    const result = attributeChanges(
      [{ kind: "modified", startLine: 8, endLine: 8, linesAdded: 1, linesRemoved: 1 }],
      symbols
    );

    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]).toMatchObject({
      name: "calculateTotal",
      qualified_name: "OrderService.calculateTotal",
      kind: "method",
      lines_added: 1,
      lines_removed: 1,
      signature_changed: false,
    });
  });

  it("counts what did not change", () => {
    const result = attributeChanges(
      [{ kind: "modified", startLine: 8, endLine: 8, linesAdded: 1, linesRemoved: 1 }],
      symbols
    );

    expect(result.total_count).toBe(5);
    expect(result.unchanged_count).toBe(4);
  });

  it("flags an edit to the declaration line as a signature change", () => {
    const result = attributeChanges(
      [{ kind: "modified", startLine: 7, endLine: 7, linesAdded: 1, linesRemoved: 1 }],
      symbols
    );

    expect(result.changed[0].signature_changed).toBe(true);
  });

  it("tells a variable apart from a function", () => {
    const result = attributeChanges(
      [
        { kind: "modified", startLine: 2, endLine: 2, linesAdded: 1, linesRemoved: 1 },
        { kind: "added", startLine: 13, endLine: 13, linesAdded: 1, linesRemoved: 0 },
      ],
      symbols
    );

    const byName = Object.fromEntries(result.changed.map((c) => [c.name, c.kind]));
    expect(byName.MAX_RETRIES).toBe("variable");
    expect(byName.formatMoney).toBe("function");
  });

  it("does not invent a symbol for a change to the import block", () => {
    const result = attributeChanges(
      [{ kind: "added", startLine: 0, endLine: 0, linesAdded: 1, linesRemoved: 0 }],
      symbols
    );

    expect(result.changed).toEqual([]);
    expect(result.unattributed_hunks).toBe(1);
    expect(result.unattributed_lines_added).toBe(1);
    expect(result.unchanged_count).toBe(5);
  });

  it("merges several edits to one symbol into one entry", () => {
    const result = attributeChanges(
      [
        { kind: "added", startLine: 8, endLine: 8, linesAdded: 1, linesRemoved: 0 },
        { kind: "modified", startLine: 9, endLine: 9, linesAdded: 2, linesRemoved: 1 },
      ],
      symbols
    );

    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]).toMatchObject({
      qualified_name: "OrderService.calculateTotal",
      lines_added: 3,
      lines_removed: 1,
      edit_count: 2,
    });
  });

  it("attributes to the class when the change is between its members", () => {
    const result = attributeChanges(
      [{ kind: "added", startLine: 6, endLine: 6, linesAdded: 1, linesRemoved: 0 }],
      symbols
    );

    expect(result.changed[0].qualified_name).toBe("OrderService");
  });

  it("reports everything as unattributed when no symbols are available", () => {
    const result = attributeChanges(
      [{ kind: "modified", startLine: 8, endLine: 8, linesAdded: 1, linesRemoved: 1 }],
      []
    );

    expect(result.changed).toEqual([]);
    expect(result.total_count).toBe(0);
    expect(result.unattributed_hunks).toBe(1);
  });
});

describe("buildPayload", () => {
  it("carries no source text", () => {
    const before = lines('const key = "sk-live-abcdef";\nfunction f() {}');
    const after = lines('const key = "sk-live-zzzzzz";\nfunction f() { return 1; }');

    const diff = diffLines(before, after);
    const payload = buildPayload(
      diff,
      attributeChanges(diff.hunks, [
        { name: "key", kind: "variable", startLine: 0, endLine: 0, selectionLine: 0, children: [] },
        { name: "f", kind: "function", startLine: 1, endLine: 1, selectionLine: 1, children: [] },
      ]),
      "ok"
    );

    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain("sk-live");
    expect(serialised).not.toContain("return 1");
    expect(serialised).not.toContain("const");
  });

  it("caps the symbol list but keeps the counts exact", () => {
    const many: SymbolNode[] = Array.from({ length: 80 }, (_, i) => ({
      name: `fn${i}`,
      kind: "function",
      startLine: i,
      endLine: i,
      selectionLine: i,
      children: [],
    }));
    const hunks = many.map((s) => ({
      kind: "modified" as const,
      startLine: s.startLine,
      endLine: s.endLine,
      linesAdded: 1,
      linesRemoved: 1,
    }));

    const payload = buildPayload(
      { hunks, linesAdded: 80, linesRemoved: 80, linesUnchanged: 0, approximate: false },
      attributeChanges(hunks, many),
      "ok"
    );

    expect(payload.symbols_changed).toHaveLength(MAX_REPORTED_SYMBOLS);
    expect(payload.symbols_changed_count).toBe(80);
    expect(payload.symbols_truncated).toBe(true);
  });

  it("summarises the kinds touched", () => {
    const diff = { hunks: [], linesAdded: 0, linesRemoved: 0, linesUnchanged: 0, approximate: false };
    const payload = buildPayload(
      diff,
      {
        changed: [
          { name: "a", qualified_name: "a", kind: "function", lines_added: 1, lines_removed: 0, edit_count: 1, signature_changed: false },
          { name: "b", qualified_name: "b", kind: "variable", lines_added: 1, lines_removed: 0, edit_count: 1, signature_changed: false },
          { name: "c", qualified_name: "c", kind: "function", lines_added: 1, lines_removed: 0, edit_count: 1, signature_changed: false },
        ],
        unchanged_count: 0,
        total_count: 3,
        unattributed_hunks: 0,
        unattributed_lines_added: 0,
        unattributed_lines_removed: 0,
      },
      "ok"
    );

    expect(payload.kinds_changed).toEqual(["function", "variable"]);
  });
});

describe("SnapshotStore", () => {
  it("round-trips content as lines", () => {
    const store = new SnapshotStore();
    store.set("/a.ts", "one\ntwo\n");

    expect(store.get("/a.ts")).toEqual(["one", "two"]);
  });

  it("refuses to track a file over the size cap, and forgets any older copy", () => {
    const store = new SnapshotStore({ maxFileBytes: 10 });
    store.set("/a.ts", "small");
    expect(store.get("/a.ts")).toEqual(["small"]);

    // A stale snapshot here would diff the new large file against the old
    // small one and report the whole file as changed.
    expect(store.set("/a.ts", "x".repeat(50))).toBe(false);
    expect(store.get("/a.ts")).toBeUndefined();
  });

  it("evicts past the total byte budget, not just the file count", () => {
    // A count cap alone is not a memory bound: 200 files at the 2 MB per-file
    // limit would be 400 MB of extension host heap.
    const store = new SnapshotStore({ maxFiles: 100, maxTotalBytes: 30 });
    store.set("/a.ts", "x".repeat(20));
    store.set("/b.ts", "y".repeat(20));

    expect(store.size).toBe(1);
    expect(store.get("/a.ts")).toBeUndefined();
    expect(store.bytes).toBe(20);
  });

  it("keeps byte accounting straight across overwrite and delete", () => {
    const store = new SnapshotStore();
    store.set("/a.ts", "x".repeat(100));
    store.set("/a.ts", "x".repeat(10));
    expect(store.bytes).toBe(10);

    store.delete("/a.ts");
    expect(store.bytes).toBe(0);

    store.set("/b.ts", "xy");
    store.clear();
    expect(store.bytes).toBe(0);
    expect(store.size).toBe(0);
  });

  it("keeps the newest file even when it alone exceeds the budget", () => {
    // Evicting down to nothing would mean the next save has no baseline and
    // silently reports nothing at all.
    const store = new SnapshotStore({ maxTotalBytes: 5 });
    store.set("/big.ts", "x".repeat(50));

    expect(store.size).toBe(1);
    expect(store.get("/big.ts")).toBeDefined();
  });

  it("evicts least-recently-used files past the count cap", () => {
    const store = new SnapshotStore({ maxFiles: 2 });
    store.set("/a.ts", "a");
    store.set("/b.ts", "b");
    store.get("/a.ts"); // touch a, so b is now oldest
    store.set("/c.ts", "c");

    expect(store.size).toBe(2);
    expect(store.get("/b.ts")).toBeUndefined();
    expect(store.get("/a.ts")).toEqual(["a"]);
    expect(store.get("/c.ts")).toEqual(["c"]);
  });
});

describe("splitLines", () => {
  it("treats a trailing newline as terminating the last line", () => {
    // Otherwise saving a file that gained a final newline reads as +1 line.
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
  });

  it("handles CRLF and lone CR", () => {
    expect(splitLines("a\r\nb\rc")).toEqual(["a", "b", "c"]);
  });

  it("distinguishes an empty file from a file with one blank line", () => {
    expect(splitLines("")).toEqual([""]);
    expect(splitLines("\n")).toEqual([""]);
  });
});
