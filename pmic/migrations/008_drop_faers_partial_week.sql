-- 008: the market FAERS week of 2026-06-29 was stored on 2026-10-04 15:01Z, a few hours before the adapter
-- learned to stop at the last complete week (477900a, 18:40Z). openFDA's data ends Tuesday 2026-06-30, so
-- that week holds 2 days (13,030 vs ~26,000) and read as a 50% drop. Nothing later removed it. This drops
-- the row with its score, derived values and revisions (owner option 1, 2026-10-20), and touches the last
-- complete week so the next push resends it and the hub rescores the series. Runs on the Pi and the hub.
DELETE FROM observation_revisions WHERE observation_id IN (
  SELECT id FROM observations WHERE series_id = 'openfda:adverse_event_reports_weekly' AND observation_time = '2026-06-29'
    AND fetch_time < '2026-10-04T18:40:14Z');
DELETE FROM scores WHERE series_id = 'openfda:adverse_event_reports_weekly' AND as_of = '2026-06-29'
  AND EXISTS (SELECT 1 FROM observations WHERE series_id = 'openfda:adverse_event_reports_weekly' AND observation_time = '2026-06-29'
    AND fetch_time < '2026-10-04T18:40:14Z');
DELETE FROM derived_metrics WHERE series_id = 'openfda:adverse_event_reports_weekly' AND as_of = '2026-06-29'
  AND EXISTS (SELECT 1 FROM observations WHERE series_id = 'openfda:adverse_event_reports_weekly' AND observation_time = '2026-06-29'
    AND fetch_time < '2026-10-04T18:40:14Z');
DELETE FROM observations WHERE series_id = 'openfda:adverse_event_reports_weekly' AND observation_time = '2026-06-29'
  AND fetch_time < '2026-10-04T18:40:14Z';
UPDATE observations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE series_id = 'openfda:adverse_event_reports_weekly'
    AND observation_time = (SELECT MAX(observation_time) FROM observations WHERE series_id = 'openfda:adverse_event_reports_weekly');
