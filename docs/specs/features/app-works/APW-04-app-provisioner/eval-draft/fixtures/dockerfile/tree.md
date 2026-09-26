# Fixture — `dockerfile` (detection step 3)

> DRAFT — the tree APW-13 creates as a fixture repository (plan §11.4). Expectation: `expectations.json#/cases/dockerfile`.

```
dockerfile/
├── Dockerfile             # multi-stage Next.js build; EXPOSE 3000; CMD ["node", "server.js"]
├── package.json           # next, pg; scripts: build, start, migrate
├── .env.example           # DATABASE_URL, SESSION_SECRET, NEXT_PUBLIC_APP_URL
├── scripts/
│   └── migrate.js
└── src/
    └── app/
        ├── api/health/route.ts        # readiness: touches the database
        └── api/health/live/route.ts   # liveness: no database access
```

## What matters here

- Detection stops at step 3 with `detectionSource: dockerfile`; **no** overlay Dockerfile is written, because the
  repository already builds.
- `NEXT_PUBLIC_APP_URL` is a framework public-prefix variable: **build-time**, derived from the app's own domain.
- `SESSION_SECRET` is a secret with no shape constraint → `generate`; `DATABASE_URL` is a secret → `from` (postgres is
  inferred from the `pg` client in `package.json`).
- `scripts/migrate.js` becomes a `pre-deploy` job whose exit code is checked.
- The two health routes are split correctly: readiness (`/api/health`) may touch the database, liveness
  (`/api/health/live`) never does — this case is what ACC-04-15 checks.
