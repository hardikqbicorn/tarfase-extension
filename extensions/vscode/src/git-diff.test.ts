import { describe, expect, it } from "vitest";
import { EVENT_TYPES } from "@ide-collector/event-schema";
import { deriveGitEvents } from "./git-diff";
import { RepositorySnapshot } from "./git-integration";

function snapshot(overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
  return {
    rootPath: "/workspace/my-project",
    name: "my-project",
    branch: "main",
    commit: "aaa111",
    ahead: 0,
    behind: 0,
    stagedCount: 0,
    unstagedCount: 0,
    ...overrides,
  };
}

describe("deriveGitEvents", () => {
  it("reports the initial observation of a repository", () => {
    const events = deriveGitEvents(undefined, snapshot());
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe(EVENT_TYPES.GIT_REPOSITORY_CHANGED);
  });

  it("detects a branch checkout", () => {
    const events = deriveGitEvents(
      snapshot({ branch: "main" }),
      snapshot({ branch: "feature/x", commit: "bbb222" })
    );
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe(EVENT_TYPES.GIT_BRANCH_CHECKOUT);
    expect(events[0].payload).toMatchObject({ from_branch: "main", to_branch: "feature/x" });
  });

  it("does not report a checkout as a commit", () => {
    const events = deriveGitEvents(
      snapshot({ branch: "main", commit: "aaa111" }),
      snapshot({ branch: "other", commit: "zzz999" })
    );
    expect(events.map((e) => e.eventType)).not.toContain(EVENT_TYPES.GIT_COMMIT);
  });

  it("detects a commit when HEAD moves and ahead increases", () => {
    const events = deriveGitEvents(
      snapshot({ commit: "aaa111", ahead: 0, stagedCount: 3 }),
      snapshot({ commit: "bbb222", ahead: 1, stagedCount: 0 })
    );
    const commit = events.find((e) => e.eventType === EVENT_TYPES.GIT_COMMIT);
    expect(commit).toBeDefined();
    expect(commit?.payload.commit).toBe("bbb222");
  });

  it("does not report an unstage when the index empties due to a commit", () => {
    const events = deriveGitEvents(
      snapshot({ commit: "aaa111", ahead: 0, stagedCount: 3 }),
      snapshot({ commit: "bbb222", ahead: 1, stagedCount: 0 })
    );
    expect(events.map((e) => e.eventType)).not.toContain(EVENT_TYPES.GIT_UNSTAGE);
  });

  it("detects a push when ahead decreases", () => {
    const events = deriveGitEvents(snapshot({ ahead: 3 }), snapshot({ ahead: 0 }));
    const push = events.find((e) => e.eventType === EVENT_TYPES.GIT_PUSH);
    expect(push?.payload.commits_pushed).toBe(3);
  });

  it("detects a pull when behind decreases", () => {
    const events = deriveGitEvents(
      snapshot({ behind: 2, commit: "aaa111" }),
      snapshot({ behind: 0, commit: "ccc333" })
    );
    const pull = events.find((e) => e.eventType === EVENT_TYPES.GIT_PULL);
    expect(pull?.payload.commits_pulled).toBe(2);
  });

  it("detects staging", () => {
    const events = deriveGitEvents(snapshot({ stagedCount: 0 }), snapshot({ stagedCount: 2 }));
    const stage = events.find((e) => e.eventType === EVENT_TYPES.GIT_STAGE);
    expect(stage?.payload.files_staged).toBe(2);
  });

  it("detects unstaging", () => {
    const events = deriveGitEvents(snapshot({ stagedCount: 2 }), snapshot({ stagedCount: 0 }));
    const unstage = events.find((e) => e.eventType === EVENT_TYPES.GIT_UNSTAGE);
    expect(unstage?.payload.files_unstaged).toBe(2);
  });

  it("emits nothing when nothing changed", () => {
    expect(deriveGitEvents(snapshot(), snapshot())).toHaveLength(0);
  });

  it("never includes a commit message or remote URL", () => {
    const events = deriveGitEvents(
      snapshot({ commit: "aaa111", ahead: 0 }),
      snapshot({ commit: "bbb222", ahead: 1 })
    );
    const serialized = JSON.stringify(events);
    expect(serialized).not.toMatch(/message|remote|url/i);
  });
});
