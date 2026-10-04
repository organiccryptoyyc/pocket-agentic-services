-- 004: FAERS weeks the FDA had not loaded yet were stored as 0 reports (a real week is never 0),
-- which read as "calm" in the drug-market score. The adapter now stops at the last complete week
-- with reports; this removes the zero weeks already stored, with their scores and derived values.
-- Runs on the Pi and on the hub alike. Later pushes bring the real counts once the FDA loads them.
DELETE FROM observation_revisions WHERE observation_id IN (
  SELECT id FROM observations WHERE source_id = 'openfda' AND metric_name = 'adverse_event_reports_weekly' AND metric_value = 0);
DELETE FROM scores WHERE (series_id, as_of) IN (
  SELECT series_id, observation_time FROM observations WHERE source_id = 'openfda' AND metric_name = 'adverse_event_reports_weekly' AND metric_value = 0);
DELETE FROM derived_metrics WHERE (series_id, as_of) IN (
  SELECT series_id, observation_time FROM observations WHERE source_id = 'openfda' AND metric_name = 'adverse_event_reports_weekly' AND metric_value = 0);
DELETE FROM observations WHERE source_id = 'openfda' AND metric_name = 'adverse_event_reports_weekly' AND metric_value = 0;
