# Fixture — `compose` (detection step 2)

> DRAFT — the tree APW-13 creates as a fixture repository (plan §11.4). Expectation: `expectations.json#/cases/compose`.

```
compose/
├── compose.yaml           # web + postgres + redis; web has the published port and depends_on both
├── .env.example           # DATABASE_URL, REDIS_URL, PORT
├── package.json           # pg + ioredis
└── src/
    └── index.js
```

`compose.yaml` (the part that decides the case):

```yaml
services:
    web:
        build: .
        ports: ['3000:3000']
        environment:
            DATABASE_URL: postgres://app:app@db:5432/app
            REDIS_URL: redis://cache:6379
        depends_on: [db, cache]
    db:
        image: postgres:16
    cache:
        image: redis:7
```

## What matters here

- Detection stops at step 2 with `detectionSource: compose`, citing `compose.yaml`.
- `web` is the entry point (it publishes a port and the others do not); the dependency set is **postgres** and **redis**,
  each citing `compose.yaml`.
- `DATABASE_URL` and `REDIS_URL` are derived (`from`) — the platform owns the containers — and are secrets because they
  carry credentials. `PORT` has a default and is not required.
- The migration command in `package.json` (`scripts.migrate`) becomes a `pre-deploy` job, never a start-script step.
