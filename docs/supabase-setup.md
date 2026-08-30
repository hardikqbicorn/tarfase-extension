# Supabase Setup

Target topology: **Kafka in Docker, events persisted to Supabase.**

```
VS Code → Extension → Ingestion (Docker) → Kafka (Docker) → Consumer (Docker) → Supabase
```

---

## The one thing that will bite you first

**Supabase's direct connection host is IPv6-only.**

```
$ getent ahostsv4 db.<project-ref>.supabase.co     # nothing
$ getent ahostsv6 db.<project-ref>.supabase.co     # 2406:da1c:...
```

Unless you have Supabase's IPv4 add-on, `db.<ref>.supabase.co` has no A record.
Docker containers have no IPv6 by default, so the consumer and API cannot reach
it — even though `psql` works fine from your host shell. That gap is what makes
this confusing: the connection string you tested by hand is not the one that
works from a container.

**Use the Session pooler instead.** It is IPv4 and is the correct target here.

| | Direct | Session pooler | Transaction pooler |
| --- | --- | --- | --- |
| Host | `db.<ref>.supabase.co` | `aws-0-<region>.pooler.supabase.com` | same |
| Port | 5432 | **5432** | 6543 |
| User | `postgres` | **`postgres.<ref>`** | `postgres.<ref>` |
| IPv4 | ✗ (add-on only) | ✓ | ✓ |
| Use for this project | no | **yes** | no |

Session pooler, not transaction pooler: the consumer holds a long-lived pool
and issues multi-statement transactions, which is what session mode preserves.

---

## Setup

### 1. Get the connection string

Supabase dashboard → **Project Settings → Database → Connection string →
Session pooler**. It looks like:

```
postgresql://postgres.abcdefghijklmnop:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
```

Percent-encode special characters in the password: `@` → `%40`, `#` → `%23`,
`/` → `%2F`, `:` → `%3A`. An un-encoded `@` will make the driver misparse the
host, producing a confusing "host not found" rather than an auth error.

### 2. Configure

```bash
cp .env.example .env
```

Set `DATABASE_URL` to the pooler string. Also set real values for `JWT_SECRET`
and `ADMIN_API_KEY`:

```bash
openssl rand -base64 48   # JWT_SECRET
openssl rand -hex 32      # ADMIN_API_KEY
```

### 3. Apply the schema

```bash
npm install
npm run migrate
```

Supabase cannot use Docker's `docker-entrypoint-initdb.d`, so migrations are
applied by this runner. It records what it applied in `schema_migrations`, so
re-running is safe, and it refuses to proceed if a previously-applied migration
has been edited.

Preview without writing:

```bash
npm run migrate -- --dry-run
```

### 4. Verify before starting anything

```bash
npm run check:db
```

This is the fast way to find a problem. It checks DNS (and warns specifically
about the IPv6-only case), TLS, the schema, and then performs a real
insert → duplicate-insert → read-back → delete cycle against `raw_events` —
proving RLS is not blocking the writer, partition routing works, and the
idempotency constraint is present.

Expected output:

```
Schema
  ✓ all 8 expected tables present
  ✓ ensure_raw_events_partition() present
  ✓ raw_events partitions: raw_events_2026_08, ...

Write path (as the consumer would)
  ✓ insert succeeded (RLS is not blocking the writer)
  ✓ duplicate insert was a no-op (idempotency constraint works)
  ✓ read back from partition raw_events_2026_08
```

### 5. Start Kafka and the services

```bash
docker compose up --build
```

Local Postgres is behind a profile and will **not** start. Only Kafka, Kafka
UI, and the three services come up, all pointed at Supabase.

```bash
curl localhost:8080/health   # ingestion
curl localhost:8081/health   # api
curl localhost:8082/ready    # consumer: reports kafka + database status
```

`/ready` on the consumer is the one to watch — it returns 503 until both the
database and Kafka are connected.

### 6. See events land

```sql
-- Supabase SQL editor
select event_type, ide_name, file_path, "timestamp"
from raw_events
order by "timestamp" desc
limit 20;
```

---

## Notes specific to Supabase

**RLS and the writer.** Migration `0002` enables row-level security on every
table. The consumer connects as `postgres`, which owns the tables — and in
PostgreSQL a table owner bypasses RLS unless `FORCE ROW LEVEL SECURITY` is set
(it is not). So writes succeed while dashboard/PostgREST reads remain policy-
constrained. `npm run check:db` proves this rather than assuming it.

**TLS.** Resolved from the connection target, not `NODE_ENV`: remote hosts get
verified TLS automatically. If verification fails, prefer setting
`DATABASE_CA_CERT` (Project Settings → Database → SSL configuration) over
`DATABASE_SSL=require`, which encrypts without verifying.

**Connection limits.** The pooler multiplexes, but `DATABASE_POOL_SIZE`
(default 10) applies per service — the API and consumer each open their own
pool. On a free-tier project, lower it if you see pooler connection errors.

**Partitions.** `raw_events` is partitioned by month and the consumer creates
partitions lazily, so no maintenance is needed to start. For production,
schedule `select ensure_raw_events_partition((current_date + interval '1
month')::date);` via `pg_cron` so next month's partition exists ahead of time.

**Table names.** The schema creates `public.users`, which is distinct from
Supabase's `auth.users`. If you want them linked, add a foreign key from
`public.users.id` to `auth.users.id` in a new migration.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `ENOTFOUND` / `ENETUNREACH` from containers, works in your shell | IPv6-only direct host | Switch to the Session pooler |
| `password authentication failed` | Wrong password, or plain `postgres` user with the pooler | Pooler user is `postgres.<ref>`; percent-encode the password |
| `ECONNREFUSED` | Wrong port, or project paused | 5432 for direct/session, 6543 for transaction |
| `self signed certificate` / `unable to verify` | CA not in the system bundle | Set `DATABASE_CA_CERT`, or `DATABASE_SSL=require` as a fallback |
| `relation "raw_events" does not exist` | Migrations not applied | `npm run migrate` |
| Consumer `/ready` returns 503 | Kafka or database not connected | Check the body — it names which |
| `new row violates row-level security policy` | Connected as a non-owner without BYPASSRLS | Connect as `postgres` or the service role |

Run `npm run check:db` first for any database problem — it names the remedy
directly instead of surfacing a raw driver error.
