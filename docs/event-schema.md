# Canonical Event Schema

Version **1.0.0**. Defined in `packages/event-schema`; that package is the
source of truth, this document describes it.

Every event from every IDE has exactly this shape. That is what lets the
ingestion service, Kafka topics, consumer, and database be shared across
VS Code, Cursor, Windsurf, and JetBrains without a line of IDE-specific code
below the adapter layer.

## Envelope

```typescript
interface IDEEvent {
  event_id: string;          // UUID v4, generated once at capture
  event_type: string;        // from the catalog below
  timestamp: string;         // ISO-8601, set at capture

  user_id: string;           // server-authoritative
  installation_id: string;   // server-authoritative
  session_id: string;        // one IDE window/session

  ide: {
    name: string;            // "vscode" | "cursor" | "windsurf" | "jetbrains:<product>"
    version?: string;
  };

  workspace?: { id?: string; name?: string };
  project?:   { id?: string; name?: string };
  repository?: { id?: string; name?: string; branch?: string };
  file?:      { path?: string; language?: string };

  payload: Record<string, unknown>;    // event-specific, JSONB in Postgres
  metadata?: Record<string, unknown>;  // ingestion provenance, enrichment

  schema_version: string;    // "1.0.0"
}
```

### Field notes

**`event_id`** is generated **once**, at capture, and never regenerated on
retry. This is load-bearing: it is the deduplication key
(`UNIQUE (event_id, timestamp)` in `raw_events`), so a retried batch or a
redelivered Kafka partition produces no duplicate rows. Regenerating it on
retry would silently break idempotency end to end.

**`user_id` / `installation_id`** are overwritten by the ingestion service with
the authenticated token's claims. Whatever a client sends is ignored, so a
compromised installation cannot attribute events to someone else.

**`session_id`** is one IDE window. A new window is a new session even for the
same project.

**IDs (`workspace.id`, `project.id`, `repository.id`)** are SHA-256 prefixes of
the absolute path — stable across sessions, non-reversible, and safe to group
by without revealing a directory layout.

**`file.path`** is always workspace-relative. A file outside the workspace is
reduced to its basename, so a developer's home directory never appears. With
`telemetry.hashFilePaths` enabled it becomes `sha256:<32 hex chars>`.

**`payload`** is deliberately unconstrained and stored as JSONB, so a new event
type needs no migration. It is GIN-indexed for ad-hoc queries.

**`metadata`** carries an `_ingest` block added by the consumer (Kafka topic,
partition, offset, processing time), useful for tracing an event back to its
message.

## Versioning

`schema_version` is checked by both the ingestion service and the consumer;
an unsupported version is **rejected to the error path**, never guessed at.

- **Additive changes** (a new optional field, a new event type) do not require
  a version bump — older consumers ignore what they do not know.
- **Breaking changes** (renaming, removing, retyping, or changing the meaning
  of a field) require a bump, added to `SUPPORTED_SCHEMA_VERSIONS`, with the
  consumer migrating older versions on read.

Event types are **append-only**. Removing or renaming one breaks historical
queries over data that is already stored.

Because the JetBrains plugin carries a Kotlin port of the schema, a version
bump must land in `packages/event-schema/src/schema.ts` **and**
`extensions/jetbrains/.../schema/IdeEvent.kt` together.

## Event catalog

### Workspace
`workspace.opened` · `workspace.closed` · `project.opened` · `project.changed`

### File
`file.opened` · `file.closed` · `file.created` · `file.deleted` ·
`file.renamed` · `file.saved` · `file.modified`

### Code structure
`code.symbols_changed`

Emitted once per save that changed something. Answers *what* changed, not just
how much: which functions, classes and variables the edit landed in, and how
much of the file it left alone.

```json
{
  "lines_added": 2,
  "lines_removed": 1,
  "lines_unchanged": 412,
  "hunk_count": 1,
  "symbols_changed": [
    {
      "name": "calculateTotal",
      "qualified_name": "OrderService.calculateTotal",
      "kind": "method",
      "lines_added": 2,
      "lines_removed": 1,
      "edit_count": 1,
      "signature_changed": false
    }
  ],
  "symbols_changed_count": 1,
  "symbols_unchanged_count": 18,
  "symbols_total": 19,
  "kinds_changed": ["method"],
  "unattributed_hunks": 0,
  "symbols_truncated": false,
  "approximate": false,
  "symbols_status": "ok"
}
```

**No source code is included.** Names, kinds, line numbers and counts only —
the diff is computed in the extension and the lines are discarded.

`kind` comes from the language server that owns the file, via VS Code's
document symbol provider, so it is exact for any language the developer has
tooling for and cannot be a guess. No model is involved.

| Field | Meaning |
| --- | --- |
| `qualified_name` | Dotted path through enclosing symbols |
| `signature_changed` | The declaration line itself was edited |
| `edit_count` | Separate edit locations inside that symbol |
| `unattributed_hunks` | Edits outside every symbol — imports, top-level statements, or the deletion of a whole symbol, which is no longer in the tree to attribute to |
| `symbols_truncated` | The list was capped at 50; the `*_count` fields stay exact |
| `approximate` | The file was too large to diff exactly, so one coarse hunk is reported |
| `symbols_status` | `ok`, `unsupported_language` (no server for this language), or `unavailable` (the server errored or timed out) |

Turn it off with `telemetry.capture.codeStructure`. Query it through the
`symbol_changes`, `file_change_summary` and `symbol_hotspots` views.

### Editor
`editor.cursor_moved` · `editor.selection_changed` · `editor.active_changed` ·
`editor.document_changed` · `editor.language_changed`

High-frequency; throttled per file. Content is never included — only counts.

### Terminal
`terminal.created` · `terminal.opened` · `terminal.closed` ·
`terminal.command_executed` · `terminal.command_completed`

Command lines pass through redaction. Terminal **output** is never captured.

### Git
`git.branch_checkout` · `git.commit` · `git.merge` · `git.pull` · `git.push` ·
`git.rebase` · `git.stage` · `git.unstage` · `git.repository_changed`

VS Code exposes repository *state*, not operations, so these are derived by
diffing state snapshots (`extensions/vscode/src/git-diff.ts`). Commit messages,
diffs, and remote URLs are not collected.

### Build / Test / Debug
`build.started` · `build.completed` · `build.failed` · `test.started` ·
`test.completed` · `test.failed` · `debugger.started` · `debugger.stopped` ·
`breakpoint.added` · `breakpoint.removed` · `diagnostics.reported`

### AI
`ai.session_started` · `ai.session_ended` · `ai.chat_started` ·
`ai.user_prompt` · `ai.response` · `ai.agent_invoked` · `ai.tool_invoked` ·
`ai.tool_result` · `ai.code_generated` · `ai.code_modified` ·
`ai.feature_unavailable`

**No target IDE exposes a public API for observing another extension's AI
activity.** Adapters emit `ai.feature_unavailable` once at activation so a
query can distinguish "no AI used" from "AI not observable here" — a
distinction that is unrecoverable if not recorded at capture time. Real AI
events are contributed by cooperating extensions via the reporter API (see
[`api.md`](./api.md#extension-public-api-vs-code)).

### Lifecycle
`session.started` · `session.ended` · `extension.activated` ·
`extension.deactivated`

## Examples

[`example-events.json`](./example-events.json) holds a validated example of
each major type. It is **generated** by `docs/generate-examples.ts` from the
real schema and factory and validated against the same validator the ingestion
service uses, so it cannot drift from the code:

```bash
npx tsx docs/generate-examples.ts
```

## Database mapping

The envelope is flattened into columns in `raw_events` for indexed access,
while `payload` and `metadata` stay JSONB:

| Envelope | Column |
| --- | --- |
| `event_id` | `event_id` (with `timestamp`, the dedupe key) |
| `ide.name` / `ide.version` | `ide_name` / `ide_version` |
| `workspace.id` / `.name` | `workspace_id` / `workspace_name` |
| `project.id` / `.name` | `project_id` / `project_name` |
| `repository.id` / `.name` / `.branch` | `repository_id` / `repository_name` / `branch` |
| `file.path` / `.language` | `file_path` / `language` |
| `payload` / `metadata` | `payload` / `metadata` (JSONB) |

Indexed on `user_id`, `installation_id`, `session_id`, `event_type`,
`timestamp`, `project_id`, `repository_id`, a composite
`(user_id, event_type, timestamp DESC)`, and a GIN index on `payload`.
