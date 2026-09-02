import * as vscode from "vscode";
import { EVENT_TYPES } from "@ide-collector/event-schema";
import { CollectorRegistration } from "./types";

/**
 * Build and test events, derived from VS Code's task API.
 *
 * VS Code has no first-class "build" or "test" concept, so a task's group
 * (`build` / `test`) and name are used to classify it. Task *definitions* are
 * not collected: they can contain command lines with credentials.
 */
export const registerTaskCollectors: CollectorRegistration = ({ collector }) => {
  const disposables: vscode.Disposable[] = [];
  const executionStartTimes = new Map<string, { startedAt: number; kind: TaskKind }>();

  disposables.push(
    vscode.tasks.onDidStartTaskProcess((event) => {
      const task = event.execution.task;
      const kind = classifyTask(task);
      executionStartTimes.set(executionKey(event.execution), { startedAt: Date.now(), kind });

      collector.capture({
        eventType: kind === "test" ? EVENT_TYPES.TEST_STARTED : EVENT_TYPES.BUILD_STARTED,
        payload: {
          task_name: task.name,
          task_source: task.source,
          task_group: groupName(task),
          process_id: event.processId,
        },
      });
    })
  );

  disposables.push(
    vscode.tasks.onDidEndTaskProcess((event) => {
      const key = executionKey(event.execution);
      const started = executionStartTimes.get(key);
      executionStartTimes.delete(key);

      const task = event.execution.task;
      const kind = started?.kind ?? classifyTask(task);
      const succeeded = event.exitCode === 0;

      const eventType =
        kind === "test"
          ? succeeded
            ? EVENT_TYPES.TEST_COMPLETED
            : EVENT_TYPES.TEST_FAILED
          : succeeded
            ? EVENT_TYPES.BUILD_COMPLETED
            : EVENT_TYPES.BUILD_FAILED;

      collector.capture({
        eventType,
        payload: {
          task_name: task.name,
          task_source: task.source,
          task_group: groupName(task),
          exit_code: event.exitCode ?? null,
          succeeded,
          duration_ms: started ? Date.now() - started.startedAt : null,
        },
      });
    })
  );

  return disposables;
};

type TaskKind = "build" | "test" | "other";

function groupName(task: vscode.Task): string | undefined {
  const group = task.group;
  if (!group) return undefined;
  return typeof group === "string" ? group : group.id;
}

/**
 * Classifies a task as build or test. Prefers VS Code's declared task group
 * and falls back to the task name, which is how most real-world tasks (an npm
 * script called "test") are actually identifiable.
 */
export function classifyTask(task: {
  name?: string;
  group?: vscode.TaskGroup | string;
}): TaskKind {
  const group = task.group;
  const groupId = typeof group === "string" ? group : group?.id;

  if (groupId === "test") return "test";
  if (groupId === "build") return "build";

  const name = (task.name ?? "").toLowerCase();
  if (/\b(test|spec|jest|vitest|pytest|mocha)\b/.test(name)) return "test";
  if (/\b(build|compile|bundle|webpack|tsc|make)\b/.test(name)) return "build";
  return "other";
}

function executionKey(execution: vscode.TaskExecution): string {
  const task = execution.task;
  return `${task.source}:${task.name}:${groupName(task) ?? ""}`;
}
