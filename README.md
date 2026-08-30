# Universal IDE Event Collection Platform

Collects developer activity from multiple IDEs, normalizes it into one
canonical event schema, ships it through Apache Kafka, and persists it in
Supabase/PostgreSQL.

```
VS Code ─┐
Cursor ──┼─→ Event SDK ─→ Local buffer ─→ Ingestion API ─→ Kafka ─→ Consumer ─→ Supabase
Windsurf ┤
JetBrains┘
```

Adding an IDE means writing one adapter. The schema, ingestion service, Kafka
layer, consumer, and database do not change.

---

## Status

| Component | State |
| --- | --- |
| Canonical event schema (v1.0.0) | Complete, versioned, validated |
| Event SDK (buffer, batching, retry, redaction) | Complete |
| VS Code extension | **Working MVP** — workspace, file, editor, terminal, git, debug, task, diagnostics |
| Cursor / Windsurf | Working — same build, runtime IDE detection |
| JetBrains plugin | Kotlin skeleton: schema, SDK, queue, transport, file/editor listeners. Git and build/test listeners not yet wired |
| Ingestion service (Kafka producer) | Complete |
| Kafka consumer | Complete, idempotent |
| Supabase schema + migrations | Complete, partitioned, RLS |
| Registration / auth flow | Complete |
| Docker Compose environment | Complete |
| Tests | 175 unit + 10 integration, all passing |

**Verified:** the full path — capture → local buffer → ingestion → Kafka →
consumer → database — runs green against real PostgreSQL 16, including
partition routing and idempotency under replay. See [Testing](#testing).

**Not yet done:** AI event collection is limited by IDE APIs (see
[below](#a-note-on-ai-events)); the JetBrains plugin is a skeleton; the Docker
stack is validated by config but has not been run in this environment (no
Docker daemon available).

---

## Quick start

Default topology: **Kafka in Docker, events persisted to Supabase.**

```bash
git clone <repo> && cd universal-ide-event-collector
npm install

npm run build             # required: the extension imports the built packages

cp .env.example .env      # set DATABASE_URL to your Supabase Session pooler string
npm run migrate           # apply the schema to Supabase
npm run check:db          # verify connectivity, schema, and the write path

docker compose up --build
```

Step-by-step walkthrough, including running the VS Code extension:
[`docs/running-locally.md`](docs/running-locally.md).

> **Use Supabase's Session pooler, not the direct connection.**
> `db.<ref>.supabase.co` is IPv6-only unless you have the IPv4 add-on, and
> Docker containers have no IPv6 by default — so it works from your shell and
> fails from a container. `npm run check:db` detects this and names the fix.
> Details in [`docs/supabase-setup.md`](docs/supabase-setup.md).

That brings up Kafka (KRaft), Kafka UI, and the three services:

| Service | URL |
| --- | --- |
| Ingestion API | http://localhost:8080 |
| Control-plane API | http://localhost:8081 |
| Consumer (metrics) | http://localhost:8082 |
| Kafka UI | http://localhost:8090 |

Verify:

```bash
curl localhost:8080/health && curl localhost:8081/health && curl localhost:8082/ready
```

### Prefer a fully local stack?

Local PostgreSQL is still available behind a Compose profile — it does not
start by default:

```bash
docker compose --profile local-db up --build   # with DATABASE_URL unset
```

### Running the VS Code extension

```bash
npm run build     # if you have not already
code --extensionDevelopmentPath="$(pwd)/extensions/vscode"
```

In the launched window:

1. **Settings → `telemetry.enabled`** → on. *(Collection is opt-in and off by
   default.)*
2. **Command Palette → "IDE Collector: Register This Installation"**. In
   development, leave the enrollment code blank — `ALLOW_OPEN_ENROLLMENT=true`
   lets the extension self-enroll.
3. Edit and save a file.
4. **Command Palette → "IDE Collector: Show Status"** to see queue and delivery
   counts.

### Seeing the events land

In the Supabase SQL editor:

```sql
select event_type, ide_name, file_path, "timestamp"
from raw_events
order by "timestamp" desc
limit 20;
```

Or watch `ide.events.raw` in Kafka UI at http://localhost:8090.

### Issuing a real enrollment code

Open enrollment is a development convenience. The production flow:

```bash
curl -X POST localhost:8081/v1/enrollment-codes \
  -H "Authorization: Bearer dev-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"email":"developer@example.com"}'
```

Paste the returned code into the extension's Register prompt. Codes are
single-use and expire in 15 minutes.

---

## Layout

```
universal-ide-event-collector/
├── extensions/
│   ├── vscode/          VS Code extension (also serves Cursor + Windsurf)
│   ├── cursor/          Packaging + capability notes
│   ├── windsurf/        Packaging + capability notes
│   └── jetbrains/       Kotlin IntelliJ Platform plugin
├── packages/
│   ├── event-schema/    Canonical versioned schema (zod)
│   ├── event-sdk/       IDE-agnostic collector: queue, batching, retry, transport
│   ├── crypto/          Redaction engine + AES-256-GCM helpers
│   └── shared-utils/    Logger, backoff, throttle, metrics registry
├── services/
│   ├── kafka-producer/  Ingestion API (:8080) — the trust boundary
│   ├── kafka-consumer/  Consumer → Supabase (:8082)
│   └── api/             Registration + control plane (:8081)
├── database/supabase/   Migrations + consolidated schema
├── infrastructure/      Dockerfile, Kafka topic setup
├── docs/                Architecture, API, security, schema, examples
└── tests/integration/   End-to-end pipeline tests
```

---

## How it works

Four design decisions carry most of the weight.

### 1. Extensions never talk to Kafka

They POST batches to an HTTPS ingestion service. Brokers stay private, each
installation holds a scoped token instead of broker credentials, and the
service becomes a real trust boundary where validation, identity stamping, and
redaction happen. A broker can do none of that.

### 2. Nothing is lost, nothing is duplicated

The local queue is bounded, ordered, encrypted, and atomically persisted, so
events survive a network outage, an IDE crash, and a restart. Delivery is
at-least-once at three layers, so duplicates are *handled* rather than
prevented: `event_id` is generated once at capture and never regenerated, and
`UNIQUE (event_id, timestamp)` makes the database write idempotent. The
consumer commits Kafka offsets only after a durable write, so a database outage
means redelivery, not loss.

Two bounds stop a permanent outage becoming a permanent problem: `maxQueueSize`
evicts the oldest events, and `maxDeliveryAttempts` drops an event that has
failed repeatedly, so one poison pill cannot block everything behind it.

### 3. Redaction runs twice

Once in the IDE before an event reaches the queue, and again at the ingestion
service before producing to Kafka. The second pass exists because the first can
be bypassed — by an older extension build, a misconfigured client, or a forged
request. A secret in the database is effectively unrecallable, so the boundary
is enforced where it can be.

Better still, collectors avoid gathering sensitive data at all: document
content becomes counts, diagnostic messages and breakpoint conditions are
dropped (they quote source), terminal output is never read, and paths outside
the workspace are reduced to a basename.

### 4. IDE knowledge stops at the adapter

Adapters implement `IdeAdapter` and call `collector.capture(...)`. They never
build an envelope, touch the network, or know Kafka exists. That is what makes
"add an IDE without changing the backend" true rather than aspirational — the
JetBrains plugin was added without touching a line of the schema, ingestion
service, consumer, or database.

Full detail in [`docs/architecture.md`](docs/architecture.md).

---

## A note on AI events

The brief asks for AI chat, prompt, agent, and tool-invocation events. Here is
the honest position:

**No IDE in the target set exposes a public API for observing another
extension's AI activity.** VS Code's `vscode.lm` and `vscode.chat` let an
extension *be* a chat participant or *call* a model — they do not let it
eavesdrop on Copilot. Cursor's Chat/Composer/Tab and Windsurf's Cascade ship no
public telemetry API. JetBrains' AI Assistant is likewise closed.

Rather than pretend otherwise, the platform does two things:

1. Every adapter emits **`ai.feature_unavailable`** once at activation,
   recording what the host does and does not expose. Without this, "no AI
   events" is ambiguous between *the developer used no AI* and *we cannot see
   AI here* — and that distinction is unrecoverable after the fact.
2. The full `ai.*` event catalog is defined and wired, and the VS Code
   extension exports an **`AiEventReporter`** so a cooperating AI extension can
   push real events through the same redaction, buffering, and delivery path:

```ts
const collector = vscode.extensions
  .getExtension("ide-collector.ide-event-collector")?.exports;

collector?.ai.reportPrompt({ provider: "copilot", model: "gpt-5", prompt_tokens: 120 });
collector?.ai.codeGenerated({ lines_generated: 24, accepted: true });
```

If an IDE later opens up its assistant, only that adapter changes. The schema,
pipeline, and database already accommodate it.

---

## Configuration

Extension settings (VS Code `settings.json`):

```json
{
  "telemetry.enabled": true,
  "telemetry.ingestionEndpoint": "https://ingest.example.com",
  "telemetry.registrationEndpoint": "https://api.example.com",
  "telemetry.batchSize": 50,
  "telemetry.flushInterval": 5000,
  "telemetry.maxQueueSize": 10000,
  "telemetry.redactSecrets": true,
  "telemetry.hashFilePaths": false,
  "telemetry.encryptLocalQueue": true,
  "telemetry.disabledEventTypes": ["editor.cursor_moved"],
  "telemetry.capture.terminal": false
}
```

Backend services are configured entirely by environment variables — see
[`.env.example`](.env.example). No secret is hard-coded, and the services
refuse to start in production without `JWT_SECRET`, `ADMIN_API_KEY`, and
`DATABASE_URL`.

Before deploying, work through the checklist in
[`docs/security.md`](docs/security.md#deployment-checklist).

---

## Testing

```bash
npm test                  # 175 unit + 10 integration tests
npm run test:db           # integration suite against a real PostgreSQL instance
npm run typecheck         # tsc -b across the monorepo
```

Coverage:

| Area | What is verified |
| --- | --- |
| Schema | Validation, unknown types, malformed UUIDs, version gating |
| Redaction | Env assignments, AWS/GitHub/Slack keys, JWTs, PEM blocks, nested keys |
| Queue | FIFO ordering, size bound, backoff, crash recovery, corrupt-file handling |
| Collector | Opt-outs, throttling, path hashing, offline retention, poison-pill eviction |
| VS Code collectors | Real capture through a `vscode` API stub — events, throttling, and privacy guarantees |
| Git inference | Checkout vs commit, push vs pull, commit-empties-index vs unstage |
| Ingestion | Auth, spoofed installation ids, partial batches, 503 backpressure |
| Consumer | Idempotency, in-batch dedupe, DLQ, database-outage redelivery |
| End-to-end | Capture → buffer → ingestion → Kafka → consumer → database |

`npm run test:db` provisions a throwaway PostgreSQL cluster, applies the
migrations, and runs the integration suite against it — exercising the real
schema, partition routing, and the unique constraint behind idempotency, not a
stand-in. Without it the same suite runs against an in-memory store with
matching semantics, so `npm test` works anywhere.

---

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/running-locally.md`](docs/running-locally.md) | Step-by-step local run: build, configure, migrate, Docker, extension |
| [`docs/supabase-setup.md`](docs/supabase-setup.md) | Supabase connection, migrations, the IPv6 gotcha, troubleshooting |
| [`docs/architecture.md`](docs/architecture.md) | Data flow, component responsibilities, reliability, scaling |
| [`docs/event-schema.md`](docs/event-schema.md) | Envelope, versioning rules, full event catalog, DB mapping |
| [`docs/api.md`](docs/api.md) | HTTP endpoints, auth, status codes, metrics |
| [`docs/security.md`](docs/security.md) | What is never collected, redaction, auth flow, threat model, deployment checklist |
| [`docs/example-events.json`](docs/example-events.json) | Validated example payloads (generated from the schema) |

---

## Database commands

| Command | What it does |
| --- | --- |
| `npm run migrate` | Applies migrations to `DATABASE_URL` (works against Supabase) |
| `npm run migrate -- --dry-run` | Shows what would be applied, changes nothing |
| `npm run check:db` | Diagnoses DNS, TLS, schema, and the write path |
| `npm run test:db` | Runs the integration suite against a throwaway local PostgreSQL |
| `npm run rebuild` | Clears the incremental build cache and rebuilds |

Migrations are tracked in `schema_migrations`, so re-running is safe. The
runner refuses to proceed if an already-applied migration has been edited,
rather than letting the database and the repo diverge silently.
