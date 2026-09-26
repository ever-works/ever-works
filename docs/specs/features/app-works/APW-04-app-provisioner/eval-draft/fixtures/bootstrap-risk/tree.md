# Fixture — `bootstrap-risk` (bootstrap endpoint + swallowed migration)

> DRAFT — the tree APW-13 creates as a fixture repository (plan §11.4). Expectation:
> `expectations.json#/cases/bootstrap-risk`.

```
bootstrap-risk/
├── compose.yaml
├── docker-entrypoint.sh   # runs migrations, logs the failure and execs the server anyway
├── .env.example           # DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD
├── package.json
└── src/
    ├── index.js
    └── routes/
        └── setup.js       # POST /setup creates the first admin, refuses nobody while users = 0
```

`docker-entrypoint.sh` (the swallowed migration):

```sh
#!/bin/sh
set -e
node scripts/migrate.js || echo "migration failed, continuing"
exec node src/index.js
```

## What matters here

- The migration **must not** stay in the start path: `scripts/migrate.js` becomes a `pre-deploy` job whose exit code is
  checked, and the risk is recorded with `docker-entrypoint.sh` as its file.
- `POST /setup` creates the first administrator and is unauthenticated while no user exists, so it becomes a
  `first-deploy` job that runs **before** any public route is published, with a smoke test proving a second attempt is
  refused.
- `ADMIN_PASSWORD` is a secret → `generate`; `ADMIN_EMAIL` is not a secret but only the user knows it → `prompt`
  (required), so boot is **blocked** until it is set — and the question names the variable, never a value.
- `DATABASE_URL` → `from`, with **postgres** inferred from `compose.yaml`.
