-- =============================================================================
-- Views over code.symbols_changed events.
--
-- The event stores its symbols as a JSONB array, which is right for ingestion
-- (one row per save, no fan-out in the hot path) and awkward for analysis.
-- These unnest it, so a symbol change is a row you can group and join like any
-- other - the shape a Memory Graph of a codebase actually wants.
--
-- Views rather than tables: no second copy of the data to keep in step, and
-- the GIN index on raw_events.payload already serves the filter.
-- =============================================================================

-- One row per symbol touched by a save.
CREATE OR REPLACE VIEW symbol_changes AS
SELECT
    e.event_id,
    e.user_id,
    e.installation_id,
    e.session_id,
    e.project_name,
    e.repository_name,
    e.branch,
    e.file_path,
    e.language,
    e."timestamp",
    s->>'qualified_name'                AS qualified_name,
    s->>'name'                          AS symbol_name,
    s->>'kind'                          AS symbol_kind,
    (s->>'lines_added')::INT            AS lines_added,
    (s->>'lines_removed')::INT          AS lines_removed,
    (s->>'edit_count')::INT             AS edit_count,
    (s->>'signature_changed')::BOOLEAN  AS signature_changed
FROM raw_events e
CROSS JOIN LATERAL jsonb_array_elements(e.payload -> 'symbols_changed') AS s
WHERE e.event_type = 'code.symbols_changed'
  -- A malformed or truncated payload must not fail the whole view.
  AND jsonb_typeof(e.payload -> 'symbols_changed') = 'array';

COMMENT ON VIEW symbol_changes IS
  'One row per function/class/variable touched by a save. Structure only: no source code is stored anywhere in this database.';

-- Per-save totals, including how much of the file did NOT change.
CREATE OR REPLACE VIEW file_change_summary AS
SELECT
    event_id,
    user_id,
    installation_id,
    project_name,
    branch,
    file_path,
    language,
    "timestamp",
    (payload->>'lines_added')::INT              AS lines_added,
    (payload->>'lines_removed')::INT            AS lines_removed,
    (payload->>'lines_unchanged')::INT          AS lines_unchanged,
    (payload->>'hunk_count')::INT               AS hunk_count,
    (payload->>'symbols_changed_count')::INT    AS symbols_changed,
    (payload->>'symbols_unchanged_count')::INT  AS symbols_unchanged,
    (payload->>'symbols_total')::INT            AS symbols_total,
    payload->>'symbols_status'                  AS symbols_status,
    (payload->>'approximate')::BOOLEAN          AS approximate
FROM raw_events
WHERE event_type = 'code.symbols_changed';

COMMENT ON VIEW file_change_summary IS
  'Per-save line and symbol totals, including the unchanged counts.';

-- Churn hot spots: the symbols edited most often, and by how many people.
CREATE OR REPLACE VIEW symbol_hotspots AS
SELECT
    project_name,
    file_path,
    qualified_name,
    symbol_kind,
    COUNT(*)                                   AS change_count,
    COUNT(DISTINCT user_id)                    AS distinct_editors,
    SUM(lines_added)                           AS total_lines_added,
    SUM(lines_removed)                         AS total_lines_removed,
    COUNT(*) FILTER (WHERE signature_changed)  AS signature_changes,
    MIN("timestamp")                           AS first_changed_at,
    MAX("timestamp")                           AS last_changed_at
FROM symbol_changes
GROUP BY project_name, file_path, qualified_name, symbol_kind;

COMMENT ON VIEW symbol_hotspots IS
  'Symbols ranked by how often they change. A high change_count with several distinct_editors is the classic contested-code signal.';
