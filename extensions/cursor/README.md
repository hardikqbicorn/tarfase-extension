# Cursor Adapter

Cursor is a Visual Studio Code fork, so it runs the **same extension code** as
`extensions/vscode`. This directory holds only what differs: packaging metadata
and the IDE identity.

## How it works

`extensions/vscode/src/extension.ts` detects the host at runtime from
`vscode.env.appName` and reports `ide.name` accordingly:

| Host             | `vscode.env.appName` contains | `ide.name` |
| ---------------- | ----------------------------- | ---------- |
| VS Code          | `Visual Studio Code`          | `vscode`   |
| Cursor           | `Cursor`                      | `cursor`   |
| Windsurf         | `Windsurf`                    | `windsurf` |

So one build serves all three, and events are still attributable per IDE. The
`IDE_COLLECTOR_IDE_NAME` environment variable overrides detection when a
purpose-built package is preferred.

## Building a Cursor-specific package

```bash
npm run build -w extensions/vscode
cd extensions/vscode
npx vsce package --out ../cursor/ide-event-collector-cursor.vsix
```

Install it in Cursor via **Extensions → … → Install from VSIX**, or:

```bash
cursor --install-extension ide-event-collector-cursor.vsix
```

## Capability differences from VS Code

Cursor tracks VS Code's extension API closely, so workspace, file, editor,
terminal, git, debug, task, and diagnostics collection all behave identically.

The meaningful gap is AI. Cursor's assistant — Chat, Composer, Tab completion,
and agent runs — is **not exposed through any public extension API**. An
extension cannot observe another extension's (or the host's own) AI activity.
The adapter therefore reports `ai.feature_unavailable` once at activation
rather than silently emitting nothing, so a downstream query can tell "this
developer used no AI" apart from "we cannot see AI in this IDE".

If Cursor later exposes an AI API, only this adapter needs to change: emit the
existing `ai.*` event types through `AiEventReporter`. The schema already
defines them, and no backend change is required.

## Adding real AI events today

A cooperating extension can push AI events into the pipeline:

```ts
const collector = vscode.extensions
  .getExtension("ide-collector.ide-event-collector")
  ?.exports;

collector?.ai.reportPrompt({ provider: "cursor", model: "gpt-5", prompt_tokens: 120 });
collector?.ai.codeGenerated({ provider: "cursor", lines_generated: 24, accepted: true });
```

These flow through the same redaction, buffering, and delivery path as every
other event.
