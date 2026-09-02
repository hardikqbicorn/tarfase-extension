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
