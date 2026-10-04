-- 003: outlier flags raised before the new-data-only rule (lib/qc.js, deployed 2026-10-04) were
-- produced by the old backfill check, including recent quarters. Clear every flag and alert from
-- that run; the current rule re-flags anything genuinely anomalous as new data arrives.
UPDATE observations
SET qc_flags = (SELECT json_group_array(value) FROM json_each(observations.qc_flags) WHERE value <> 'outlier'),
    confidence_score = MIN(100, confidence_score + 25)
WHERE qc_flags LIKE '%"outlier"%' AND fetch_time < '2026-10-04T15:16:00Z';

UPDATE alerts SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE kind = 'outlier' AND resolved_at IS NULL AND first_seen < '2026-10-04T15:16:00Z';
