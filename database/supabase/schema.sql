-- =============================================================================
-- Consolidated schema for the Universal IDE Event Collection Platform.
--
-- This file is the concatenation of database/supabase/migrations/*.sql in
-- order, provided for convenience (fresh local databases, docs, and schema
-- diffing). Migrations remain the source of truth - apply those in order for
-- an existing database.
-- =============================================================================

-- >>> database/supabase/migrations/0001_initial_schema.sql
-- =============================================================================
-- Universal IDE Event Collection Platform - initial schema
--
-- Design notes:
--   * raw_events is RANGE-partitioned by month on `timestamp`. At the target
--     scale (millions -> billions of rows) this keeps index size bounded,
--     makes retention a DETACH+DROP instead of a mass DELETE, and lets the
--     planner prune whole months for time-bounded analytics queries.
--   * Idempotency is enforced by a UNIQUE constraint on (event_id, timestamp).
--     The partition key must participate in the unique index on a partitioned
--     table, hence the composite. The consumer upserts on this constraint, so
--     redelivery from Kafka is a no-op rather than a duplicate row.
--   * Payloads are JSONB so new event types need no migration.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id     TEXT UNIQUE,
    email           TEXT UNIQUE,
    display_name    TEXT,
    -- Global telemetry opt-out. Honored by the consumer as a hard gate: when
    -- false, incoming events for this user are discarded, not persisted.
    telemetry_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- installations: one row per (user, IDE, machine) extension install
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS installations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ide_name        TEXT NOT NULL,
    ide_version     TEXT,
    extension_version TEXT,
    machine_id      TEXT,
    platform        TEXT,
    -- Argon2/bcrypt-style hash of the installation token. The plaintext token
    -- is returned to the extension once at registration and never stored.
    token_hash      TEXT NOT NULL,
    token_issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at      TIMESTAMPTZ,
    last_seen_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_installations_user_id ON installations(user_id);
CREATE INDEX IF NOT EXISTS idx_installations_ide_name ON installations(ide_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_installations_token_hash ON installations(token_hash);

-- -----------------------------------------------------------------------------
-- enrollment_codes: short-lived codes exchanged for installation credentials
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS enrollment_codes (
    code_hash       TEXT PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at      TIMESTAMPTZ NOT NULL,
    consumed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_enrollment_codes_user_id ON enrollment_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_enrollment_codes_expires_at ON enrollment_codes(expires_at);

-- -----------------------------------------------------------------------------
-- projects / repositories / ide_sessions: dimensions referenced by events
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    -- Stable identifier produced by the extension (hash of workspace root).
    external_id     TEXT NOT NULL,
    name            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, external_id)
);

CREATE TABLE IF NOT EXISTS repositories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    external_id     TEXT NOT NULL,
    name            TEXT,
    default_branch  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, external_id)
);

CREATE TABLE IF NOT EXISTS ide_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- session_id as generated by the extension (opaque string).
    external_id     TEXT NOT NULL UNIQUE,
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    installation_id UUID REFERENCES installations(id) ON DELETE CASCADE,
    ide_name        TEXT,
    ide_version     TEXT,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at        TIMESTAMPTZ,
    event_count     BIGINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ide_sessions_user_id ON ide_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_ide_sessions_installation_id ON ide_sessions(installation_id);
CREATE INDEX IF NOT EXISTS idx_ide_sessions_started_at ON ide_sessions(started_at DESC);

-- -----------------------------------------------------------------------------
-- raw_events: the primary fact table, partitioned by month
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw_events (
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    event_id        UUID NOT NULL,
    user_id         TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    session_id      TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    ide_name        TEXT NOT NULL,
    ide_version     TEXT,
    "timestamp"     TIMESTAMPTZ NOT NULL,
    workspace_id    TEXT,
    workspace_name  TEXT,
    project_id      TEXT,
    project_name    TEXT,
    repository_id   TEXT,
    repository_name TEXT,
    branch          TEXT,
    file_path       TEXT,
    language        TEXT,
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    metadata        JSONB,
    schema_version  TEXT NOT NULL,
    ingested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, "timestamp"),
    -- Deduplication key: the consumer's ON CONFLICT target.
    CONSTRAINT raw_events_event_id_timestamp_key UNIQUE (event_id, "timestamp")
) PARTITION BY RANGE ("timestamp");

CREATE INDEX IF NOT EXISTS idx_raw_events_user_id ON raw_events(user_id);
CREATE INDEX IF NOT EXISTS idx_raw_events_installation_id ON raw_events(installation_id);
CREATE INDEX IF NOT EXISTS idx_raw_events_session_id ON raw_events(session_id);
CREATE INDEX IF NOT EXISTS idx_raw_events_event_type ON raw_events(event_type);
CREATE INDEX IF NOT EXISTS idx_raw_events_timestamp ON raw_events("timestamp" DESC);
CREATE INDEX IF NOT EXISTS idx_raw_events_project_id ON raw_events(project_id);
CREATE INDEX IF NOT EXISTS idx_raw_events_repository_id ON raw_events(repository_id);
-- Common analytics access path: "this user's events of this type over time".
CREATE INDEX IF NOT EXISTS idx_raw_events_user_type_time
    ON raw_events(user_id, event_type, "timestamp" DESC);
-- GIN index for ad-hoc payload queries.
CREATE INDEX IF NOT EXISTS idx_raw_events_payload ON raw_events USING GIN (payload jsonb_path_ops);

-- Default partition catches anything outside explicitly created ranges so an
-- unexpected clock skew can never fail an insert.
CREATE TABLE IF NOT EXISTS raw_events_default PARTITION OF raw_events DEFAULT;

-- -----------------------------------------------------------------------------
-- event_errors: dead-letter records for events that could not be processed
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_errors (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID,
    installation_id TEXT,
    user_id         TEXT,
    event_type      TEXT,
    error_stage     TEXT NOT NULL,   -- validation | enrichment | persistence
    error_message   TEXT NOT NULL,
    error_details   JSONB,
    raw_payload     JSONB,
    kafka_topic     TEXT,
    kafka_partition INT,
    kafka_offset    BIGINT,
    retry_count     INT NOT NULL DEFAULT 0,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_errors_created_at ON event_errors(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_errors_stage ON event_errors(error_stage);
CREATE INDEX IF NOT EXISTS idx_event_errors_event_id ON event_errors(event_id);

-- -----------------------------------------------------------------------------
-- Partition management
-- -----------------------------------------------------------------------------
-- Creates the monthly partition covering `target` if it does not yet exist.
-- Call from a scheduled job (pg_cron) a month ahead; the consumer also calls
-- it lazily so a fresh deployment never lands in the default partition.
CREATE OR REPLACE FUNCTION ensure_raw_events_partition(target DATE)
RETURNS VOID AS $$
DECLARE
    start_date DATE := date_trunc('month', target)::DATE;
    end_date   DATE := (date_trunc('month', target) + INTERVAL '1 month')::DATE;
    part_name  TEXT := 'raw_events_' || to_char(start_date, 'YYYY_MM');
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF raw_events FOR VALUES FROM (%L) TO (%L)',
            part_name, start_date, end_date
        );
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Seed the current month plus the next two.
SELECT ensure_raw_events_partition(CURRENT_DATE);
SELECT ensure_raw_events_partition((CURRENT_DATE + INTERVAL '1 month')::DATE);
SELECT ensure_raw_events_partition((CURRENT_DATE + INTERVAL '2 months')::DATE);

-- >>> database/supabase/migrations/0002_row_level_security.sql
-- =============================================================================
-- Row Level Security
--
-- The Kafka consumer connects with the service role (which bypasses RLS) and
-- is the only writer. Everything else - dashboards, the Supabase client, any
-- analyst querying through PostgREST - reads through these policies, so a user
-- can only ever see their own events.
-- =============================================================================

ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE installations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects       ENABLE ROW LEVEL SECURITY;
ALTER TABLE repositories   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ide_sessions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_errors   ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollment_codes ENABLE ROW LEVEL SECURITY;

-- Supabase exposes the authenticated user's id via auth.uid(). In a plain
-- Postgres deployment without Supabase Auth, these policies simply deny all
-- non-service-role access, which is the safe default.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uid'
                   AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'auth')) THEN
        RAISE NOTICE 'auth.uid() not present (non-Supabase Postgres); RLS will deny non-service access.';
    END IF;
END $$;

DROP POLICY IF EXISTS users_select_own ON users;
CREATE POLICY users_select_own ON users
    FOR SELECT USING (id::text = COALESCE(current_setting('request.jwt.claim.sub', true), ''));

DROP POLICY IF EXISTS installations_select_own ON installations;
CREATE POLICY installations_select_own ON installations
    FOR SELECT USING (user_id::text = COALESCE(current_setting('request.jwt.claim.sub', true), ''));

DROP POLICY IF EXISTS projects_select_own ON projects;
CREATE POLICY projects_select_own ON projects
    FOR SELECT USING (user_id::text = COALESCE(current_setting('request.jwt.claim.sub', true), ''));

DROP POLICY IF EXISTS repositories_select_own ON repositories;
CREATE POLICY repositories_select_own ON repositories
    FOR SELECT USING (user_id::text = COALESCE(current_setting('request.jwt.claim.sub', true), ''));

DROP POLICY IF EXISTS ide_sessions_select_own ON ide_sessions;
CREATE POLICY ide_sessions_select_own ON ide_sessions
    FOR SELECT USING (user_id::text = COALESCE(current_setting('request.jwt.claim.sub', true), ''));

DROP POLICY IF EXISTS raw_events_select_own ON raw_events;
CREATE POLICY raw_events_select_own ON raw_events
    FOR SELECT USING (user_id = COALESCE(current_setting('request.jwt.claim.sub', true), ''));

-- event_errors and enrollment_codes are operator-only: no policy is defined,
-- so RLS denies every non-service-role read.

-- >>> database/supabase/migrations/0003_analytics_views.sql
-- =============================================================================
-- Convenience views for dashboards and for verifying the MVP end-to-end path.
-- =============================================================================

-- Most recent events across all users (operator view; RLS still applies to the
-- underlying table for non-service roles).
CREATE OR REPLACE VIEW recent_events AS
SELECT
    event_id,
    event_type,
    ide_name,
    user_id,
    session_id,
    project_name,
    branch,
    file_path,
    language,
    "timestamp",
    ingested_at,
    (ingested_at - "timestamp") AS ingestion_lag
FROM raw_events
ORDER BY "timestamp" DESC
LIMIT 500;

-- Per-day event volume by type: the shape most analytics queries start from.
CREATE OR REPLACE VIEW event_counts_daily AS
SELECT
    date_trunc('day', "timestamp") AS day,
    ide_name,
    event_type,
    COUNT(*) AS event_count,
    COUNT(DISTINCT user_id) AS unique_users,
    COUNT(DISTINCT session_id) AS unique_sessions
FROM raw_events
GROUP BY 1, 2, 3;

-- Session activity summary.
CREATE OR REPLACE VIEW session_activity AS
SELECT
    session_id,
    user_id,
    ide_name,
    MIN("timestamp") AS session_start,
    MAX("timestamp") AS session_end,
    MAX("timestamp") - MIN("timestamp") AS duration,
    COUNT(*) AS event_count,
    COUNT(DISTINCT file_path) FILTER (WHERE file_path IS NOT NULL) AS files_touched,
    COUNT(*) FILTER (WHERE event_type LIKE 'ai.%') AS ai_events
FROM raw_events
GROUP BY session_id, user_id, ide_name;

-- Error rate over the last 24h, for the consumer's alerting.
CREATE OR REPLACE VIEW error_summary_recent AS
SELECT
    error_stage,
    COUNT(*) AS error_count,
    MAX(created_at) AS most_recent
FROM event_errors
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY error_stage;

