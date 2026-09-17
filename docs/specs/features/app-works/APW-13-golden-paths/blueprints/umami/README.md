# App Blueprint draft — Umami

**Status:** `Draft` — seed content for the Blueprint repository `ever-works/umami-template` (topic
`ever-works-app-blueprint`). **Owner:** [APW-13](../../spec.md). **Shape:** [CONTRACTS.md §1](../../../CONTRACTS.md).
**Unverified** in the sense of [APW-13 spec §4.5](../../spec.md).

Umami is the **fast** golden path. It proves the runtime half of App Works — App dependency, generated secrets,
first-deploy job before the ingress, probes, smoke tests, domain, App Launcher — on real software in minutes,
because it deploys the upstream's published image and builds nothing.

## What the Blueprint decides

| Concern             | Decision                                                                                                                                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build               | `image`, pinned by digest (tag `3.4.0`).                                                                                                                                                                                                                               |
| Runtime             | One `web` component on port 3000; heartbeat probes; the image's own boot script migrates and stops on failure. The image's user is the **name** `nextjs` (uid 1001), which the platform cannot verify until an App spec can declare the uid — see the unverified list. |
| Database            | A Postgres App dependency with a direct URL for migrations.                                                                                                                                                                                                            |
| Secrets             | `APP_SECRET` and `TWO_FACTOR_ENCRYPTION_KEY` generated once; nothing uses the compose file's placeholder values.                                                                                                                                                       |
| First administrator | The documented default password is replaced by a prompted one before the ingress is published.                                                                                                                                                                         |
| Privacy defaults    | Telemetry and update checks disabled.                                                                                                                                                                                                                                  |
| Evolve loop         | Not rebuilt while the strategy is `image` — see below.                                                                                                                                                                                                                 |

## Facts and where they were read (2026-09-17)

| Fact                                                                                                                                                                                                                               | Source                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Licence MIT; default branch `master`; latest release `v3.4.0` at commit `ec0ff503…`                                                                                                                                                | <https://github.com/umami-software/umami> (repository metadata, releases)                                                                      |
| Image `ghcr.io/umami-software/umami`, tags `3.4.0`/`3.4`/`3`/`latest`/`postgresql-latest` → `sha256:85909afc…`                                                                                                                     | GitHub REST `GET /orgs/umami-software/packages/container/umami/versions` (read with an authenticated client); the digest refers to **ghcr.io** |
| The image is built by the upstream's own CD workflow from the repository's root `Dockerfile`, for `linux/amd64` and `linux/arm64`                                                                                                  | `.github/workflows/cd.yml` at `v3.4.0`                                                                                                         |
| `EXPOSE 3000`, `PORT=3000`, **image user `nextjs` (uid 1001, created by `adduser --system --uid 1001 nextjs` but set by NAME: `USER nextjs`)**, `NEXT_TELEMETRY_DISABLED=1` in two stages, CMD runs `scripts/start-docker.sh`      | <https://github.com/umami-software/umami/blob/master/Dockerfile> (L59-L61, L97)                                                                |
| Boot script uses `set -e`, runs the database check (with migrations), then `exec node server.js`                                                                                                                                   | <https://github.com/umami-software/umami/blob/master/scripts/start-docker.sh>                                                                  |
| Boot also runs `update-tracker.js`, which writes `public/script.js` **only when `COLLECT_API_ENDPOINT` is set**                                                                                                                    | <https://github.com/umami-software/umami/blob/master/scripts/update-tracker.js>                                                                |
| Required `DATABASE_URL`, `APP_SECRET`, `TWO_FACTOR_ENCRYPTION_KEY` (64 hex); heartbeat health check                                                                                                                                | <https://github.com/umami-software/umami/blob/master/docker-compose.yml>                                                                       |
| `TWO_FACTOR_ENCRYPTION_KEY` must match `^[0-9a-fA-F]{64}$` and is used only for two-factor                                                                                                                                         | `src/lib/two-factor/crypto.ts` L4; the Blueprint's lower-case-only pattern is stricter                                                         |
| `APP_SECRET` falls back to a hash of `DATABASE_URL` when unset                                                                                                                                                                     | `src/lib/crypto.ts` L56-L58                                                                                                                    |
| Migrations use `DIRECT_DATABASE_URL` when set; `SKIP_DB_MIGRATION` exists; `SKIP_DB_CHECK` skips the guard                                                                                                                         | <https://github.com/umami-software/umami/blob/master/scripts/check-db.js> (L11, L73-L76)                                                       |
| Postgres floors: upstream documents "A PostgreSQL database version v12.14+" and the boot check refuses below `9.4.0`; the compose file uses `postgres:15-alpine`                                                                   | README L31, `scripts/check-db.js` L8-L9 / L63-L66                                                                                              |
| `/api/heartbeat` returns `{"ok":true}`                                                                                                                                                                                             | <https://github.com/umami-software/umami/blob/master/src/app/api/heartbeat/route.ts>                                                           |
| `/login` is rendered on the server with **no redirect** (`dynamic = 'force-dynamic'`; returns `null` only when `DISABLE_LOGIN` or `CLOUD_MODE` is set, neither of which the Blueprint sets); the logged-in redirect is client-side | `src/app/login/page.tsx`, `src/app/login/LoginPage.tsx`, `docker/proxy.ts`                                                                     |
| `DISABLE_TELEMETRY`, `DISABLE_UPDATES`                                                                                                                                                                                             | `src/app/api/scripts/telemetry/route.ts`, `src/app/api/config/route.ts` in the same repository                                                 |
| The unauthenticated config route (`/api/config`, `skipAuth`) returns `telemetryDisabled` and `updatesDisabled` — what ACC-13-06 reads                                                                                              | `src/app/api/config/route.ts`                                                                                                                  |
| First login `admin` / `umami`; the row is inserted by the first migration                                                                                                                                                          | <https://github.com/umami-software/umami/blob/master/README.md> L72; `prisma/migrations/01_init/migration.sql` L199                            |
| Login returns a `token` (or `requiresTwoFactor` for a two-factor user), answers **401** for a wrong credential; bearer authentication splits the `Authorization` header                                                            | `src/app/api/auth/login/route.ts` L26, `src/lib/response.ts` L20-L30, `src/lib/auth.ts` L26-L29                                                |
| Password change needs the **current** password; the new one must be at least **8** characters (the Blueprint asks for 12); tokens are bound to the password hash, so they stop working after the change                            | `src/app/api/me/password/route.ts` L9-L10                                                                                                      |
| User documentation for environment variables (not re-read for this draft)                                                                                                                                                          | <https://umami.is/docs/environment-variables>                                                                                                  |

## Unverified — resolve on the first verification run

1. Whether the root filesystem can be read-only. **Evidence gathered:** `scripts/start-docker.sh` runs
   `check-db.js`, `update-tracker.js` and `node server.js`, and `update-tracker.js` writes `public/script.js`
   **only** when `COLLECT_API_ENDPOINT` is set — which this Blueprint does not set. The Prisma CLI's writes and the
   server's cache writes are the remaining unknown, so the Blueprint keeps `writableRootFilesystem: true` until a
   lane run passes with `false`.
2. **Resolved:** minimum Postgres — upstream documents v12.14+ (README L31) and the boot check refuses below
   `9.4.0` (`scripts/check-db.js` L8-L9, L63-L66). The Blueprint asks for 16, far above both floors.
3. Memory request and limit.
4. **Resolved:** `/login` answers `200` with no server redirect (`src/app/login/page.tsx` sets
   `dynamic = 'force-dynamic'` and returns `null` only under `DISABLE_LOGIN`/`CLOUD_MODE`; the logged-in redirect
   happens client-side in `LoginPage.tsx`, and `docker/proxy.ts` answers 403 only when `DISABLE_LOGIN` is set).
5. **Resolved:** smoke calls take a JSON body (APW-03 schema §16, POST only), so the
   `default-admin-refused` entry is enabled in `works.yml`; `src/app/api/auth/login/route.ts` L26 plus
   `src/lib/response.ts` L20-L30 give it `401`.
6. **Resolved:** the upstream's own check commands (`.github/workflows/ci.yml` at `v3.4.0` — Node 22,
   pnpm 12.3.4, a dummy `DATABASE_URL` and `SKIP_DB_CHECK: 1`; `package.json`: `test` = `vitest run`, `lint` =
   `biome lint .`). They are recorded as commented entries under `checks` and apply once the strategy becomes
   `dockerfile`.
7. **Whether the pod can roll out at all as drafted:** the image's user is the **name** `nextjs` (uid 1001), and
   kubelet refuses a non-numeric image user under `runAsNonRoot` unless `runAsUser` is set. `schema.md` §10 has no
   user field, so the Blueprint cannot declare the uid yet; it needs an optional numeric `components[].runAsUser`
   (recorded as `TODO(contract, APW-03)` in `works.yml`) or a deploy target that allows root.

## Evolving an Umami App Work

With `strategy: image`, a merged change in the fork does not reach the running app. Two supported ways forward:

- **Switch to building the fork.** Change `build.strategy` to `dockerfile` (and drop `build.image`). The upstream
  ships a multi-stage Dockerfile, so no overlay is needed. This is an ordinary App spec pull request — an agent may
  propose it, a person merges it. The upstream Dockerfile builds with a **dummy** `DATABASE_URL` (L40), so this
  variant needs **no build service**; its checks are the commented `checks` entries in `works.yml`.
- **Stay on the image** and use the App Work for configuration, domains and upstream tracking only.

The acceptance suite uses Umami for the runtime path and the fixture application and Cal.diy for the evolve loop
(see [ACCEPTANCE.md](../../../ACCEPTANCE.md)).

## Refreshing the pin

Read the digest for the new release tag from the Packages listing, re-read every row above at that release, update
`build.image` and `blueprint.version` in one pull request. The Blueprint stays `verified` only after the
verification lane's pass streak at the new digest.

## What it runs

The upstream's own published image (`ghcr.io/umami-software/umami`, pinned by digest — nothing is built, so a run
spends no build minutes), as a single `web` component on port 3000 doing one job: privacy-first analytics. The
image's entrypoint runs the database check, which migrates, and then the server; `set -e` in that script means a
failed migration fails the container rather than leaving a half-migrated app behind. `works.yml` is the whole
definition and _What the Blueprint decides_ above is the summary.

## Dependencies

A **Postgres 16** App dependency with a direct URL, because migrations prefer `DIRECT_DATABASE_URL`. No other
dependency kind is declared: the app has no queue, no object storage and no mail. Two credentials are generated per
App Work (`APP_SECRET`, `TWO_FACTOR_ENCRYPTION_KEY`) and nothing uses the compose file's placeholder values.

## First run

The upstream ships a first user `admin` with the documented password `umami`. The `bootstrap-admin` **first-deploy**
job replaces that password over the in-cluster URL before the ingress is published, and is idempotent: when the
default password is no longer accepted (`401`) it treats the replacement as already done. The prompted password is
at least 12 characters (the upstream's own API floor is 8). Smoke tests assert `/api/heartbeat` and `/login` answer
`200`, and that the default credential is **refused** (`401`) once the job has run.

## Known limits

- The pod's image user is a **name** (`nextjs`), so it cannot roll out under the platform's `runAsNonRoot` default
  until an App spec can declare `runAsUser` — see the unverified list.
- With `strategy: image`, a change merged into the fork is not rebuilt (see _Evolving an Umami App Work_).
- The root filesystem is writable until a lane run proves it need not be.
- Memory request and limit are unmeasured.
- The Blueprint is `Draft`: nothing here has run on a cluster.

## License and trademarks

The upstream project is MIT (`LICENSE` in the same repository), classified `green`. The Blueprint uses the
upstream's own image and its unmodified name, so it carries **no trademark notice of its own** and does not imply
affiliation with umami-software. The Blueprint's own repository licence is MIT.
