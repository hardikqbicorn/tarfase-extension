import * as vscode from "vscode";
import { basename, stableId } from "./paths";

/**
 * Thin wrapper over the built-in `vscode.git` extension's exported API.
 *
 * That API is not part of the stable VS Code surface, so every access is
 * defensive: if the Git extension is missing, disabled, or its shape changes,
 * git events are simply reported as unavailable rather than breaking the
 * extension.
 */

export interface RepositorySnapshot {
  rootPath: string;
  name: string;
  branch?: string;
  commit?: string;
  ahead?: number;
  behind?: number;
  stagedCount: number;
  unstagedCount: number;
}

type GitRepositoryLike = {
  rootUri: { fsPath: string; toString(): string };
  state: {
    HEAD?: { name?: string; commit?: string; ahead?: number; behind?: number };
    indexChanges?: unknown[];
    workingTreeChanges?: unknown[];
    onDidChange: (listener: () => void) => vscode.Disposable;
  };
};

type GitApiLike = {
  repositories: GitRepositoryLike[];
  onDidOpenRepository: (listener: (repo: GitRepositoryLike) => void) => vscode.Disposable;
  onDidCloseRepository: (listener: (repo: GitRepositoryLike) => void) => vscode.Disposable;
};

export class GitIntegration {
  private api: GitApiLike | undefined;
  private available = false;

  /** Attempts to acquire the Git API. Never throws. */
  async initialize(): Promise<boolean> {
    try {
      const extension = vscode.extensions.getExtension<{ getAPI(version: number): GitApiLike }>(
        "vscode.git"
      );
      if (!extension) return false;
      const exports = extension.isActive ? extension.exports : await extension.activate();
      this.api = exports?.getAPI?.(1);
      this.available = Boolean(this.api);
      return this.available;
    } catch {
      this.available = false;
      return false;
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  getCurrentRepository(): RepositorySnapshot | undefined {
    if (!this.api) return undefined;
    try {
      const repo = this.api.repositories[0];
      return repo ? this.snapshot(repo) : undefined;
    } catch {
      return undefined;
    }
  }

  getRepositories(): RepositorySnapshot[] {
    if (!this.api) return [];
    try {
      return this.api.repositories.map((repo) => this.snapshot(repo));
    } catch {
      return [];
    }
  }

  /**
   * Subscribes to repository state changes. VS Code exposes no explicit
   * commit/push/pull events, so the adapter derives them by diffing
   * consecutive snapshots (see collectors/git.ts).
   */
  onRepositoryStateChanged(
    listener: (snapshot: RepositorySnapshot) => void
  ): vscode.Disposable[] {
    if (!this.api) return [];
    const disposables: vscode.Disposable[] = [];

    const subscribe = (repo: GitRepositoryLike) => {
      try {
        disposables.push(repo.state.onDidChange(() => listener(this.snapshot(repo))));
      } catch {
        // A repository whose state cannot be observed is simply skipped.
      }
    };

    try {
      this.api.repositories.forEach(subscribe);
      disposables.push(this.api.onDidOpenRepository((repo) => subscribe(repo)));
    } catch {
      // Ignore: git events degrade to unavailable.
    }

    return disposables;
  }

  onRepositoryOpened(listener: (snapshot: RepositorySnapshot) => void): vscode.Disposable[] {
    if (!this.api) return [];
    try {
      return [this.api.onDidOpenRepository((repo) => listener(this.snapshot(repo)))];
    } catch {
      return [];
    }
  }

  private snapshot(repo: GitRepositoryLike): RepositorySnapshot {
    const head = repo.state.HEAD;
    return {
      rootPath: repo.rootUri.fsPath,
      name: basename(repo.rootUri.fsPath),
      branch: head?.name,
      commit: head?.commit,
      ahead: head?.ahead,
      behind: head?.behind,
      stagedCount: repo.state.indexChanges?.length ?? 0,
      unstagedCount: repo.state.workingTreeChanges?.length ?? 0,
    };
  }

  static repositoryId(rootPath: string): string {
    return stableId(rootPath);
  }
}
