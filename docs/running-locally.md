# Running Locally

Target topology: **Kafka in Docker, events persisted to Supabase, VS Code
extension running from source.**

```
VS Code (your machine)
   → Ingestion :8080 (Docker) → Kafka (Docker) → Consumer (Docker) → Supabase
   → API :8081 (Docker) for registration
```

## Prerequisites

- Node.js 18+ and npm
- Docker with Compose v2 (`docker compose version`)
- A Supabase project, and its database password

---

## 1. Install and build

```bash
git clone https://github.com/hardikqbicorn/tarfase-extension.git
cd tarfase-extension
npm install
npm run build
```

`npm run build` runs `tsc -b`, which builds the workspace packages in
dependency order. The extension imports `@ide-collector/*` from their compiled
`dist/`, so this step is required before running the extension.

If a build ever behaves oddly (reports success but emits nothing), the
incremental cache is stale — `rm -rf dist` does not remove it, because it sits
beside each `tsconfig.json`:

```bash
npm run clean && npm run build     # or: npm run rebuild
```

---

## 2. Configure

```bash
cp .env.example .env
```

Edit `.env` and set three things:

```bash
# Supabase SESSION POOLER - see the warning below
DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres

JWT_SECRET=<openssl rand -base64 48>
ADMIN_API_KEY=<openssl rand -hex 32>
```

> **Use the Session pooler, not the direct connection.**
>
> `db.<project-ref>.supabase.co` is IPv6-only unless you have Supabase's IPv4
> add-on. Docker containers have no IPv6 by default, so the direct string works
> from your shell and fails from a container. Get the pooler string from
> **Project Settings → Database → Connection string → Session pooler**. Note
> the user becomes `postgres.<project-ref>`, not plain `postgres`.
>
> Percent-encode special characters in the password: `@` → `%40`, `#` → `%23`,
> `/` → `%2F`.

**You will also hit a TLS error on the first connection**
(`self-signed certificate in certificate chain`) — Supabase signs its database
certificates with its own CA. Download it from **Project Settings → Database →
SSL configuration**, save it as `certs/supabase-ca.crt`, and add:

```bash
DATABASE_CA_CERT_FILE=./certs/supabase-ca.crt      # host commands
DATABASE_CA_CERT_FILE=/app/certs/supabase-ca.crt   # Dockerised services
```

Or, to get moving immediately with encryption but no verification:
`DATABASE_SSL=require`.

---

## 3. Create the schema in Supabase

```bash
npm run migrate
```

Applies `database/supabase/migrations/*.sql` in order and records them in
`schema_migrations`, so re-running is safe. Preview first with
`npm run migrate -- --dry-run`.

---

## 4. Verify the database before starting anything

```bash
npm run check:db
```

Run this whenever the database misbehaves — it names the remedy instead of
surfacing a raw driver error. It checks DNS (warning specifically about the
IPv6 case), TLS, the schema, then does a real
insert → duplicate-insert → read-back → delete against `raw_events`:

```
Schema
  ✓ all 8 expected tables present
  ✓ raw_events partitions: raw_events_2026_08, ...

Write path (as the consumer would)
  ✓ insert succeeded (RLS is not blocking the writer)
  ✓ duplicate insert was a no-op (idempotency constraint works)
```

Do not continue until this passes.

---

## 5. Start Kafka and the services

```bash
docker compose up --build
```

Local PostgreSQL is behind a profile and will **not** start — only Kafka,
Kafka UI, and the three services, all pointed at Supabase.

First run pulls images and builds, so give it a few minutes. In another
terminal:

```bash
curl localhost:8080/health    # ingestion  -> {"status":"ok"}
curl localhost:8081/health    # api        -> {"status":"ok"}
curl localhost:8082/ready     # consumer   -> {"status":"ready","database":true,"kafka_connected":true}
```

`/ready` on the consumer is the one that matters — it returns 503 until both
Kafka and Supabase are connected. If it stays 503:

```bash
docker compose logs consumer --tail 50
```

| Service | URL |
| --- | --- |
| Ingestion API | http://localhost:8080 |
| Control-plane API | http://localhost:8081 |
| Consumer metrics | http://localhost:8082/metrics |
| Kafka UI | http://localhost:8090 |

---

## 6. Run the VS Code extension

```bash
code --extensionDevelopmentPath="$(pwd)/extensions/vscode"
```

This opens a second VS Code window ("Extension Development Host") with the
extension loaded. In **that** window:

1. **Enable collection.** Settings (`Cmd/Ctrl+,`) → search `telemetry.enabled`
   → tick it. Collection is opt-in and off by default, so nothing is captured
   until you do this.

2. **Register.** `Cmd/Ctrl+Shift+P` → **"IDE Collector: Register This
   Installation"**. Leave the enrollment code **blank** and press Enter —
   `ALLOW_OPEN_ENROLLMENT=true` in development lets it self-enroll. You should
   see "IDE Event Collector registered".

3. **Generate events.** Open a file, type, save it, run a build task, switch
   git branches.

4. **Check status.** `Cmd/Ctrl+Shift+P` → **"IDE Collector: Show Status"**.
   The output channel reports queue size, events captured, events sent, and
   the last error. Events flush every 5 seconds by default, or force one with
   **"IDE Collector: Flush Queued Events Now"**.

### Using a real enrollment code instead

Open enrollment is a development shortcut. The production flow:

```bash
curl -X POST localhost:8081/v1/enrollment-codes \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com"}'
```

Paste the returned code into the Register prompt. Codes are single-use and
expire in 15 minutes.

---

## 7. Watch events arrive

**In Kafka UI** (http://localhost:8090): Topics → `ide.events.raw` → Messages.

**In Supabase** (SQL editor):

```sql
select event_type, ide_name, file_path, language, "timestamp"
from raw_events
order by "timestamp" desc
limit 20;

-- volume by type
select event_type, count(*)
from raw_events
group by 1
order by 2 desc;

-- anything that failed processing
select error_stage, error_message, created_at
from event_errors
order by created_at desc
limit 20;
```

---

## Running services outside Docker

Useful when iterating on a service — the three run directly with hot reload,
against the Dockerised Kafka:

```bash
docker compose up kafka kafka-init kafka-ui    # brokers only

# each in its own terminal
KAFKA_BROKERS=localhost:9092 npm run dev:producer   # :8080
npm run dev:api                                     # :8081
KAFKA_BROKERS=localhost:9092 npm run dev:consumer   # :8082
```

`KAFKA_BROKERS` differs because `kafka:29092` is the in-network address; from
your host it is `localhost:9092`.

---

## Tests

```bash
npm test              # 218 tests, no database or Kafka needed
npm run test:db       # integration suite against a throwaway local PostgreSQL
npm run typecheck     # tsc -b across the monorepo
```

`npm test` needs no services: the integration suite uses an in-memory broker
and falls back to an in-memory store when `TEST_DATABASE_URL` is unset.

---

## Optional: Python tooling

If you would rather poke at the database from Python, there is a psycopg2
equivalent of `check:db`:

```bash
pip install -r scripts/requirements.txt
python3 scripts/check_db.py
```

Install **psycopg2-binary**, not `psycopg2` — the latter compiles from source
and needs libpq plus build tools, which commonly fails on macOS.

One thing this makes visible: a bare `psycopg2.connect(DATABASE_URL)` succeeds
against Supabase where the Node services report a certificate error. That is
because libpq defaults to `sslmode=prefer` — encrypted, certificate *not*
verified — while this project verifies by default. Same encryption, weaker
guarantee. The script prints the effective `sslmode` so the difference is
visible rather than mysterious.

The backend services are Node and stay Node; this is a diagnostic and ad-hoc
query tool, not a second persistence layer.

## Command reference

| Command | Purpose |
| --- | --- |
| `npm run build` | Build all packages and services |
| `npm run clean` / `npm run rebuild` | Clear the build cache and outputs |
| `npm run migrate` | Apply migrations to `DATABASE_URL` |
| `npm run migrate -- --dry-run` | Preview migrations |
| `npm run check:db` | Diagnose DNS, TLS, schema, write path |
| `python3 scripts/check_db.py` | Same checks via psycopg2 |
| `npm test` | Run all tests |
| `docker compose up --build` | Kafka + services (Supabase for storage) |
| `docker compose --profile local-db up` | Add local PostgreSQL instead |
| `docker compose down` | Stop (add `-v` to wipe Kafka data) |

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Cannot find module '@ide-collector/...'` | Packages not built | `npm run build` |
| Build says nothing to do but `dist/` is empty | Stale incremental cache | `npm run rebuild` |
| Consumer `/ready` 503, `database: false` | Cannot reach Supabase | `npm run check:db` |
| Works in shell, fails in Docker | IPv6-only direct host | Switch to the Session pooler |
| `password authentication failed` | Wrong user or unencoded password | Pooler user is `postgres.<ref>`; encode `@` as `%40` |
| `self-signed certificate in certificate chain` | Supabase's private CA | Set `DATABASE_CA_CERT_FILE`, or `DATABASE_SSL=require` |
| `relation "raw_events" does not exist` | Migrations not applied | `npm run migrate` |
| Extension registers but nothing arrives | Telemetry disabled, or ingestion down | Check "Show Status"; `curl localhost:8080/health` |
| Extension: "not registered" prompt | No stored credential | Run the Register command |
| Kafka container restarts on boot | Stale KRaft volume | `docker compose down -v` |

For any database problem, run `npm run check:db` first.
