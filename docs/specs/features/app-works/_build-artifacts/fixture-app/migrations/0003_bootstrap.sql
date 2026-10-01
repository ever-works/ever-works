-- 0003_bootstrap.sql — what the first-deploy job saw.
--
-- `src/bootstrap.mjs` runs before the ingress is published, probes the app through its internal address
-- and through its public address, and records both observations here. `GET /state` returns the newest
-- row as `bootstrap: { ranAt, sawInternalApp, sawPublicApp }`, which is how ACC-13-03 ("the job saw the
-- app through its internal address and not through its public address") is read from outside.
--
-- Every run is kept, not overwritten: a redeploy that suddenly saw the public address is a regression
-- worth being able to see in the history.

CREATE TABLE IF NOT EXISTS bootstrap_checks (
	id               bigserial   PRIMARY KEY,
	ran_at           timestamptz NOT NULL DEFAULT now(),
	internal_url     text,
	public_url       text,
	saw_internal_app boolean     NOT NULL,
	saw_public_app   boolean     NOT NULL,
	marker           text
);

CREATE INDEX IF NOT EXISTS bootstrap_checks_ran_at_idx ON bootstrap_checks (ran_at DESC);
