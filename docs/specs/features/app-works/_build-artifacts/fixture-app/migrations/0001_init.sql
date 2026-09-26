-- 0001_init.sql — the application's own table.
--
-- Small on purpose: the point of this migration is that it is *the first one*, so `GET /readyz` can be
-- 503 before it and 200 after it, and `GET /state.migrations` can list it. `variant/bad-migration`
-- breaks 0002 instead of this file, so the first migration still applies and the failure is visible as
-- "one of three applied" rather than "nothing works".

CREATE TABLE IF NOT EXISTS app_info (
	id         text        PRIMARY KEY,
	created_at timestamptz NOT NULL DEFAULT now(),
	note       text
);

INSERT INTO app_info (id, note)
VALUES ('app-fixture-hello', 'Acceptance fixture for Ever Works App Works (APW-13)')
ON CONFLICT (id) DO NOTHING;
