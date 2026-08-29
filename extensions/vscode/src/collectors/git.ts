import * as vscode from "vscode";
import { EVENT_TYPES } from "@ide-collector/event-schema";
import { stableId } from "../paths";
import { deriveGitEvents } from "../git-diff";
import { RepositorySnapshot } from "../git-integration";
import { CollectorRegistration } from "./types";

/**
 * Git events, derived from repository state transitions (see git-diff.ts).
 * Commit messages, diffs, and remote URLs are deliberately not collected -
 * commit SHAs and branch names are enough for activity analytics.
 */
export const registerGitCollectors: CollectorRegistration = ({ collector, git }) => {
  if (!git.isAvailable()) {
    // Report unavailability once so downstream analytics can distinguish
    // "no git activity" from "git not observable in this IDE".
    collector.capture({
      eventType: EVENT_TYPES.GIT_REPOSITORY_CHANGED,
      payload: { available: false, reason: "git_extension_unavailable" },
    });
    return [];
  }

  const disposables: vscode.Disposable[] = [];
  const lastSnapshots = new Map<string, RepositorySnapshot>();

  for (const snapshot of git.getRepositories()) {
    lastSnapshots.set(snapshot.rootPath, snapshot);
  }

  const handleSnapshot = (snapshot: RepositorySnapshot) => {
    const previous = lastSnapshots.get(snapshot.rootPath);
    lastSnapshots.set(snapshot.rootPath, snapshot);

    for (const derived of deriveGitEvents(previous, snapshot)) {
      collector.capture({
        eventType: derived.eventType,
        payload: derived.payload,
        repository: {
          id: stableId(snapshot.rootPath),
          name: snapshot.name,
          branch: snapshot.branch,
        },
      });
    }
  };

  disposables.push(...git.onRepositoryStateChanged(handleSnapshot));
  disposables.push(
    ...git.onRepositoryOpened((snapshot) => {
      collector.capture({
        eventType: EVENT_TYPES.GIT_REPOSITORY_CHANGED,
        payload: { reason: "repository_opened", branch: snapshot.branch },
        repository: {
          id: stableId(snapshot.rootPath),
          name: snapshot.name,
          branch: snapshot.branch,
        },
      });
      lastSnapshots.set(snapshot.rootPath, snapshot);
    })
  );

  return disposables;
};
