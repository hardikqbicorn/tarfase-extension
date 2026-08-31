# API Reference

Two HTTP services face outward:

| Service | Port | Purpose |
| --- | --- | --- |
| **API** (`services/api`) | 8081 | Registration, credential lifecycle, event queries |
| **Ingestion** (`services/kafka-producer`) | 8080 | Event ingestion |

The consumer (8082) exposes only operational endpoints.

All non-local deployments must be behind TLS. Tokens are bearer credentials:
over plaintext HTTP they are trivially stealable.

---

## Authentication

Two credential types, deliberately separated:

- **Admin API key** (`ADMIN_API_KEY`) — operator credential. Issues enrollment
  codes, revokes installations, queries events. Never ships in an extension.
- **Installation token** — a per-installation JWT (HS256) issued at
  registration. `sub` is the installation id, plus a `user_id` claim. This is
  the only credential an extension ever holds.

Both are sent as `Authorization: Bearer <credential>`.

The API service signs installation tokens and the ingestion service verifies
them, so **both must share the same `JWT_SECRET`**.

---

## API service (`:8081`)

### `POST /v1/enrollment-codes`

Issues a short-lived, single-use enrollment code. Operator endpoint.

**Auth:** admin API key.

```http
POST /v1/enrollment-codes
Authorization: Bearer <ADMIN_API_KEY>
Content-Type: application/json

{ "email": "developer@example.com" }
```

```json
{
  "enrollment_code": "kJ8xN2pQ...",
  "user_id": "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
  "expires_at": "2026-08-29T17:15:00.000Z"
}
```

The code is shown **once** and stored only as a SHA-256 hash. A database
compromise yields no usable codes. Default TTL is 15 minutes
(`ENROLLMENT_CODE_TTL_SECONDS`).

| Status | Meaning |
| --- | --- |
| `201` | Code issued |
| `401` | Missing or wrong admin key |

---

### `POST /v1/installations/register`

Exchanges an enrollment code for durable installation credentials. Called by
the extension; **unauthenticated** — the enrollment code *is* the credential.

```http
POST /v1/installations/register
Content-Type: application/json

{
  "enrollment_code": "kJ8xN2pQ...",
  "ide_name": "vscode",
  "ide_version": "1.90.0",
  "extension_version": "0.1.0",
  "machine_id": "a1b2c3...",
  "platform": "darwin"
}
```

```json
{
  "installation_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "installation_token": "eyJhbGciOiJIUzI1NiIs...",
  "user_id": "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
  "expires_in": 31536000
}
```

The token is returned **once**; only its hash is persisted. The extension
stores it in the OS keychain (VS Code `SecretStorage`, JetBrains
`PasswordSafe`).

| Status | Meaning |
| --- | --- |
| `201` | Registered |
| `400` | `ide_name` missing |
| `401` | Code invalid, expired, or already used |

Codes are single-use: redemption is an atomic `UPDATE ... WHERE consumed_at IS
NULL`, so two concurrent redemptions cannot both succeed.

**Development only:** with `ALLOW_OPEN_ENROLLMENT=true`, `enrollment_code` may
be omitted and a user is created on the fly. The service forces this to `false`
when `NODE_ENV=production`.

---

### `POST /v1/installations/:id/revoke`

Revokes an installation. Operator endpoint.

**Auth:** admin API key.

| Status | Meaning |
| --- | --- |
| `200` | Revoked |
| `401` | Missing or wrong admin key |
| `404` | Unknown, or already revoked |

---

### `GET /v1/events`

Queries persisted events. Intended for verification and debugging; dashboards
should read Supabase directly through RLS.

**Auth:** admin API key.

Query parameters: `user_id`, `installation_id`, `session_id`, `event_type`,
`since` (ISO-8601), `limit` (default 50, max 500).

```http
GET /v1/events?event_type=file.saved&limit=10
Authorization: Bearer <ADMIN_API_KEY>
```

```json
{ "count": 10, "events": [ /* ... */ ] }
```

---

## Ingestion service (`:8080`)

### `POST /v1/events`

Accepts a batch of events. This is the only endpoint extensions call.

**Auth:** installation token.

```http
POST /v1/events
Authorization: Bearer <installation_token>
Content-Type: application/json

{
  "installation_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "events": [ /* IDEEvent objects, max MAX_BATCH_EVENTS (default 1000) */ ]
}
```

```json
{
  "accepted": ["550e8400-e29b-41d4-a716-446655440000"],
  "rejected": []
}
```

| Status | Meaning | Client action |
| --- | --- | --- |
| `202` | Batch produced to Kafka | Drop `accepted` and `rejected` from the queue |
| `200` | Empty batch | — |
| `401` | Token missing, malformed, or invalid | Re-register |
| `403` | `installation_id` does not match the token | Bug or spoofing; do not retry |
| `413` | Batch too large | Split it |
| `422` | Every event was invalid | Drop them; retrying will not help |
| `503` | Kafka unavailable | **Keep buffered and retry with backoff** |

**Partial success is normal.** A batch containing both valid and invalid events
returns `202` with the invalid ones listed under `rejected`. Both lists are
settled — the client removes all of them from its queue. Only a `503` (or a
network failure) means "retry this".

**Identity is server-authoritative.** `user_id` and `installation_id` on each
event are overwritten with the token's claims. A compromised extension cannot
attribute events to another user.

**Redaction runs here too**, even though the SDK already redacted client-side.
This is the trust boundary: an older or tampered client cannot get a secret
into Kafka.

---

## Operational endpoints

Exposed by all three services.

### `GET /health` — liveness

Always `200` while the process is up. **Deliberately independent of
downstreams**: a Kafka or database outage must not cause an orchestrator to
kill an otherwise-healthy pod.

### `GET /ready` — readiness

`200` when this instance can serve traffic, `503` otherwise.

| Service | Ready when |
| --- | --- |
| API | Database reachable |
| Ingestion | Kafka producer connected |
| Consumer | Database reachable, Kafka connected, consumer loop running |

### `GET /metrics` — Prometheus text format

Ingestion:

```
ingestion_events_received_total
ingestion_events_accepted_total
ingestion_events_rejected_total
ingestion_batches_failed_total
ingestion_produce_duration_ms
ingestion_request_duration_ms
```

Consumer:

```
consumer_events_received_total
consumer_events_persisted_total
consumer_events_duplicate_total     # idempotency hits - expected, not an error
consumer_events_failed_total
consumer_events_by_type_total{event_type,ide_name}
consumer_batches_processed_total
consumer_batches_retried_total
consumer_lag_messages{topic,partition}
consumer_batch_duration_ms
consumer_db_write_duration_ms
```

API:

```
api_installations_registered_total{ide_name}
api_registration_failures_total{reason}
api_installations_revoked_total
```

A non-zero `consumer_events_duplicate_total` is healthy — it means idempotency
is doing its job. Watch `consumer_events_failed_total` and
`consumer_lag_messages` instead.

---

## Extension public API (VS Code)

The extension exports an object other extensions can use to contribute AI
events, which then flow through the same redaction and delivery path:

```ts
const collector = vscode.extensions
  .getExtension("Tarfase.tarfase")
  ?.exports;

collector?.ai.reportPrompt({ provider: "copilot", model: "gpt-5", prompt_tokens: 120 });
collector?.ai.reportResponse({ completion_tokens: 340, latency_ms: 1200 });
collector?.ai.codeGenerated({ lines_generated: 24, accepted: true });

collector?.getMetrics();  // queue size, sent/dropped counts, last error
```

See `extensions/vscode/src/collectors/ai.ts` for the full reporter surface.

Prompt and response text can also be reported with the `text` property, but is
removed unless the user explicitly enables `telemetry.capture.aiContent`. AI
metadata remains available when `telemetry.capture.ai` is enabled. The
collector cannot observe private conversations belonging to Copilot, Claude,
Cursor, or another extension; those providers must call this reporter API.
