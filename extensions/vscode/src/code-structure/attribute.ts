import { Hunk } from "./diff";

/**
 * Attributes changed line ranges to the code constructs that contain them, so
 * an event can say "two lines changed in the method calculateTotal" rather
 * than "two lines changed at 142".
 *
 * The symbol tree comes from whatever language server the developer already
 * has installed, via VS Code's document symbol provider. That is the whole
 * reason this needs no AI and no parser of its own: the language server has
 * already parsed the file, exactly, for the language it owns, and it cannot
 * hallucinate a function that is not there.
 *
 * vscode-free by design - see symbols.ts for the conversion.
 */

/** A node in the document symbol tree, flattened of vscode types. */
export interface SymbolNode {
  name: string;
  /** Lower-case symbol kind: "function", "method", "class", "variable", ... */
  kind: string;
  /** 0-based, inclusive, spanning the whole construct including its body. */
  startLine: number;
  endLine: number;
  /** 0-based line the name itself sits on - where a signature change lands. */
  selectionLine: number;
  children: SymbolNode[];
}

export interface SymbolChange {
  name: string;
  /** Dotted path through enclosing symbols: "OrderService.calculateTotal". */
  qualified_name: string;
  kind: string;
  lines_added: number;
  lines_removed: number;
  /** Separate edit locations inside this symbol. */
  edit_count: number;
  /** The declaration line itself was touched, so the signature may have changed. */
  signature_changed: boolean;
}

export interface Attribution {
  changed: SymbolChange[];
  /** Symbols in the file that no edit touched. */
  unchanged_count: number;
  total_count: number;
  /**
   * Hunks that landed outside every symbol: imports, top-level statements,
   * comments between declarations - and deletions of a whole symbol, which by
   * definition is no longer in the tree to attribute to.
   */
  unattributed_hunks: number;
  unattributed_lines_added: number;
  unattributed_lines_removed: number;
}

/** Keeps one event's payload bounded when a formatter rewrites a whole file. */
export const MAX_REPORTED_SYMBOLS = 50;

export function attributeChanges(
  hunks: readonly Hunk[],
  symbols: readonly SymbolNode[]
): Attribution {
  const flattened = flatten(symbols);
  const changes = new Map<string, SymbolChange>();

  let unattributedHunks = 0;
  let unattributedAdded = 0;
  let unattributedRemoved = 0;

  for (const hunk of hunks) {
    const owner = innermostContaining(flattened, hunk);

    if (!owner) {
      unattributedHunks++;
      unattributedAdded += hunk.linesAdded;
      unattributedRemoved += hunk.linesRemoved;
      continue;
    }

    const existing = changes.get(owner.qualifiedName);
    const touchesDeclaration =
      hunk.startLine <= owner.node.selectionLine && owner.node.selectionLine <= hunk.endLine;

    if (existing) {
      existing.lines_added += hunk.linesAdded;
      existing.lines_removed += hunk.linesRemoved;
      existing.edit_count++;
      existing.signature_changed ||= touchesDeclaration;
    } else {
      changes.set(owner.qualifiedName, {
        name: owner.node.name,
        qualified_name: owner.qualifiedName,
        kind: owner.node.kind,
        lines_added: hunk.linesAdded,
        lines_removed: hunk.linesRemoved,
        edit_count: 1,
        signature_changed: touchesDeclaration,
      });
    }
  }

  // Most-changed first, so a truncated list keeps the interesting entries.
  const changed = [...changes.values()].sort(
    (a, b) => b.lines_added + b.lines_removed - (a.lines_added + a.lines_removed)
  );

  return {
    changed,
    unchanged_count: flattened.length - changed.length,
    total_count: flattened.length,
    unattributed_hunks: unattributedHunks,
    unattributed_lines_added: unattributedAdded,
    unattributed_lines_removed: unattributedRemoved,
  };
}

interface FlatSymbol {
  node: SymbolNode;
  qualifiedName: string;
  depth: number;
}

function flatten(
  symbols: readonly SymbolNode[],
  prefix = "",
  depth = 0,
  out: FlatSymbol[] = []
): FlatSymbol[] {
  for (const node of symbols) {
    const qualifiedName = prefix ? `${prefix}.${node.name}` : node.name;
    out.push({ node, qualifiedName, depth });
    flatten(node.children, qualifiedName, depth + 1, out);
  }
  return out;
}

/**
 * The deepest symbol whose range contains the hunk. Deepest rather than first
 * because a method inside a class is contained by both, and "calculateTotal
 * changed" is the useful answer, not "OrderService changed".
 */
function innermostContaining(
  flattened: readonly FlatSymbol[],
  hunk: Hunk
): FlatSymbol | undefined {
  let best: FlatSymbol | undefined;

  for (const candidate of flattened) {
    if (hunk.startLine < candidate.node.startLine) continue;
    if (hunk.startLine > candidate.node.endLine) continue;
    if (!best || candidate.depth > best.depth) best = candidate;
  }

  return best;
}
