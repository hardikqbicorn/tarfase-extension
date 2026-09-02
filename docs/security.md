# Security & Privacy

This platform reads a developer's editor. That is an unusually sensitive place
to put a data collector, so the guiding rule is: **do not collect it in the
first place**, and where something must be collected, assume every layer below
will be compromised.

## What is never collected

Hard rules. If a collector cannot satisfy these, it does not ship.

| Never collected | Why |
| --- | --- |
| Passwords, API keys, tokens, secrets | Obvious |
| Private SSH/TLS keys | Obvious |
| Environment variable **values** | `.env` files and shell exports are where secrets live |
| Credit card numbers, SSNs | PII with legal weight |
| **Source code / document content** | The single largest leak vector. Counts, shapes, and declaration names only — see "Symbol names" below |
| **Terminal output** | Routinely contains tokens, connection strings, and dumped credentials |
| **Diagnostic messages** | They quote source (`Cannot find name 'API_KEY'`) |
| **Breakpoint conditions** | Arbitrary expressions over live values |
| **Debug configuration values** | `launch.json` `env` blocks embed credentials |
| **Commit messages, diffs, remote URLs** | Commit SHAs are enough for activity analytics |
| **Absolute paths outside the workspace** | Leak usernames and directory layout |

What *is* collected in their place: event types, timestamps, counts (lines,
characters, files, errors), languages, workspace-relative paths, branch names,
commit SHAs, exit codes, durations, and the symbol names described next.

## Symbol names: the one identifier that does leave

`code.symbols_changed` reports which functions, classes and variables a save
touched, **by name** — `OrderService.calculateTotal`, `MAX_RETRIES`. This is
worth stating plainly because it is the only place an identifier written by
the developer leaves the machine.

What makes it a different thing from source code:

- The names come from the **document symbol tree**, not from the text. The
  extension asks VS Code for the declarations the language server already
  parsed. A string literal, a comment, a hardcoded key, the body of a
  function — none of it is in that tree, so none of it can be read out.
- The diff that produces line numbers runs in the extension, and the lines are
  discarded before the event is built. No hunk text is retained.
- Only the **declaration name** is available, never the value. A change to
  `const API_KEY = "sk-live-…"` reports `{"name": "API_KEY", "kind":
  "variable", "lines_added": 1}`. The literal is never seen.

A test asserts this directly: it edits a line containing a live-looking key and
checks the serialised event contains neither the key nor any source token.

Two settings control it:

| Setting | Effect |
| --- | --- |
| `telemetry.capture.codeStructure` | `false` stops these events entirely |
| `telemetry.hashFilePaths` | Hashes paths; symbol names are unaffected |

If your threat model makes identifiers sensitive — a codebase where class names
disclose unreleased products or customer names — turn `capture.codeStructure`
off. It is a deliberate, separable capability rather than something folded into
file events.

## Redaction

Applied **twice**, on purpose.

1. **In the IDE**, before an event enters the local queue. A secret never
   touches the disk queue or the network.
2. **At the ingestion service**, before producing to Kafka. This is the trust
   boundary: an older extension build, a misconfigured client, or a forged
   request cannot get a secret into Kafka — and therefore cannot get one into
   the database, from which it would be effectively unrecallable.

Both use the same rule set (`packages/crypto/src/redaction.ts`; the Kotlin port
in `extensions/jetbrains` must be kept in step).

**Two independent mechanisms**, because either alone has a gap:

*Key-name matching* catches structured payloads regardless of value shape —
any field whose name matches `password`, `secret`, `api_key`, `token`,
`private_key`, `credential`, and similar is replaced wholesale.

*Value-shape matching* catches secrets embedded in free text, where there is no
key to inspect — env-style assignments (`OPENAI_API_KEY=...`), AWS access key
IDs, bearer tokens, JWTs, PEM private key blocks, and provider-specific
formats (`sk-`, `ghp_`, `xox[baprs]-`).

Redaction walks nested objects and arrays to a bounded depth, so a secret does
not survive by being nested.

```
OPENAI_API_KEY=sk-abc123...        →  OPENAI_API_KEY=[REDACTED]
AWS_SECRET_ACCESS_KEY=wJalr...     →  AWS_SECRET_ACCESS_KEY=[REDACTED]
{ "password": "hunter2" }          →  { "password": "[REDACTED]" }
Authorization: Bearer eyJhbG...    →  Authorization: Bearer [REDACTED]
```

Terminal commands illustrate the intent: the command line is redacted, but the
bare executable name is preserved (`npm`, `git`, `psql`) — so
`AWS_SECRET_ACCESS_KEY=xxx npm deploy` still yields useful aggregate signal
with the secret gone. Leading `KEY=value` tokens are skipped when extracting
that name, so the executable is identified rather than a variable.

## Authentication

```
Operator                      Developer's IDE                Backend
   │                                │                           │
   │  POST /v1/enrollment-codes     │                           │
   ├───────────────────────────────────────────────────────────►│
   │  ◄── code (shown once)         │                           │
   │                                │                           │
   ├── code, out of band ──────────►│                           │
   │                                │  POST /v1/installations/  │
   │                                │       register            │
   │                                ├──────────────────────────►│
   │                                │  ◄── installation_id +    │
   │                                │      installation_token   │
   │                                │                           │
   │                          [OS keychain]                     │
   │                                │                           │
   │                                │  POST /v1/events          │
   │                                │  Bearer <token>           │
   │                                ├──────────────────────────►│
```

Properties that matter:

- **No credential is ever hard-coded in an extension.** The extension ships
  with nothing; it earns a credential at registration.
- **Enrollment codes are short-lived (15 min) and single-use.** Redemption is
  an atomic `UPDATE ... WHERE consumed_at IS NULL`, so concurrent redemptions
  cannot both succeed.
- **Only hashes are stored.** Enrollment codes and installation tokens are
  persisted as SHA-256 hashes. A database compromise yields no usable
  credentials.
- **Tokens live in the OS keychain** — VS Code `SecretStorage`, JetBrains
  `PasswordSafe` — never in settings files, which are plaintext and get synced
  by Settings Sync / Settings Repository.
- **Identity is server-authoritative.** The ingestion service overwrites each
  event's `user_id` and `installation_id` with the token's claims, and rejects
  a batch whose `installation_id` disagrees with the token (`403`). A
  compromised installation can forge its own events; it cannot forge someone
  else's.
- **Revocation is immediate** via `POST /v1/installations/:id/revoke`.

## Consent

Collection is **opt-in and off by default** (`telemetry.enabled: false`). An
enabled-but-unregistered extension collects nothing and prompts the user rather
than silently buffering.

Granularity, all user-controlled:

- **Master switch** — `telemetry.enabled`.
- **Category opt-outs** — workspace, file, editor, terminal, git,
  build/test/debug, AI.
- **Per-event-type opt-outs** — `telemetry.disabledEventTypes`.
- **Path hashing** — `telemetry.hashFilePaths` replaces paths with a SHA-256
  prefix, for developers who consider filenames themselves sensitive.
- **Server-side kill switch** — `users.telemetry_enabled` in the database.

## Data at rest and in transit

**In the IDE.** The offline queue is encrypted with AES-256-GCM
(`telemetry.encryptLocalQueue`, on by default). The key is generated per
installation and stored in the OS keychain, so the queue file alone is useless
to anyone reading the disk. It is written atomically (temp file + rename) so a
crash cannot corrupt it, and a corrupt or undecryptable file is treated as an
empty queue rather than crashing the extension.

**In transit.** HTTPS to the ingestion service. Kafka supports TLS
(`KAFKA_SSL`) and SASL (`KAFKA_SASL_MECHANISM`, `SCRAM-SHA-512` recommended)
— required for any non-local broker.

**In the database.** Supabase encrypts at rest. Row Level Security is enabled
on every table: users can read only their own rows; `event_errors` and
`enrollment_codes` have no read policy at all, making them service-role-only.
The consumer connects as the service role (which bypasses RLS) and is the only
writer.

## Threat model

| Threat | Mitigation |
| --- | --- |
| Developer's laptop stolen | Queue encrypted at rest; token in OS keychain |
| Extension credential extracted | Scoped to one installation; identity is server-stamped so it cannot impersonate others; revocable |
| Malicious extension forges events | `403` on installation mismatch; server-authoritative identity |
| Secret slips past client redaction | Second redaction pass at the ingestion boundary |
| Database compromised | Only credential *hashes* stored; payloads already redacted; RLS limits blast radius |
| Kafka topic read by an unauthorized party | TLS + SASL; payloads already redacted before produce |
| Malicious payload crashes the consumer | Schema validation, bounded redaction depth, dead-letter path; a bad event never blocks a batch |
| Replay of captured events | `UNIQUE (event_id, timestamp)` makes replay a no-op |
| Unbounded local growth during an outage | `maxQueueSize` evicts oldest; `maxDeliveryAttempts` drops poison pills |

## Deployment checklist

Before running this anywhere real:

- [ ] `NODE_ENV=production` (this alone forces `ALLOW_OPEN_ENROLLMENT=false`)
- [ ] `JWT_SECRET` set to a strong random value, **identical** in the API and
      ingestion services (`openssl rand -base64 48`)
- [ ] `ADMIN_API_KEY` set to a strong random value (`openssl rand -hex 32`)
- [ ] TLS terminated in front of both HTTP services
- [ ] `KAFKA_SSL=true` and SASL configured
- [ ] `DATABASE_SSL_REJECT_UNAUTHORIZED=true`
- [ ] `KAFKA_ACKS=-1` (the default; do not lower it — it is what makes an
      accepted event durable)
- [ ] Migrations applied, including RLS (`0002_row_level_security.sql`)
- [ ] Consumer connects as service role; nothing else has write access
- [ ] Retention policy set on topics and on `raw_events` partitions
- [ ] A scheduled job pre-creates next month's partition
- [ ] Alerting on `consumer_events_failed_total` and `consumer_lag_messages`
- [ ] Users told what is collected, and how to turn it off

## Reporting a vulnerability

Do not open a public issue. Contact the platform maintainers directly.
