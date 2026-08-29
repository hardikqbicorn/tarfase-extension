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
