/**
 * Canonical catalog of event types emitted by any IDE adapter.
 * New event types should be appended, never renumbered/removed, to keep
 * older extension builds forward-compatible with newer schema consumers.
 */
export const EVENT_TYPES = {
  // Workspace
  WORKSPACE_OPENED: "workspace.opened",
  WORKSPACE_CLOSED: "workspace.closed",
  PROJECT_OPENED: "project.opened",
  PROJECT_CHANGED: "project.changed",

  // File
  FILE_OPENED: "file.opened",
  FILE_CLOSED: "file.closed",
  FILE_CREATED: "file.created",
  FILE_DELETED: "file.deleted",
  FILE_RENAMED: "file.renamed",
  FILE_SAVED: "file.saved",
  FILE_MODIFIED: "file.modified",

  // Editor
  EDITOR_CURSOR_MOVED: "editor.cursor_moved",
  EDITOR_SELECTION_CHANGED: "editor.selection_changed",
  EDITOR_ACTIVE_CHANGED: "editor.active_changed",
  EDITOR_DOCUMENT_CHANGED: "editor.document_changed",
  EDITOR_LANGUAGE_CHANGED: "editor.language_changed",

  // Terminal
  TERMINAL_CREATED: "terminal.created",
  TERMINAL_OPENED: "terminal.opened",
  TERMINAL_CLOSED: "terminal.closed",
  TERMINAL_COMMAND_EXECUTED: "terminal.command_executed",
  TERMINAL_COMMAND_COMPLETED: "terminal.command_completed",

  // Git
  GIT_BRANCH_CHECKOUT: "git.branch_checkout",
  GIT_COMMIT: "git.commit",
  GIT_MERGE: "git.merge",
  GIT_PULL: "git.pull",
  GIT_PUSH: "git.push",
  GIT_REBASE: "git.rebase",
  GIT_STAGE: "git.stage",
  GIT_UNSTAGE: "git.unstage",
  GIT_REPOSITORY_CHANGED: "git.repository_changed",

  // Build / Test / Debug
  BUILD_STARTED: "build.started",
  BUILD_COMPLETED: "build.completed",
  BUILD_FAILED: "build.failed",
  TEST_STARTED: "test.started",
  TEST_COMPLETED: "test.completed",
  TEST_FAILED: "test.failed",
  DEBUGGER_STARTED: "debugger.started",
  DEBUGGER_STOPPED: "debugger.stopped",
  BREAKPOINT_ADDED: "breakpoint.added",
  BREAKPOINT_REMOVED: "breakpoint.removed",
  DIAGNOSTICS_REPORTED: "diagnostics.reported",

  // AI
  AI_SESSION_STARTED: "ai.session_started",
  AI_SESSION_ENDED: "ai.session_ended",
  AI_CHAT_STARTED: "ai.chat_started",
  AI_USER_PROMPT: "ai.user_prompt",
  AI_RESPONSE: "ai.response",
  AI_AGENT_INVOKED: "ai.agent_invoked",
  AI_TOOL_INVOKED: "ai.tool_invoked",
  AI_TOOL_RESULT: "ai.tool_result",
  AI_CODE_GENERATED: "ai.code_generated",
  AI_CODE_MODIFIED: "ai.code_modified",
  AI_FEATURE_UNAVAILABLE: "ai.feature_unavailable",

  // Session / lifecycle
  SESSION_STARTED: "session.started",
  SESSION_ENDED: "session.ended",
  EXTENSION_ACTIVATED: "extension.activated",
  EXTENSION_DEACTIVATED: "extension.deactivated",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export const EVENT_TYPE_VALUES: readonly string[] = Object.values(EVENT_TYPES);
