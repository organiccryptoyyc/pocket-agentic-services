-- 002: pmic-ingest/1.0 flagged outliers across the whole historical backfill (first live run,
-- 2026-10-04). Outlier checks now apply only to new observations (lib/qc.js). Clear the flag
-- and resolve the alerts for anything older than 120 days; recent flags stay.
UPDATE observations
SET qc_flags = (SELECT json_group_array(value) FROM json_each(observations.qc_flags) WHERE value <> 'outlier'),
    confidence_score = MIN(100, confidence_score + 25)
WHERE qc_flags LIKE '%"outlier"%' AND observation_time < date('now', '-120 days');

UPDATE alerts SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE kind = 'outlier' AND resolved_at IS NULL AND substr(detail, 1, 10) < date('now', '-120 days');
