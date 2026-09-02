import { FSWatcher, watch } from "fs";
import { mkdir } from "fs/promises";
import { basename } from "path";

/**
 * Notices a credential staged by `ide-collector login` the moment it appears,
 * so the one-command setup does not end with "now restart your IDE".
 *
 * The directory is watched rather than the file: the file is created, and a
 * watch on a path that does not exist yet never fires.
 *
 * fs.watch is not reliable everywhere - some network and virtualised
 * filesystems never deliver events - so `check` is exposed for the caller to
 * drive from a second trigger. In the extension that is window focus, which
 * covers the ordinary sequence of running the CLI in a terminal and switching
 * back to the IDE.
 *
 * Kept free of any vscode import so the sequencing here can be tested against
 * a real directory.
 */

export interface CredentialWatchOptions {
  dir: string;
  filename: string;
  /** Imports a staged credential if one is there. Returns whether it did. */
  onCandidate: () => Promise<boolean>;
  /** Called after a successful import, to bring the pipeline up. */
  onImported: () => Promise<void>;
  onError?: (error: Error) => void;
}

export interface CredentialWatch {
  /** Checks now. Safe to call concurrently; overlapping calls collapse. */
  check(): Promise<void>;
  /** Resolves once the watch is attached, or has failed to attach. */
  ready: Promise<void>;
  close(): void;
}

const toError = (err: unknown): Error =>
  err instanceof Error ? err : new Error(String(err));

export function startCredentialWatch(options: CredentialWatchOptions): CredentialWatch {
  let watcher: FSWatcher | undefined;
  let closed = false;
  let checking = false;

  // Writing a file produces several events, and the focus trigger can land in
  // the middle of them. Collapsing overlapping checks keeps that from turning
  // into a burst of imports and collector restarts.
  const check = async (): Promise<void> => {
    if (closed || checking) return;
    checking = true;
    try {
      if (await options.onCandidate()) {
        await options.onImported();
      }
    } catch (err) {
      options.onError?.(toError(err));
    } finally {
      checking = false;
    }
  };

  const ready = (async () => {
    try {
      // The CLI creates this too; creating it here as well means the watch has
      // something to attach to when the extension is set up first.
      await mkdir(options.dir, { recursive: true, mode: 0o700 });
      if (closed) return;

      const attached = watch(options.dir, (_event, filename) => {
        if (!filename || basename(filename.toString()) === options.filename) {
          void check();
        }
      });
      attached.on("error", (err) => {
        options.onError?.(toError(err));
        attached.close();
        if (watcher === attached) watcher = undefined;
      });
      watcher = attached;
    } catch (err) {
      // Not fatal: `check` still works, and the caller's second trigger drives it.
      options.onError?.(toError(err));
    }
  })();

  return {
    check,
    ready,
    close() {
      closed = true;
      watcher?.close();
      watcher = undefined;
    },
  };
}
