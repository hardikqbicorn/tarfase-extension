import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { EVENT_TYPES, IDEEvent, validateEvent } from "@ide-collector/event-schema";
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
import { registerCodeStructureCollectors } from "./code-structure";

const stub = vscode as unknown as typeof import("../../test/vscode-stub");

class NoopTransport implements EventTransport {
  async send(events: IDEEvent[]): Promise<TransportResult> {
    return { accepted: events.map((e) => e.event_id), rejected: [] };
  }
}

const PATH = "/workspace/my-project/order-service.ts";

/**
 *  0  import { z } from "zod";
 *  1
 *  2  export class OrderService {
 *  3    calculateTotal(items) {
 *  4      return 0;
 *  5    }
 *  6  }
 */
const BEFORE = [
  'import { z } from "zod";',
  "",
  "export class OrderService {",
  "  calculateTotal(items) {",
  "    return 0;",
  "  }",
  "}",
].join("\n");

/** The symbol tree a TypeScript language server would return for BEFORE. */
const SYMBOLS = [
  {
    name: "OrderService",
    kind: stub.SymbolKind.Class,
    range: { start: { line: 2 }, end: { line: 6 } },
    selectionRange: { start: { line: 2 } },
    children: [
      {
        name: "calculateTotal",
        kind: stub.SymbolKind.Method,
        range: { start: { line: 3 }, end: { line: 5 } },
        selectionRange: { start: { line: 3 } },
        children: [],
      },
    ],
  },
];

interface Harness {
  deps: CollectorDeps;
  captured: IDEEvent[];
  disposables: { dispose(): void }[];
}

async function makeHarness(configOverrides: Record<string, unknown> = {}): Promise<Harness> {
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
    identity: { userId: "u", installationId: "i", sessionId: "s" },
    contextProvider,
    queue,
    transport: new NoopTransport(),
    logger: new Logger({ service: "test", level: "error", sink: { write: () => {} } }),
  });

  await collector.start();

  // Same interception the other collector tests use: assert on what was
  // emitted rather than on what reached a transport.
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

/** The capture path is fire-and-forget past an await; let it settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function makeDoc(text: string) {
  return stub.makeDocument({
    path: PATH,
    languageId: "typescript",
    lineCount: text.split("\n").length,
    getText: () => text,
  });
}

function symbolEvent(captured: IDEEvent[]): IDEEvent | undefined {
  return captured.find((e) => e.event_type === EVENT_TYPES.CODE_SYMBOLS_CHANGED);
}

describe("code structure collector", () => {
  let harness: Harness;

  beforeEach(async () => {
    stub.resetStub();
    stub.state.commandResults.set("vscode.executeDocumentSymbolProvider", () => SYMBOLS);
    harness = await makeHarness();
  });

  afterEach(() => {
    for (const d of harness.disposables) d.dispose();
  });

  const register = () => {
    harness.disposables = registerCodeStructureCollectors(harness.deps);
  };

  it("names the method a two-line change landed in", async () => {
    register();
    stub.fire.didOpenTextDocument(makeDoc(BEFORE));

    const after = BEFORE.replace(
      "    return 0;",
      "    const sum = items.length;\n    return sum;"
    );
    stub.fire.didSaveTextDocument(makeDoc(after));
    await settle();

    const event = symbolEvent(harness.captured);
    expect(event).toBeDefined();
    expect(event!.payload.symbols_changed).toEqual([
      {
        name: "calculateTotal",
        qualified_name: "OrderService.calculateTotal",
        kind: "method",
        lines_added: 2,
        lines_removed: 1,
        edit_count: 1,
        signature_changed: false,
      },
    ]);
    expect((event!.file as { path: string }).path).toBe("order-service.ts");
  });

  it("reports what did not change", async () => {
    register();
    stub.fire.didOpenTextDocument(makeDoc(BEFORE));
    stub.fire.didSaveTextDocument(makeDoc(BEFORE.replace("return 0;", "return 1;")));
    await settle();

    const event = symbolEvent(harness.captured)!;
    expect(event.payload.lines_unchanged).toBe(6);
    expect(event.payload.symbols_unchanged_count).toBe(1); // the class itself
    expect(event.payload.symbols_total).toBe(2);
  });

  it("never puts a line of source on the event", async () => {
    register();
    stub.fire.didOpenTextDocument(makeDoc(BEFORE));
    stub.fire.didSaveTextDocument(
      makeDoc(BEFORE.replace("return 0;", 'return "sk-live-abcdef1234";'))
    );
    await settle();

    const serialised = JSON.stringify(symbolEvent(harness.captured));
    expect(serialised).not.toContain("sk-live");
    expect(serialised).not.toContain("return");
    expect(serialised).not.toContain("import");
  });

  it("emits a schema-valid event", async () => {
    register();
    stub.fire.didOpenTextDocument(makeDoc(BEFORE));
    stub.fire.didSaveTextDocument(makeDoc(BEFORE.replace("return 0;", "return 1;")));
    await settle();

    const result = validateEvent(symbolEvent(harness.captured));
    expect(result.valid).toBe(true);
  });

  it("stays silent when a save changed nothing", async () => {
    // Ctrl+S on an unmodified file, and format-on-save that reformatted
    // nothing, are both extremely common.
    register();
    stub.fire.didOpenTextDocument(makeDoc(BEFORE));
    stub.fire.didSaveTextDocument(makeDoc(BEFORE));
    await settle();

    expect(symbolEvent(harness.captured)).toBeUndefined();
  });

  it("says nothing about the first save of a file it never saw opened", async () => {
    // With no snapshot there is no diff - reporting the whole file as added
    // would be a lie.
    register();
    stub.fire.didSaveTextDocument(makeDoc(BEFORE));
    await settle();

    expect(symbolEvent(harness.captured)).toBeUndefined();
  });

  it("snapshots documents already open when collection starts", async () => {
    stub.state.openDocuments = [makeDoc(BEFORE) as never];
    register();

    stub.fire.didSaveTextDocument(makeDoc(BEFORE.replace("return 0;", "return 1;")));
    await settle();

    expect(symbolEvent(harness.captured)).toBeDefined();
  });

  it("attributes the second save to the second change, not the first", async () => {
    register();
    stub.fire.didOpenTextDocument(makeDoc(BEFORE));

    const once = BEFORE.replace("return 0;", "return 1;");
    stub.fire.didSaveTextDocument(makeDoc(once));
    await settle();

    const twice = once.replace('import { z } from "zod";', 'import { z } from "zod";\nimport fs from "fs";');
    stub.fire.didSaveTextDocument(makeDoc(twice));
    await settle();

    const events = harness.captured.filter(
      (e) => e.event_type === EVENT_TYPES.CODE_SYMBOLS_CHANGED
    );
    expect(events).toHaveLength(2);
    // The second save touched only the import block, which no symbol owns.
    expect(events[1].payload.symbols_changed).toEqual([]);
    expect(events[1].payload.unattributed_hunks).toBe(1);
    expect(events[1].payload.lines_added).toBe(1);
  });

  it("still reports line counts when no language server answers", async () => {
    stub.state.commandResults.set("vscode.executeDocumentSymbolProvider", () => undefined);
    register();
    stub.fire.didOpenTextDocument(makeDoc(BEFORE));
    stub.fire.didSaveTextDocument(makeDoc(BEFORE.replace("return 0;", "return 1;")));
    await settle();

    const event = symbolEvent(harness.captured)!;
    expect(event.payload.symbols_status).toBe("unsupported_language");
    expect(event.payload.lines_added).toBe(1);
    expect(event.payload.symbols_changed).toEqual([]);
  });

  it("survives a language server that throws", async () => {
    stub.state.commandResults.set("vscode.executeDocumentSymbolProvider", () => {
      throw new Error("server crashed");
    });
    register();
    stub.fire.didOpenTextDocument(makeDoc(BEFORE));
    stub.fire.didSaveTextDocument(makeDoc(BEFORE.replace("return 0;", "return 1;")));
    await settle();

    const event = symbolEvent(harness.captured)!;
    expect(event.payload.symbols_status).toBe("unavailable");
    expect(event.payload.lines_added).toBe(1);
  });

  it("does not track .env files at all", async () => {
    register();
    const envDoc = stub.makeDocument({
      path: "/workspace/my-project/.env",
      languageId: "dotenv",
      getText: () => "API_KEY=abc",
    });
    stub.fire.didOpenTextDocument(envDoc);

    const changed = stub.makeDocument({
      path: "/workspace/my-project/.env",
      languageId: "dotenv",
      getText: () => "API_KEY=xyz",
    });
    stub.fire.didSaveTextDocument(changed);
    await settle();

    expect(symbolEvent(harness.captured)).toBeUndefined();
  });

  it("registers nothing when the capture category is off", async () => {
    const off = await makeHarness({ capture: { codeStructure: false } });
    const disposables = registerCodeStructureCollectors(off.deps);

    expect(disposables).toEqual([]);

    stub.fire.didOpenTextDocument(makeDoc(BEFORE));
    stub.fire.didSaveTextDocument(makeDoc(BEFORE.replace("return 0;", "return 1;")));
    await settle();

    expect(symbolEvent(off.captured)).toBeUndefined();
  });
});
