import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  EVENT_TYPES,
  IDEEvent,
  validateEvent,
} from "@ide-collector/event-schema";
import {
  EventCollector,
  EventQueue,
  InMemoryQueuePersistence,
  mergeConfig,
  EventTransport,
  TransportResult,
} from "@ide-collector/event-sdk";
import { Logger } from "@ide-collector/shared-utils";
import * as vscode from "vscode";
import { VSCodeContextProvider } from "../context-provider";
import { GitIntegration } from "../git-integration";
import { CollectorDeps } from "./types";
import { registerWorkspaceCollectors } from "./workspace";
import { registerFileCollectors } from "./files";
import { registerEditorCollectors } from "./editor";
import { registerTerminalCollectors } from "./terminal";
import { registerDebugCollectors } from "./debug";
import { registerTaskCollectors } from "./tasks";
import { registerDiagnosticsCollectors } from "./diagnostics";
import { AiEventReporter, registerAiCollectors } from "./ai";

const stub = vscode as unknown as typeof import("../../test/vscode-stub");

class CapturingTransport implements EventTransport {
  async send(events: IDEEvent[]): Promise<TransportResult> {
    return { accepted: events.map((e) => e.event_id), rejected: [] };
  }
}

interface Harness {
  deps: CollectorDeps;
  captured: IDEEvent[];
  disposables: { dispose(): void }[];
}

async function makeHarness(
  configOverrides: Record<string, unknown> = {},
): Promise<Harness> {
  const captured: IDEEvent[] = [];
  const queue = new EventQueue({
    maxQueueSize: 1000,
    persistence: new InMemoryQueuePersistence(),
  });
  const config = mergeConfig({
    enabled: true,
    flushIntervalMs: 60_000,
    ...configOverrides,
  } as any);

  const git = new GitIntegration();
  const contextProvider = new VSCodeContextProvider("vscode", "1.90.0", git);

  const collector = new EventCollector({
    config,
    identity: {
      userId: "user-1",
      installationId: "install-1",
      sessionId: "session-1",
    },
    contextProvider,
    queue,
    transport: new CapturingTransport(),
    logger: new Logger({
      service: "test",
      level: "error",
      sink: { write: () => {} },
    }),
  });
  await collector.start();

  // Intercept capture so tests can assert on emitted events directly.
  const originalCapture = collector.capture.bind(collector);
  collector.capture = (input) => {
    const event = originalCapture(input);
    if (event) captured.push(event);
    return event;
  };

  return {
    deps: { collector, config, contextProvider, git },
    captured,
    disposables: [],
  };
}

function typesOf(events: IDEEvent[]): string[] {
  return events.map((e) => e.event_type);
}

function firstOfType(events: IDEEvent[], type: string): IDEEvent | undefined {
  return events.find((e) => e.event_type === type);
}

describe("workspace collectors", () => {
  beforeEach(() => stub.resetStub());

  it("emits workspace.opened and project.opened at activation", async () => {
    const harness = await makeHarness();
    registerWorkspaceCollectors(harness.deps);

    expect(typesOf(harness.captured)).toContain(EVENT_TYPES.WORKSPACE_OPENED);
    expect(typesOf(harness.captured)).toContain(EVENT_TYPES.PROJECT_OPENED);
  });

  it("attaches workspace and project context to events", async () => {
    const harness = await makeHarness();
    registerWorkspaceCollectors(harness.deps);

    const event = firstOfType(harness.captured, EVENT_TYPES.WORKSPACE_OPENED)!;
    expect(event.workspace?.name).toBe("my-project");
    expect(event.project?.id).toBeTruthy();
    expect(validateEvent(event).valid).toBe(true);
  });

  it("emits project.changed when folders change", async () => {
    const harness = await makeHarness();
    registerWorkspaceCollectors(harness.deps);
    harness.captured.length = 0;

    stub.fire.didChangeWorkspaceFolders([{}], []);
    expect(typesOf(harness.captured)).toContain(EVENT_TYPES.PROJECT_CHANGED);
  });
});

describe("file collectors", () => {
  let harness: Harness;

  beforeEach(async () => {
    stub.resetStub();
    harness = await makeHarness();
    registerFileCollectors(harness.deps);
  });

  it("captures file.opened with a workspace-relative path", () => {
    stub.fire.didOpenTextDocument(
      stub.makeDocument({ path: "/workspace/my-project/src/index.ts" }),
    );

    const event = firstOfType(harness.captured, EVENT_TYPES.FILE_OPENED)!;
    expect(event.file?.path).toBe("src/index.ts");
    expect(event.file?.language).toBe("typescript");
  });

  it("never emits an absolute path for a file outside the workspace", () => {
    stub.fire.didOpenTextDocument(
      stub.makeDocument({
        path: "/Users/alice/private/notes.md",
        languageId: "markdown",
      }),
    );

    const event = firstOfType(harness.captured, EVENT_TYPES.FILE_OPENED)!;
    expect(event.file?.path).toBe("notes.md");
    expect(JSON.stringify(event)).not.toContain("alice");
  });

  it("flags sensitive files without collecting their content", () => {
    stub.fire.didOpenTextDocument(
      stub.makeDocument({
        path: "/workspace/my-project/.env",
        languageId: "dotenv",
      }),
    );

    const event = firstOfType(harness.captured, EVENT_TYPES.FILE_OPENED)!;
    expect(event.payload.is_sensitive).toBe(true);
    expect(JSON.stringify(event.payload)).not.toContain("content");
  });

  it("captures file.saved with size and line count but no content", () => {
    stub.fire.didSaveTextDocument(
      stub.makeDocument({
        path: "/workspace/my-project/src/app.ts",
        lineCount: 42,
        getText: () => "const secret = 'hunter2';",
      }),
    );

    const event = firstOfType(harness.captured, EVENT_TYPES.FILE_SAVED)!;
    expect(event.payload.line_count).toBe(42);
    expect(event.payload.size_bytes).toBe(25);
    expect(JSON.stringify(event)).not.toContain("hunter2");
  });

  it("captures create, delete, and rename", () => {
    stub.fire.didCreateFiles([stub.Uri.file("/workspace/my-project/new.ts")]);
    stub.fire.didDeleteFiles([stub.Uri.file("/workspace/my-project/old.ts")]);
    stub.fire.didRenameFiles([
      {
        oldUri: stub.Uri.file("/workspace/my-project/a.ts"),
        newUri: stub.Uri.file("/workspace/my-project/b.ts"),
      },
    ]);

    const types = typesOf(harness.captured);
    expect(types).toContain(EVENT_TYPES.FILE_CREATED);
    expect(types).toContain(EVENT_TYPES.FILE_DELETED);
    expect(types).toContain(EVENT_TYPES.FILE_RENAMED);

    const renamed = firstOfType(harness.captured, EVENT_TYPES.FILE_RENAMED)!;
    expect(renamed.payload.old_path).toBe("a.ts");
    expect(renamed.payload.new_path).toBe("b.ts");
  });

  it("ignores non-file documents such as output channels", () => {
    const virtualDoc = {
      ...stub.makeDocument({ path: "extension-output-x" }),
      uri: stub.Uri.parse("output://extension-output-x"),
    };
    stub.fire.didOpenTextDocument(virtualDoc as any);
    expect(harness.captured).toHaveLength(0);
  });
});

describe("editor collectors", () => {
  let harness: Harness;

  beforeEach(async () => {
    stub.resetStub();
    harness = await makeHarness();
    registerEditorCollectors(harness.deps);
  });

  it("captures active editor changes", () => {
    stub.fire.didChangeActiveTextEditor({
      document: stub.makeDocument({
        path: "/workspace/my-project/src/index.ts",
      }),
    });

    const event = firstOfType(
      harness.captured,
      EVENT_TYPES.EDITOR_ACTIVE_CHANGED,
    )!;
    expect(event.file?.path).toBe("src/index.ts");
  });

  it("classifies an empty selection as a cursor move", () => {
    stub.fire.didChangeTextEditorSelection({
      textEditor: {
        document: stub.makeDocument({ path: "/workspace/my-project/a.ts" }),
      },
      selections: [
        new stub.Selection(new stub.Position(3, 0), new stub.Position(3, 0)),
      ],
    });

    expect(typesOf(harness.captured)).toContain(
      EVENT_TYPES.EDITOR_CURSOR_MOVED,
    );
  });

  it("classifies a non-empty selection as a selection change", () => {
    stub.fire.didChangeTextEditorSelection({
      textEditor: {
        document: stub.makeDocument({ path: "/workspace/my-project/a.ts" }),
      },
      selections: [
        new stub.Selection(new stub.Position(1, 0), new stub.Position(5, 10)),
      ],
    });

    const event = firstOfType(
      harness.captured,
      EVENT_TYPES.EDITOR_SELECTION_CHANGED,
    )!;
    expect(event.payload.selected_lines).toBe(5);
  });

  it("throttles rapid cursor movement in the same file", () => {
    const document = stub.makeDocument({ path: "/workspace/my-project/a.ts" });
    for (let i = 0; i < 10; i++) {
      stub.fire.didChangeTextEditorSelection({
        textEditor: { document },
        selections: [
          new stub.Selection(new stub.Position(i, 0), new stub.Position(i, 0)),
        ],
      });
    }

    const cursorEvents = harness.captured.filter(
      (e) => e.event_type === EVENT_TYPES.EDITOR_CURSOR_MOVED,
    );
    expect(cursorEvents).toHaveLength(1);
  });

  it("throttles per file, not globally", () => {
    for (const path of [
      "/workspace/my-project/a.ts",
      "/workspace/my-project/b.ts",
    ]) {
      stub.fire.didChangeTextEditorSelection({
        textEditor: { document: stub.makeDocument({ path }) },
        selections: [
          new stub.Selection(new stub.Position(0, 0), new stub.Position(0, 0)),
        ],
      });
    }

    const cursorEvents = harness.captured.filter(
      (e) => e.event_type === EVENT_TYPES.EDITOR_CURSOR_MOVED,
    );
    expect(cursorEvents).toHaveLength(2);
  });

  it("captures document changes as counts, never as text", () => {
    stub.fire.didChangeTextDocument({
      document: stub.makeDocument({
        path: "/workspace/my-project/a.ts",
        isDirty: true,
      }),
      contentChanges: [{ text: "const apiKey = 'sk-secret';", rangeLength: 3 }],
    });

    const event = firstOfType(
      harness.captured,
      EVENT_TYPES.EDITOR_DOCUMENT_CHANGED,
    )!;
    expect(event.payload.chars_added).toBe(27);
    expect(event.payload.chars_removed).toBe(3);
    expect(JSON.stringify(event)).not.toContain("sk-secret");
  });

  it("flags a large single insertion as a likely bulk insert", () => {
    stub.fire.didChangeTextDocument({
      document: stub.makeDocument({ path: "/workspace/my-project/a.ts" }),
      contentChanges: [{ text: "x".repeat(500), rangeLength: 0 }],
    });

    const event = firstOfType(
      harness.captured,
      EVENT_TYPES.EDITOR_DOCUMENT_CHANGED,
    )!;
    expect(event.payload.likely_bulk_insert).toBe(true);
  });
});

describe("terminal collectors", () => {
  let harness: Harness;

  beforeEach(async () => {
    stub.resetStub();
    harness = await makeHarness();
    registerTerminalCollectors(harness.deps);
  });

  it("captures terminal lifecycle", () => {
    stub.fire.didOpenTerminal({ name: "bash" });
    stub.fire.didCloseTerminal({ name: "bash", exitStatus: { code: 0 } });

    const types = typesOf(harness.captured);
    expect(types).toContain(EVENT_TYPES.TERMINAL_CREATED);
    expect(types).toContain(EVENT_TYPES.TERMINAL_CLOSED);
  });

  it("captures command execution and exit code", () => {
    stub.fire.didStartTerminalShellExecution({
      terminal: { name: "bash" },
      execution: { commandLine: { value: "npm test" } },
    });
    stub.fire.didEndTerminalShellExecution({
      terminal: { name: "bash" },
      execution: { commandLine: { value: "npm test" } },
      exitCode: 1,
    });

    const started = firstOfType(
      harness.captured,
      EVENT_TYPES.TERMINAL_COMMAND_EXECUTED,
    )!;
    expect(started.payload.command).toBe("npm test");
    expect(started.payload.command_name).toBe("npm");

    const completed = firstOfType(
      harness.captured,
      EVENT_TYPES.TERMINAL_COMMAND_COMPLETED,
    )!;
    expect(completed.payload.exit_code).toBe(1);
    expect(completed.payload.succeeded).toBe(false);
  });

  it("redacts secrets in captured commands", () => {
    stub.fire.didStartTerminalShellExecution({
      terminal: { name: "bash" },
      execution: {
        commandLine: {
          value: "OPENAI_API_KEY=sk-verysecretvalue123 npm start",
        },
      },
    });

    const event = firstOfType(
      harness.captured,
      EVENT_TYPES.TERMINAL_COMMAND_EXECUTED,
    )!;
    expect(JSON.stringify(event.payload)).not.toContain(
      "sk-verysecretvalue123",
    );
    // The executable name survives redaction, so aggregates still work.
    expect(event.payload.command_name).toBe("npm");
  });
});

describe("debug collectors", () => {
  let harness: Harness;

  beforeEach(async () => {
    stub.resetStub();
    harness = await makeHarness();
    registerDebugCollectors(harness.deps);
  });

  it("captures debug session start and stop with a duration", () => {
    const session = { id: "s1", name: "Launch Program", type: "node" };
    stub.fire.didStartDebugSession(session);
    stub.fire.didTerminateDebugSession(session);

    const started = firstOfType(
      harness.captured,
      EVENT_TYPES.DEBUGGER_STARTED,
    )!;
    expect(started.payload.debug_type).toBe("node");

    const stopped = firstOfType(
      harness.captured,
      EVENT_TYPES.DEBUGGER_STOPPED,
    )!;
    expect(stopped.payload.duration_ms).toBeTypeOf("number");
  });

  it("captures breakpoint changes without the condition expression", () => {
    stub.fire.didChangeBreakpoints({
      added: [
        {
          enabled: true,
          condition: "user.token === 'secret-value'",
          location: { uri: stub.Uri.file("/workspace/my-project/src/a.ts") },
        },
      ],
    });

    const event = firstOfType(harness.captured, EVENT_TYPES.BREAKPOINT_ADDED)!;
    expect(event.payload.has_condition).toBe(true);
    expect(JSON.stringify(event)).not.toContain("secret-value");
    expect(event.file?.path).toBe("src/a.ts");
  });
});

describe("task collectors", () => {
  let harness: Harness;

  beforeEach(async () => {
    stub.resetStub();
    harness = await makeHarness();
    registerTaskCollectors(harness.deps);
  });

  it("classifies a test task and reports failure", () => {
    const execution = {
      task: { name: "npm: test", source: "npm", group: { id: "test" } },
    };
    stub.fire.didStartTaskProcess({ execution, processId: 123 });
    stub.fire.didEndTaskProcess({ execution, exitCode: 1 });

    const types = typesOf(harness.captured);
    expect(types).toContain(EVENT_TYPES.TEST_STARTED);
    expect(types).toContain(EVENT_TYPES.TEST_FAILED);
  });

  it("classifies a build task and reports success", () => {
    const execution = {
      task: { name: "npm: build", source: "npm", group: { id: "build" } },
    };
    stub.fire.didStartTaskProcess({ execution });
    stub.fire.didEndTaskProcess({ execution, exitCode: 0 });

    const types = typesOf(harness.captured);
    expect(types).toContain(EVENT_TYPES.BUILD_STARTED);
    expect(types).toContain(EVENT_TYPES.BUILD_COMPLETED);
  });

  it("falls back to the task name when no group is declared", () => {
    const execution = { task: { name: "run vitest suite", source: "npm" } };
    stub.fire.didStartTaskProcess({ execution });
    expect(typesOf(harness.captured)).toContain(EVENT_TYPES.TEST_STARTED);
  });
});

describe("diagnostics collectors", () => {
  beforeEach(() => stub.resetStub());

  it("captures severity counts without diagnostic messages", async () => {
    const harness = await makeHarness();
    registerDiagnosticsCollectors(harness.deps);

    const uri = stub.Uri.file("/workspace/my-project/src/a.ts");
    stub.state.diagnostics.set(uri.fsPath, [
      { severity: 0, source: "ts", message: "Cannot find name 'SECRET_TOKEN'" },
      { severity: 1, source: "eslint", message: "unused var" },
    ]);

    stub.fire.didChangeDiagnostics([uri]);

    const event = firstOfType(
      harness.captured,
      EVENT_TYPES.DIAGNOSTICS_REPORTED,
    )!;
    expect(event.payload.error_count).toBe(1);
    expect(event.payload.warning_count).toBe(1);
    expect(event.payload.sources).toEqual(["ts", "eslint"]);
    expect(JSON.stringify(event)).not.toContain("SECRET_TOKEN");
  });
});

describe("ai collectors", () => {
  beforeEach(() => stub.resetStub());

  it("reports AI observation as unavailable rather than silently emitting nothing", async () => {
    const harness = await makeHarness();
    registerAiCollectors(harness.deps);

    const event = firstOfType(
      harness.captured,
      EVENT_TYPES.AI_FEATURE_UNAVAILABLE,
    )!;
    expect(event).toBeDefined();
    expect(event.payload.reason).toBe(
      "no_public_api_for_observing_assistant_activity",
    );
  });

  it("keeps AI content out of events unless content capture is enabled", () => {
    const captured: { eventType: string; payload?: Record<string, unknown> }[] =
      [];
    const reporter = new AiEventReporter(
      (input) => captured.push(input),
      () => false,
    );

    reporter.reportPrompt({
      provider: "copilot",
      prompt_tokens: 12,
      text: "secret prompt",
    });
    reporter.reportResponse({
      provider: "copilot",
      completion_tokens: 8,
      text: "secret response",
    });

    expect(captured[0].payload).toEqual({
      provider: "copilot",
      prompt_tokens: 12,
    });
    expect(captured[1].payload).toEqual({
      provider: "copilot",
      completion_tokens: 8,
    });
  });

  it("includes AI content when content capture is enabled", () => {
    const captured: { eventType: string; payload?: Record<string, unknown> }[] =
      [];
    const reporter = new AiEventReporter(
      (input) => captured.push(input),
      () => true,
    );

    reporter.reportPrompt({ provider: "claude", text: "prompt" });
    reporter.reportResponse({ provider: "claude", text: "response" });

    expect(captured[0].payload?.text).toBe("prompt");
    expect(captured[1].payload?.text).toBe("response");
  });
});

describe("category opt-outs", () => {
  beforeEach(() => stub.resetStub());

  it("suppresses terminal events when the terminal category is disabled", async () => {
    const harness = await makeHarness({ capture: { terminal: false } });
    registerTerminalCollectors(harness.deps);

    stub.fire.didOpenTerminal({ name: "bash" });
    expect(harness.captured).toHaveLength(0);
  });

  it("suppresses everything when telemetry is disabled", async () => {
    const harness = await makeHarness({ enabled: false });
    registerFileCollectors(harness.deps);

    stub.fire.didSaveTextDocument(
      stub.makeDocument({ path: "/workspace/my-project/a.ts" }),
    );
    expect(harness.captured).toHaveLength(0);
  });
});
