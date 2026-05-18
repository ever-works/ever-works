#!/bin/sh
set -e

echo "==> Starting Ever Works API..."

# Migrations:
#
# The TypeORM DataSource in the agent's `database.config.ts` is configured
# with `migrationsRun: true` (gated on RUN_MIGRATIONS env, default `true`
# outside `NODE_ENV=test`). So the API self-applies pending migrations on
# every startup — no out-of-process step needed in the common case.
#
# This entrypoint still honours `RUN_MIGRATIONS` as a kill switch for
# diagnostic pods (`RUN_MIGRATIONS=false ...`) but does NOT run a separate
# `runMigrations()` call. Two reasons to keep the API as the sole runner:
#   1. Single code path means dev (pnpm dev:api), CI, Docker, and k8s all
#      apply migrations the same way.
#   2. If migrations fail, the API crashes loudly with the same exit
#      semantics on every platform; k8s will keep the prior pod serving
#      via `maxUnavailable: 0`.
#
# If you ever need to run migrations WITHOUT starting the API (e.g. for a
# one-shot k8s Job in a more cautious rollout), shell into a checkout of
# the repo and run `pnpm typeorm migration:run -d typeorm.config.ts` from
# `apps/api/`. There is intentionally NO pre-baked migration-only CLI in
# the production image — keeping the same code path (TypeORM via the API)
# for every environment avoids drift.

echo "==> Starting API server (migrations run in-process via TypeORM migrationsRun)..."
exec node /app/dist/main
