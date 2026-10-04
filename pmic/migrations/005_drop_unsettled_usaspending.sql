-- 005: USAspending months that agencies were still reporting were stored at a fraction of their
-- final value (September 2026: $129B against about $300B), which read as "slowing" spending. The
-- adapter now waits 45 days after a month ends (100 for Defense); this removes the months stored
-- before that, with their scores and derived values. Runs on the Pi and on the hub alike; the
-- months come back once they settle.
DELETE FROM observation_revisions WHERE observation_id IN (
  SELECT id FROM observations WHERE source_id = 'usaspending' AND date(observation_time, '+1 month', '+44 days') > date('now'));
DELETE FROM scores WHERE (series_id, as_of) IN (
  SELECT series_id, observation_time FROM observations WHERE source_id = 'usaspending' AND date(observation_time, '+1 month', '+44 days') > date('now'));
DELETE FROM derived_metrics WHERE (series_id, as_of) IN (
  SELECT series_id, observation_time FROM observations WHERE source_id = 'usaspending' AND date(observation_time, '+1 month', '+44 days') > date('now'));
DELETE FROM observations WHERE source_id = 'usaspending' AND date(observation_time, '+1 month', '+44 days') > date('now');
DELETE FROM observation_revisions WHERE observation_id IN (
  SELECT id FROM observations WHERE series_id = 'usaspending:obligations_dod_monthly' AND date(observation_time, '+1 month', '+99 days') > date('now'));
DELETE FROM scores WHERE (series_id, as_of) IN (
  SELECT series_id, observation_time FROM observations WHERE series_id = 'usaspending:obligations_dod_monthly' AND date(observation_time, '+1 month', '+99 days') > date('now'));
DELETE FROM derived_metrics WHERE (series_id, as_of) IN (
  SELECT series_id, observation_time FROM observations WHERE series_id = 'usaspending:obligations_dod_monthly' AND date(observation_time, '+1 month', '+99 days') > date('now'));
DELETE FROM observations WHERE series_id = 'usaspending:obligations_dod_monthly' AND date(observation_time, '+1 month', '+99 days') > date('now');
