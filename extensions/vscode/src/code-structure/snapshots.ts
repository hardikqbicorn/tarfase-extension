/**
 * Last-seen contents of open files, so a save can be diffed against what was
 * there before.
 *
 * This is the one part of the feature that holds source in memory, so it is
 * bounded on both axes: files that are too big are not tracked at all, and the
 * set of tracked files is capped with least-recently-used eviction. Without
 * that, opening a large repository would grow the extension host's heap by the
 * size of every file the developer touched in that session.
 *
 * Nothing here is ever emitted. The snapshot exists only to compute line
 * numbers; the lines themselves never leave this process.
 */

export interface SnapshotStoreOptions {
  /** Files larger than this are not tracked. Default 2 MB. */
  maxFileBytes?: number;
  /** Most files tracked at once. Default 200. */
  maxFiles?: number;
  /** Total budget across all snapshots. Default 32 MB. */
  maxTotalBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES = 200;
// A count cap alone is not a memory bound: 200 files at the 2 MB per-file
// limit would be 400 MB of extension host heap. Both caps apply.
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export class SnapshotStore {
  // Map preserves insertion order, which is all an LRU needs: delete before
  // set to move a key to the end, evict from the front.
  private readonly snapshots = new Map<string, string[]>();
  private readonly sizes = new Map<string, number>();
  private totalBytes = 0;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly maxTotalBytes: number;

  constructor(options: SnapshotStoreOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  }

  /** Records the current content. Returns false if the file was too large. */
  set(path: string, text: string): boolean {
    if (text.length > this.maxFileBytes) {
      // Drop any older, smaller snapshot rather than leaving a stale one that
      // would produce a nonsense diff on the next save.
      this.delete(path);
      return false;
    }

    this.delete(path);
    this.snapshots.set(path, splitLines(text));
    this.sizes.set(path, text.length);
    this.totalBytes += text.length;

    while (
      this.snapshots.size > this.maxFiles ||
      (this.totalBytes > this.maxTotalBytes && this.snapshots.size > 1)
    ) {
      const oldest = this.snapshots.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }

    return true;
  }

  /** The previous content, marking it recently used. Undefined if untracked. */
  get(path: string): string[] | undefined {
    const lines = this.snapshots.get(path);
    if (!lines) return undefined;

    // Re-inserting moves the key to the end of the iteration order, which is
    // what makes eviction least-recently-used rather than oldest-written.
    const bytes = this.sizes.get(path) ?? 0;
    this.snapshots.delete(path);
    this.sizes.delete(path);
    this.snapshots.set(path, lines);
    this.sizes.set(path, bytes);

    return lines;
  }

  delete(path: string): void {
    this.totalBytes -= this.sizes.get(path) ?? 0;
    this.snapshots.delete(path);
    this.sizes.delete(path);
  }

  clear(): void {
    this.snapshots.clear();
    this.sizes.clear();
    this.totalBytes = 0;
  }

  get size(): number {
    return this.snapshots.size;
  }

  /** Bytes currently held, for tests and diagnostics. */
  get bytes(): number {
    return this.totalBytes;
  }
}

/**
 * Splits on any line ending, and treats a trailing newline as terminating the
 * last line rather than starting an empty one - otherwise adding a final
 * newline reads as a one-line insertion.
 */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
