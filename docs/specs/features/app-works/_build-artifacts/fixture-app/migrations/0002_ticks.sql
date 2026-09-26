-- 0002_ticks.sql — the two counters `GET /state` reports.
--
--   cron_ticks       incremented by POST /cron/tick (the CronJob of .works/works.yml, every 2 minutes)
--   worker_heartbeat written by src/worker.mjs every 10 seconds
--
-- `variant/bad-migration` replaces this file with one that has a syntax error, which makes the
-- `migrate` pre-deploy job exit non-zero so the rollout never starts (ACC-13-08).

CREATE TABLE IF NOT EXISTS cron_ticks (
	name         text        PRIMARY KEY,
	ticks        integer     NOT NULL DEFAULT 0,
	last_tick_at timestamptz
);

INSERT INTO cron_ticks (name, ticks)
VALUES ('tick', 0)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS worker_heartbeat (
	name       text        PRIMARY KEY,
	beat_at    timestamptz NOT NULL,
	beat_count integer     NOT NULL DEFAULT 0
);
