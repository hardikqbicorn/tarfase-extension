import { EVENT_TYPES } from "@ide-collector/event-schema";
import { RepositorySnapshot } from "./git-integration";

export interface DerivedGitEvent {
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * VS Code's Git extension exposes repository *state*, not operations. This
 * derives semantic git events by diffing consecutive state snapshots:
 *
 *   branch name changed          -> git.branch_checkout
 *   HEAD commit changed          -> git.commit
 *   ahead decreased              -> git.push
 *   behind decreased / commit moved with behind cleared -> git.pull
 *   staged count increased       -> git.stage
 *   staged count decreased       -> git.unstage
 *
 * Kept pure so the inference rules are directly unit-testable.
 */
export function deriveGitEvents(
  previous: RepositorySnapshot | undefined,
  current: RepositorySnapshot
): DerivedGitEvent[] {
  if (!previous) {
    return [
      {
        eventType: EVENT_TYPES.GIT_REPOSITORY_CHANGED,
        payload: {
          reason: "repository_observed",
          branch: current.branch,
          staged_count: current.stagedCount,
          unstaged_count: current.unstagedCount,
        },
      },
    ];
  }

  const events: DerivedGitEvent[] = [];

  if (previous.branch !== current.branch) {
    events.push({
      eventType: EVENT_TYPES.GIT_BRANCH_CHECKOUT,
      payload: { from_branch: previous.branch, to_branch: current.branch },
    });
    // A checkout also moves HEAD; reporting it as a commit too would be wrong.
    return events;
  }

  const commitChanged = previous.commit !== current.commit && Boolean(current.commit);

  const behindDecreased =
    typeof previous.behind === "number" &&
    typeof current.behind === "number" &&
    current.behind < previous.behind;

  const aheadDecreased =
    typeof previous.ahead === "number" &&
    typeof current.ahead === "number" &&
    current.ahead < previous.ahead;

  const aheadIncreased =
    typeof previous.ahead === "number" &&
    typeof current.ahead === "number" &&
    current.ahead > previous.ahead;

  if (behindDecreased) {
    events.push({
      eventType: EVENT_TYPES.GIT_PULL,
      payload: {
        branch: current.branch,
        commits_pulled: (previous.behind ?? 0) - (current.behind ?? 0),
      },
    });
  } else if (aheadDecreased) {
    events.push({
      eventType: EVENT_TYPES.GIT_PUSH,
      payload: {
        branch: current.branch,
        commits_pushed: (previous.ahead ?? 0) - (current.ahead ?? 0),
      },
    });
  } else if (commitChanged && aheadIncreased) {
    events.push({
      eventType: EVENT_TYPES.GIT_COMMIT,
      payload: {
        branch: current.branch,
        // The SHA is a non-sensitive, stable identifier; commit messages are
        // deliberately not collected.
        commit: current.commit,
        staged_before: previous.stagedCount,
      },
    });
  } else if (commitChanged) {
    events.push({
      eventType: EVENT_TYPES.GIT_COMMIT,
      payload: { branch: current.branch, commit: current.commit },
    });
  }

  if (current.stagedCount > previous.stagedCount) {
    events.push({
      eventType: EVENT_TYPES.GIT_STAGE,
      payload: {
        branch: current.branch,
        files_staged: current.stagedCount - previous.stagedCount,
        staged_total: current.stagedCount,
      },
    });
  } else if (current.stagedCount < previous.stagedCount && !commitChanged) {
    // After a commit the index empties; that is not an unstage.
    events.push({
      eventType: EVENT_TYPES.GIT_UNSTAGE,
      payload: {
        branch: current.branch,
        files_unstaged: previous.stagedCount - current.stagedCount,
        staged_total: current.stagedCount,
      },
    });
  }

  return events;
}
