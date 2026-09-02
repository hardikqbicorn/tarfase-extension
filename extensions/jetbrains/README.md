# JetBrains Plugin

An IntelliJ Platform plugin implementing the same adapter contract as the
VS Code extension. One plugin covers the whole family — IDEA, PyCharm, GoLand,
WebStorm, RubyMine, CLion, Rider, and Android Studio — because it depends only
on `com.intellij.modules.platform`.

## Status

This is a **working skeleton**, not a shipped plugin. The parts that define the
architecture are implemented in Kotlin:

| Component | File | State |
| --- | --- | --- |
| Canonical event schema | `schema/IdeEvent.kt` | Complete, wire-compatible with the TypeScript schema |
| Redaction | `sdk/Redactor.kt` | Complete, mirrors `packages/crypto` |
| Local offline queue | `sdk/EventQueue.kt` | Complete: bounded, ordered, atomic persistence, backoff |
| Collector + HTTP transport | `sdk/EventCollector.kt` | Complete |
| Settings + credential storage | `settings/CollectorSettings.kt` | Complete (PasswordSafe-backed) |
| Project/file/editor listeners | `listeners/FileListeners.kt` | Implemented |
| Git, build/test, debug listeners | — | Not yet wired |
| Register / Show Status actions | — | Referenced in the README, not yet implemented |

What is **not** required to finish it: any change to the event schema, the
ingestion service, Kafka, or the database. That is the point of the
architecture — a new IDE is a new adapter and nothing else.

## Building

```bash
cd extensions/jetbrains
./gradlew buildPlugin      # produces build/distributions/*.zip
./gradlew runIde           # launches a sandbox IDE with the plugin loaded
./gradlew test             # runs the Kotlin unit tests
```

Install the built ZIP via **Settings → Plugins → ⚙ → Install Plugin from Disk**.

## Why the SDK is duplicated in Kotlin

The JVM cannot run the TypeScript SDK, so `sdk/` is a deliberate port rather
than shared code. The **contract** is what is shared, not the implementation:

- the JSON wire format is byte-for-byte identical, so the ingestion service,
  Kafka topics, consumer, and database schema are untouched;
- `IdeEvent.SCHEMA_VERSION` must be bumped in lockstep with
  `packages/event-schema/src/schema.ts`;
- the redaction rules must stay in step with `packages/crypto`. The ingestion
  service re-redacts at the trust boundary, so a rule missing here is caught
  server-side — but only after the secret has crossed the network, which is why
  the port matters.

## Platform differences from VS Code

**Threading.** IntelliJ fires listeners from multiple threads, so the queue is
lock-guarded and the collector uses atomics — the TypeScript version can assume
a single-threaded event loop. `capture()` still does only synchronous policy
checks and an enqueue, so it is safe to call from the EDT and never blocks
typing.

**Projects are real.** IntelliJ has a genuine project model, so `project` and
`workspace` are populated from it rather than both being derived from a folder
path as in VS Code.

**Git.** Accessed through Git4Idea reflectively, so the plugin loads in an IDE
without the Git plugin and reports git as unavailable instead of failing.

**AI.** As with every other target IDE, the platform exposes no public API for
observing assistant activity — including its own AI Assistant. The service
emits `ai.feature_unavailable` once at startup so downstream queries can tell
"no AI used" apart from "AI not observable here".

## Configuration

Settings live under **Settings → Tools → IDE Event Collector** and mirror the
VS Code extension's `telemetry.*` keys. Collection is off until explicitly
enabled.

Credentials are never stored in settings XML (which is plain text and is synced
by Settings Repository). They go to the IDE's `PasswordSafe`, which is backed by
the OS keychain — the JetBrains equivalent of VS Code's `SecretStorage`.
