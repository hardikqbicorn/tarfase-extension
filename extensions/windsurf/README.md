# Windsurf Adapter

Windsurf (Codeium) is a Visual Studio Code fork and runs the **same extension
code** as `extensions/vscode`. This directory holds only packaging metadata and
the IDE identity.

## How it works

The extension detects its host at runtime from `vscode.env.appName` and stamps
`ide.name` as `windsurf`. See `extensions/cursor/README.md` for the detection
table — the mechanism is identical. `IDE_COLLECTOR_IDE_NAME` overrides it when
building a purpose-specific package.

## Building a Windsurf-specific package

```bash
npm run build -w extensions/vscode
cd extensions/vscode
npx vsce package --out ../windsurf/ide-event-collector-windsurf.vsix
```

Install via **Extensions → … → Install from VSIX**, or:

```bash
windsurf --install-extension ide-event-collector-windsurf.vsix
```

## Capability differences from VS Code

Workspace, file, editor, terminal, git, debug, task, and diagnostics collection
behave identically to VS Code.

Two caveats:

1. **AI is not observable.** Windsurf's Cascade agent and autocomplete are not
   exposed through a public extension API, so the adapter emits
   `ai.feature_unavailable` at activation rather than silently collecting
   nothing. Real AI events can still be contributed by a cooperating extension
   through the `AiEventReporter` API.

2. **Terminal shell integration may lag upstream.** Command capture depends on
   `window.onDidStartTerminalShellExecution`, which forks sometimes ship later
   than upstream VS Code. The terminal collector feature-detects it: where it is
   absent, terminal lifecycle events (created/opened/closed) are still collected
   and `capabilities.terminalCommandCapture` reports `false`, so the gap is
   visible in the data rather than silent.
