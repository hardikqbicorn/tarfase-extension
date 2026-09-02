# Architecture

## The one-sentence version

IDE-specific adapters translate native IDE events into a single canonical
schema, buffer them locally, and ship them over HTTPS to an ingestion service
that produces to Kafka; a consumer validates, redacts, and idempotently
persists them into Supabase/PostgreSQL.

## Data flow

```
┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────────┐
│  VS Code   │  │   Cursor   │  │  Windsurf  │  │   JetBrains    │
│ extension  │  │ extension  │  │ extension  │  │    plugin      │
└─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └───────┬────────┘
      │               │               │                 │
      └───────────────┴───────────────┘                 │
                      │                                 │
              ┌───────▼────────┐              ┌──────────▼─────────┐
              │  Event SDK     │              │ Event SDK (Kotlin) │
              │  (TypeScript)  │              │      port          │
              └───────┬────────┘              └──────────┬─────────┘
                      │                                  │
                      └──────────────┬───────────────────┘
                                     │
                        ┌────────────▼────────────┐
                        │  Canonical event schema │
                        │      (v1.0.0)           │
                        └────────────┬────────────┘
                                     │
                        ┌────────────▼────────────┐
                        │   Local event queue     │  ← survives IDE restart,
                        │  (bounded, encrypted)   │    network outage, crash
                        └────────────┬────────────┘
                                     │ HTTPS + Bearer token, batched
                        ┌────────────▼────────────┐
                        │   Ingestion service     │  ← authn, validation,
                        │  (services/kafka-       │    identity stamping,
                        │   producer, :8080)      │    redaction
                        └────────────┬────────────┘
                                     │ idempotent producer, acks=all
                        ┌────────────▼────────────┐
                        │        Kafka            │
                        │  ide.events.raw         │
                        │  ide.events.processed   │
                        │  ide.events.errors      │
                        └────────────┬────────────┘
                                     │ consumer group
                        ┌────────────▼────────────┐
                        │   Consumer service      │  ← validate, enrich,
                        │  (services/kafka-       │    redact, dedupe,
                        │   consumer, :8082)      │    persist
                        └────────────┬────────────┘
                                     │ bulk upsert
                        ┌────────────▼────────────┐
                        │  Supabase / PostgreSQL  │
                        │  raw_events (monthly    │
                        │  partitions), dims,     │
                        │  event_errors           │
                        └─────────────────────────┘

              ┌─────────────────────────┐
              │   API service (:8081)   │  ← installation registration,
              │   (services/api)        │    credential issuance/revocation
              └─────────────────────────┘
```

## Why the extension does not talk to Kafka

This is the single most consequential design decision, so it is worth stating
plainly. The obvious architecture — extension produces straight to Kafka — is
wrong here:

1. **Credentials.** Every developer machine would need broker credentials.
   Those credentials would be extractable from any installation, and Kafka ACLs
   are not granular enough to stop a leaked one from writing arbitrary events
   attributed to anyone.
2. **Network reachability.** Brokers would have to be internet-facing, or every
   developer would need VPN access just to use their editor.
3. **Trust.** A broker cannot validate a schema or redact a secret. Anything an
   extension produces lands in the log verbatim, forever.
4. **Coupling.** Changing brokers, partitioning, or the Kafka version would
   require every installed extension to be updated.

The HTTPS ingestion service fixes all four: extensions hold a per-installation
token, brokers stay private, and the service is the trust boundary where
validation, identity stamping, and redaction happen.

## Component responsibilities

### `packages/event-schema`

The canonical `IDEEvent` envelope and the event type catalog, validated with
zod. Versioned via `schema_version`; the ingestion service and consumer both
reject versions they do not support rather than guessing.

### `packages/event-sdk`

The IDE-agnostic core. Owns the local queue, batching, retry/backoff,
throttling, opt-out policy, and transport. **This is where "add an IDE without
touching the backend" is enforced**: adapters call `collector.capture(...)` and
implement `IdeAdapter`; they never construct an event envelope, talk to the
network, or know Kafka exists.

### `packages/crypto`

Redaction and encryption. Applied twice by design (see
[Security model](#security-model)).

### `extensions/*`

One adapter per IDE family. The only IDE-aware code in the system.

### `services/kafka-producer` (ingestion, :8080)

The trust boundary. Authenticates the installation token, validates each event,
overwrites client-supplied `user_id`/`installation_id` with the token's claims,
re-runs redaction, and produces to Kafka.

### `services/kafka-consumer` (:8082)

Consumes `ide.events.raw`, validates, enriches with Kafka provenance, redacts
again, dedupes, and bulk-upserts into Postgres. Failures go to `event_errors`
and `ide.events.errors`.

### `services/api` (:8081)

Control plane: enrollment codes, installation registration, revocation, and an
operator event-query endpoint.

## Reliability

### Nothing is lost when the network is down

The extension's queue is bounded, ordered, and persisted to disk. On a flush
failure, events are *nacked* rather than dropped: their attempt count rises and
a full-jitter exponential backoff delays the retry. The queue is written
atomically (temp file + rename), so a crash mid-write cannot corrupt it, and
it is reloaded on the next IDE start.

Two bounds keep a permanent outage from becoming a permanent problem:
`maxQueueSize` (oldest events are evicted once full, so disk and memory stay
bounded) and `maxDeliveryAttempts` (an event that has failed 10 times is
dropped, so one poison pill cannot block the queue behind it forever).

### Nothing is duplicated when things are retried

At-least-once delivery is a certainty at three layers — the extension retries a
batch it never saw acknowledged, the Kafka producer retries a send, and the
consumer reprocesses after a rebalance. So duplicates are handled rather than
prevented:

- **Producer**: `idempotent: true` dedupes retries within a producer session at
  the broker.
- **Consumer**: in-batch dedupe collapses repeats inside one batch (Postgres
  rejects `ON CONFLICT` against two rows in the same statement), then the
  `UNIQUE (event_id, timestamp)` constraint makes the write itself idempotent.
- **The `event_id` UUID is generated once, at capture.** It is never
  regenerated on retry, which is what makes the constraint work end to end.

### Offsets follow durability

The consumer resolves Kafka offsets only *after* a batch is durably written. A
database outage throws, offsets stay uncommitted, and Kafka redelivers. The
redelivered batch then hits the unique constraint and no-ops. This is what
gives effectively exactly-once persistence on top of at-least-once transport.

## Scaling

**Partitioning.** Events are keyed by `installation_id`. All events from one
installation land on one partition, preserving per-installation ordering, while
load spreads across the cluster. Consumer parallelism is capped by partition
count (6 for `ide.events.raw` by default) — raise it before adding consumers.

**Database.** `raw_events` is RANGE-partitioned by month on `timestamp`. At the
target scale this keeps index size bounded, turns retention into a
`DETACH`+`DROP` instead of a mass `DELETE`, and lets the planner prune whole
months for time-bounded queries. Partitions are created lazily by the consumer
and can be pre-created by a scheduled job.

**Write throughput.** The consumer uses `eachBatch`, not `eachMessage`, and
writes one bulk `INSERT` per chunk. This is the difference between thousands
and tens of thousands of events per second.

## Security model

Defense in depth, with redaction applied **twice**:

1. **In the IDE**, before an event enters the queue. A secret never touches the
   disk queue or the network.
2. **At the ingestion service**, before producing to Kafka. This covers an
   older extension build, a misconfigured client, or a forged request — a
   secret cannot reach Kafka (and therefore the database) even if step 1 was
   bypassed.

Beyond redaction, collectors are written so sensitive data is never gathered in
the first place: document content is reduced to counts, diagnostic messages and
breakpoint conditions are dropped because they quote source, debug
configuration values are never read, terminal *output* is never captured, and
file paths outside the workspace are reduced to a basename so a developer's
home directory layout does not leak.

See [`docs/security.md`](./security.md) for the authentication flow, threat
model, and the full list of what is never collected.

## Adding a new IDE

Implement `IdeAdapter` in `extensions/<new-ide>/` and map native events onto
`collector.capture(...)`. Nothing else changes — not the schema, the ingestion
service, Kafka, the consumer, or the database.

If the new IDE cannot observe some category, declare it in `capabilities` and
emit the corresponding `*_unavailable` event rather than silently emitting
nothing. That distinction — "no activity" versus "not observable" — is not
recoverable after the fact, so it has to be recorded at capture time.
