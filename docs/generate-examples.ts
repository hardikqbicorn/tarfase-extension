/**
 * Generates docs/example-events.json from the real schema and factory, then
 * validates every example against the same validator the ingestion service
 * uses. Examples written by hand drift from the code; these cannot.
 *
 *   npx tsx docs/generate-examples.ts
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { createEvent, EVENT_TYPES, validateEvent } from "../packages/event-schema/src";

const base = {
  userId: "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
  installationId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  sessionId: "9b2e4c1a-8f3d-4a5b-9c6d-7e8f9a0b1c2d",
  ide: { name: "vscode", version: "1.90.0" },
  workspace: { id: "a3f1c8e2d4b6", name: "acme-platform" },
  project: { id: "a3f1c8e2d4b6", name: "acme-platform" },
  repository: { id: "b7d2e9f4a1c3", name: "acme-platform", branch: "feature/checkout" },
};

const examples = [
  {
    description: "A workspace being opened, emitted once at activation.",
    event: createEvent({
      ...base,
      eventType: EVENT_TYPES.WORKSPACE_OPENED,
      payload: { folder_count: 1, is_multi_root: false, is_untrusted: false },
    }),
  },
  {
    description:
      "A file save. Note that only the shape of the file is recorded - line count and byte size - never its contents.",
    event: createEvent({
      ...base,
      eventType: EVENT_TYPES.FILE_SAVED,
      file: { path: "src/checkout/payment.ts", language: "typescript" },
      payload: { line_count: 248, size_bytes: 8421 },
    }),
  },
  {
    description:
      "A document edit. Throttled per file (default 1s). Character counts only; `likely_bulk_insert` flags a large single insertion, which usually means a paste or an AI completion.",
    event: createEvent({
      ...base,
      eventType: EVENT_TYPES.EDITOR_DOCUMENT_CHANGED,
      file: { path: "src/checkout/payment.ts", language: "typescript" },
      payload: {
        change_count: 1,
        chars_added: 312,
        chars_removed: 0,
        line_count: 248,
        likely_bulk_insert: true,
      },
    }),
  },
  {
    description:
      "A cursor move. The highest-frequency event in the IDE, throttled to one per file per 2s by default.",
    event: createEvent({
      ...base,
      eventType: EVENT_TYPES.EDITOR_CURSOR_MOVED,
      file: { path: "src/checkout/payment.ts", language: "typescript" },
      payload: { selection_count: 1, line: 42, selected_lines: 0, kind: "Mouse" },
    }),
  },
  {
    description:
      "A terminal command AFTER redaction. The secret is gone, but `command_name` survives so aggregate analytics still work. The raw command line was: `AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI... npm run deploy`",
    event: createEvent({
      ...base,
      eventType: EVENT_TYPES.TERMINAL_COMMAND_EXECUTED,
      payload: {
        terminal_name: "zsh",
        command: "AWS_SECRET_ACCESS_KEY=[REDACTED] npm run deploy",
        command_name: "npm",
      },
    }),
  },
  {
    description: "A terminal command completing with a non-zero exit code.",
    event: createEvent({
      ...base,
      eventType: EVENT_TYPES.TERMINAL_COMMAND_COMPLETED,
      payload: {
        terminal_name: "zsh",
        command: "npm run deploy",
        command_name: "npm",
        exit_code: 1,
        succeeded: false,
      },
    }),
  },
  {
    description:
      "A git commit, derived from a repository state transition. The SHA is recorded; the commit message and diff are not.",
    event: createEvent({
      ...base,
      eventType: EVENT_TYPES.GIT_COMMIT,
      payload: { branch: "feature/checkout", commit: "e83c5163316f89bfbde7d9ab23ca2e25604af290", staged_before: 4 },
    }),
  },
  {
    description: "A branch checkout.",
    event: createEvent({
      ...base,
      eventType: EVENT_TYPES.GIT_BRANCH_CHECKOUT,
      repository: { ...base.repository, branch: "main" },
      payload: { from_branch: "feature/checkout", to_branch: "main" },
    }),
  },
  {
    description: "A test run failing, derived from a VS Code task with group `test`.",
    event: createEvent({
      ...base,
      eventType: EVENT_TYPES.TEST_FAILED,
      payload: {
        task_name: "npm: test",
        task_source: "npm",
        task_group: "test",
        exit_code: 1,
        succeeded: false,
        duration_ms: 14320,
      },
    }),
  },
  {
    description:
      "Diagnostics for a file. Counts by severity and the reporting sources only - messages are omitted because they quote source code.",
    event: createEvent({
      ...base,
      eventType: EVENT_TYPES.DIAGNOSTICS_REPORTED,
      file: { path: "src/checkout/payment.ts" },
      payload: {
        error_count: 2,
        warning_count: 5,
        info_count: 0,
        hint_count: 1,
        total: 8,
        sources: ["ts", "eslint"],
      },
    }),
  },
  {
    description:
      "A debug session ending. The configuration's name and type are recorded; its `env` block - which routinely holds credentials - is never read.",
    event: createEvent({
      ...base,
      eventType: EVENT_TYPES.DEBUGGER_STOPPED,
      payload: { session_name: "Launch API", debug_type: "node", duration_ms: 187000 },
    }),
  },
  {
    description:
      "An AI event contributed by a cooperating extension through the reporter API. Metadata only - the prompt text itself is not collected by default.",
    event: createEvent({
      ...base,
      eventType: EVENT_TYPES.AI_USER_PROMPT,
      payload: {
        provider: "copilot",
        model: "gpt-5",
        prompt_tokens: 142,
        has_file_context: true,
      },
    }),
  },
  {
    description:
      "The honest 'we cannot see this' event, emitted once at activation. This is what lets a query distinguish 'the developer used no AI' from 'AI is not observable in this IDE'.",
    event: createEvent({
      ...base,
      eventType: EVENT_TYPES.AI_FEATURE_UNAVAILABLE,
      payload: {
        reason: "no_public_api_for_observing_assistant_activity",
        language_model_api: true,
        chat_participant_api: true,
        note: "AI events must be pushed by a cooperating extension via the reporter API",
      },
    }),
  },
  {
    description:
      "The same canonical envelope emitted by the JetBrains plugin. Only `ide.name` differs - the backend needs no knowledge of which IDE produced it.",
    event: createEvent({
      ...base,
      eventType: EVENT_TYPES.FILE_SAVED,
      ide: { name: "jetbrains:intellij-idea", version: "2024.1.4" },
      file: { path: "src/main/kotlin/Payment.kt", language: "kt" },
      payload: { line_count: 96, size_bytes: 3120 },
    }),
  },
];

// Every example must pass the same validation the ingestion service applies.
const failures: string[] = [];
for (const { event } of examples) {
  const result = validateEvent(event);
  if (!result.valid) {
    failures.push(`${event.event_type}: ${result.errors?.join(", ")}`);
  }
}
if (failures.length > 0) {
  console.error("Examples failed schema validation:\n" + failures.join("\n"));
  process.exit(1);
}

const output = {
  _comment:
    "Generated by docs/generate-examples.ts from the real schema and factory. Do not edit by hand - run `npx tsx docs/generate-examples.ts`. Every example here is validated against the same schema the ingestion service enforces.",
  schema_version: examples[0].event.schema_version,
  examples,
};

const target = join(__dirname, "example-events.json");
writeFileSync(target, JSON.stringify(output, null, 2) + "\n");
console.log(`Wrote ${examples.length} validated examples to ${target}`);
