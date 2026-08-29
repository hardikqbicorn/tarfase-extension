/**
 * Minimal in-memory stand-in for the `vscode` module.
 *
 * vitest aliases `vscode` to this file (see vitest.config.ts), which lets the
 * extension's collectors be exercised for real: a test fires
 * `stub.fire.didSaveTextDocument(...)` and asserts on the event the SDK
 * captured. Only the API surface this extension touches is implemented.
 */

export class Disposable {
  constructor(private readonly callOnDispose: () => void) {}
  dispose(): void {
    this.callOnDispose();
  }
}

type Listener<T> = (event: T) => void;

class EventEmitter<T> {
  private listeners: Listener<T>[] = [];

  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.push(listener);
    return new Disposable(() => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    });
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  get listenerCount(): number {
    return this.listeners.length;
  }
}

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as const;
export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;
export const TextEditorSelectionChangeKind = {
  1: "Keyboard",
  2: "Mouse",
  3: "Command",
  Keyboard: 1,
  Mouse: 2,
  Command: 3,
} as Record<string | number, string | number>;

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly fsPath: string
  ) {}
  static file(path: string): Uri {
    return new Uri("file", path);
  }
  static parse(value: string): Uri {
    const [scheme, rest] = value.split("://");
    return new Uri(scheme ?? "file", rest ?? value);
  }
  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number
  ) {}
}

export class Selection {
  constructor(
    readonly start: Position,
    readonly end: Position
  ) {}
  get active(): Position {
    return this.end;
  }
  get isEmpty(): boolean {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}

export interface StubDocument {
  uri: Uri;
  languageId: string;
  lineCount: number;
  isUntitled: boolean;
  isDirty: boolean;
  getText(): string;
}

export function makeDocument(overrides: Partial<StubDocument> & { path: string }): StubDocument {
  return {
    uri: Uri.file(overrides.path),
    languageId: overrides.languageId ?? "typescript",
    lineCount: overrides.lineCount ?? 10,
    isUntitled: overrides.isUntitled ?? false,
    isDirty: overrides.isDirty ?? false,
    getText: overrides.getText ?? (() => "content"),
  };
}

// --- Emitters, exposed so tests can fire events ------------------------------
const emitters = {
  didOpenTextDocument: new EventEmitter<StubDocument>(),
  didCloseTextDocument: new EventEmitter<StubDocument>(),
  didSaveTextDocument: new EventEmitter<StubDocument>(),
  didChangeTextDocument: new EventEmitter<any>(),
  didCreateFiles: new EventEmitter<{ files: Uri[] }>(),
  didDeleteFiles: new EventEmitter<{ files: Uri[] }>(),
  didRenameFiles: new EventEmitter<{ files: { oldUri: Uri; newUri: Uri }[] }>(),
  didChangeWorkspaceFolders: new EventEmitter<{ added: unknown[]; removed: unknown[] }>(),
  didChangeConfiguration: new EventEmitter<{ affectsConfiguration: (s: string) => boolean }>(),
  didChangeActiveTextEditor: new EventEmitter<any>(),
  didChangeTextEditorSelection: new EventEmitter<any>(),
  didOpenTerminal: new EventEmitter<any>(),
  didCloseTerminal: new EventEmitter<any>(),
  didChangeActiveTerminal: new EventEmitter<any>(),
  didStartTerminalShellExecution: new EventEmitter<any>(),
  didEndTerminalShellExecution: new EventEmitter<any>(),
  didStartDebugSession: new EventEmitter<any>(),
  didTerminateDebugSession: new EventEmitter<any>(),
  didChangeBreakpoints: new EventEmitter<any>(),
  didStartTaskProcess: new EventEmitter<any>(),
  didEndTaskProcess: new EventEmitter<any>(),
  didChangeDiagnostics: new EventEmitter<{ uris: Uri[] }>(),
};

/** Mutable state a test can set before firing events. */
export const state = {
  configuration: new Map<string, unknown>(),
  workspaceFolders: [{ uri: Uri.file("/workspace/my-project"), name: "my-project", index: 0 }] as
    | { uri: Uri; name: string; index: number }[]
    | undefined,
  workspaceName: "my-project" as string | undefined,
  isTrusted: true,
  diagnostics: new Map<string, any[]>(),
  gitExtension: undefined as any,
  appName: "Visual Studio Code",
  version: "1.90.0",
};

export function resetStub(): void {
  state.configuration.clear();
  state.workspaceFolders = [
    { uri: Uri.file("/workspace/my-project"), name: "my-project", index: 0 },
  ];
  state.workspaceName = "my-project";
  state.isTrusted = true;
  state.diagnostics.clear();
  state.gitExtension = undefined;
  state.appName = "Visual Studio Code";
}

export const workspace = {
  get workspaceFolders() {
    return state.workspaceFolders;
  },
  get name() {
    return state.workspaceName;
  },
  get isTrusted() {
    return state.isTrusted;
  },
  getConfiguration(section: string) {
    return {
      get<T>(key: string, fallback: T): T {
        const value = state.configuration.get(`${section}.${key}`);
        return (value === undefined ? fallback : value) as T;
      },
      async update(key: string, value: unknown) {
        state.configuration.set(`${section}.${key}`, value);
      },
    };
  },
  onDidOpenTextDocument: emitters.didOpenTextDocument.event,
  onDidCloseTextDocument: emitters.didCloseTextDocument.event,
  onDidSaveTextDocument: emitters.didSaveTextDocument.event,
  onDidChangeTextDocument: emitters.didChangeTextDocument.event,
  onDidCreateFiles: emitters.didCreateFiles.event,
  onDidDeleteFiles: emitters.didDeleteFiles.event,
  onDidRenameFiles: emitters.didRenameFiles.event,
  onDidChangeWorkspaceFolders: emitters.didChangeWorkspaceFolders.event,
  onDidChangeConfiguration: emitters.didChangeConfiguration.event,
};

export const window = {
  onDidChangeActiveTextEditor: emitters.didChangeActiveTextEditor.event,
  onDidChangeTextEditorSelection: emitters.didChangeTextEditorSelection.event,
  onDidOpenTerminal: emitters.didOpenTerminal.event,
  onDidCloseTerminal: emitters.didCloseTerminal.event,
  onDidChangeActiveTerminal: emitters.didChangeActiveTerminal.event,
  onDidStartTerminalShellExecution: emitters.didStartTerminalShellExecution.event,
  onDidEndTerminalShellExecution: emitters.didEndTerminalShellExecution.event,
  createOutputChannel: () => ({
    appendLine: () => {},
    show: () => {},
    dispose: () => {},
  }),
  createStatusBarItem: () => ({
    text: "",
    tooltip: "",
    command: "",
    show: () => {},
    hide: () => {},
    dispose: () => {},
  }),
  showInformationMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showInputBox: async () => undefined,
};

export const languages = {
  onDidChangeDiagnostics: emitters.didChangeDiagnostics.event,
  getDiagnostics: (uri: Uri) => state.diagnostics.get(uri.fsPath) ?? [],
};

export const debug = {
  onDidStartDebugSession: emitters.didStartDebugSession.event,
  onDidTerminateDebugSession: emitters.didTerminateDebugSession.event,
  onDidChangeBreakpoints: emitters.didChangeBreakpoints.event,
};

export const tasks = {
  onDidStartTaskProcess: emitters.didStartTaskProcess.event,
  onDidEndTaskProcess: emitters.didEndTaskProcess.event,
};

export const extensions = {
  getExtension: (id: string) => (id === "vscode.git" ? state.gitExtension : undefined),
};

export const env = {
  get appName() {
    return state.appName;
  },
  machineId: "test-machine-id",
};

export const commands = {
  registerCommand: (_name: string, _handler: unknown) => new Disposable(() => {}),
  executeCommand: async () => undefined,
};

export const version = state.version;

/** Test-facing helpers to trigger IDE events. */
export const fire = {
  didOpenTextDocument: (doc: StubDocument) => emitters.didOpenTextDocument.fire(doc),
  didCloseTextDocument: (doc: StubDocument) => emitters.didCloseTextDocument.fire(doc),
  didSaveTextDocument: (doc: StubDocument) => emitters.didSaveTextDocument.fire(doc),
  didChangeTextDocument: (event: {
    document: StubDocument;
    contentChanges: { text: string; rangeLength: number }[];
  }) => emitters.didChangeTextDocument.fire(event),
  didCreateFiles: (files: Uri[]) => emitters.didCreateFiles.fire({ files }),
  didDeleteFiles: (files: Uri[]) => emitters.didDeleteFiles.fire({ files }),
  didRenameFiles: (files: { oldUri: Uri; newUri: Uri }[]) =>
    emitters.didRenameFiles.fire({ files }),
  didChangeWorkspaceFolders: (added: unknown[], removed: unknown[]) =>
    emitters.didChangeWorkspaceFolders.fire({ added, removed }),
  didChangeActiveTextEditor: (editor: { document: StubDocument } | undefined) =>
    emitters.didChangeActiveTextEditor.fire(editor),
  didChangeTextEditorSelection: (event: {
    textEditor: { document: StubDocument };
    selections: Selection[];
    kind?: number;
  }) => emitters.didChangeTextEditorSelection.fire(event),
  didOpenTerminal: (terminal: { name: string }) => emitters.didOpenTerminal.fire(terminal),
  didCloseTerminal: (terminal: { name: string; exitStatus?: { code?: number } }) =>
    emitters.didCloseTerminal.fire(terminal),
  didStartTerminalShellExecution: (event: {
    terminal: { name: string };
    execution: { commandLine?: { value?: string } };
  }) => emitters.didStartTerminalShellExecution.fire(event),
  didEndTerminalShellExecution: (event: {
    terminal: { name: string };
    execution: { commandLine?: { value?: string } };
    exitCode?: number;
  }) => emitters.didEndTerminalShellExecution.fire(event),
  didStartDebugSession: (session: { id: string; name: string; type: string }) =>
    emitters.didStartDebugSession.fire(session),
  didTerminateDebugSession: (session: { id: string; name: string; type: string }) =>
    emitters.didTerminateDebugSession.fire(session),
  didChangeBreakpoints: (event: { added?: unknown[]; removed?: unknown[]; changed?: unknown[] }) =>
    emitters.didChangeBreakpoints.fire({
      added: event.added ?? [],
      removed: event.removed ?? [],
      changed: event.changed ?? [],
    }),
  didStartTaskProcess: (event: { execution: any; processId?: number }) =>
    emitters.didStartTaskProcess.fire(event),
  didEndTaskProcess: (event: { execution: any; exitCode?: number }) =>
    emitters.didEndTaskProcess.fire(event),
  didChangeDiagnostics: (uris: Uri[]) => emitters.didChangeDiagnostics.fire({ uris }),
};
