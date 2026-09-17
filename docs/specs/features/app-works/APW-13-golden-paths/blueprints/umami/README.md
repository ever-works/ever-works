# App Blueprint draft — Umami

**Status:** `Draft` — seed content for the Blueprint repository `ever-works/umami-template` (topic
`ever-works-app-blueprint`). **Owner:** [APW-13](../../spec.md). **Shape:** [CONTRACTS.md §1](../../../CONTRACTS.md).
**Unverified** in the sense of [APW-13 spec §4.5](../../spec.md).

Umami is the **fast** golden path. It proves the runtime half of App Works — App dependency, generated secrets,
first-deploy job before the ingress, probes, smoke tests, domain, App Launcher — on real software in minutes,
because it deploys the upstream's published image and builds nothing.

## What the Blueprint decides

| Concern             | Decision                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Build               | `image`, pinned by digest (tag `3.4.0`).                                                                         |
| Runtime             | One `web` component on port 3000; heartbeat probes; the image's own boot script migrates and stops on failure.   |
| Database            | A Postgres App dependency with a direct URL for migrations.                                                      |
| Secrets             | `APP_SECRET` and `TWO_FACTOR_ENCRYPTION_KEY` generated once; nothing uses the compose file's placeholder values. |
| First administrator | The documented default password is replaced by a prompted one before the ingress is published.                   |
| Privacy defaults    | Telemetry and update checks disabled.                                                                            |
| Evolve loop         | Not rebuilt while the strategy is `image` — see below.                                                           |

## Facts and where they were read (2026-09-17)

| Fact                                                                                                           | Source                                                                                                       |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Licence MIT; default branch `master`; latest release `v3.4.0` at commit `ec0ff503…`                            | <https://github.com/umami-software/umami> (repository metadata, releases)                                    |
| Image `ghcr.io/umami-software/umami`, tags `3.4.0`/`3.4`/`3`/`latest`/`postgresql-latest` → `sha256:85909afc…` | GitHub REST `GET /orgs/umami-software/packages/container/umami/versions` (read with an authenticated client) |
| Required `DATABASE_URL`, `APP_SECRET`, `TWO_FACTOR_ENCRYPTION_KEY` (64 hex); heartbeat health check            | <https://github.com/umami-software/umami/blob/master/docker-compose.yml>                                     |
| `EXPOSE 3000`, `PORT=3000`, non-root user, CMD runs `scripts/start-docker.sh`                                  | <https://github.com/umami-software/umami/blob/master/Dockerfile>                                             |
| Boot script uses `set -e`, runs the database check (with migrations), then the server                          | <https://github.com/umami-software/umami/blob/master/scripts/start-docker.sh>                                |
| Migrations use `DIRECT_DATABASE_URL` when set; `SKIP_DB_MIGRATION` exists                                      | <https://github.com/umami-software/umami/blob/master/scripts/check-db.js>                                    |
| `/api/heartbeat` returns `{"ok":true}`                                                                         | <https://github.com/umami-software/umami/blob/master/src/app/api/heartbeat/route.ts>                         |
| `DISABLE_TELEMETRY`, `DISABLE_UPDATES`                                                                         | `src/app/api/scripts/telemetry/route.ts`, `src/app/api/config/route.ts` in the same repository               |
| First login `admin` / `umami`                                                                                  | <https://github.com/umami-software/umami/blob/master/README.md>                                              |
| Login returns a `token`; bearer authentication; password change needs the current password                     | `src/app/api/auth/login/route.ts`, `src/lib/auth.ts`, `src/app/api/me/password/route.ts`                     |
| User documentation for environment variables (not re-read for this draft)                                      | <https://umami.is/docs/environment-variables>                                                                |

## Unverified — resolve on the first verification run

1. Whether the root filesystem can be read-only (the boot script also updates the tracker script).
2. The minimum supported Postgres major version (the compose file uses 15; the Blueprint asks for 16).
3. Memory request and limit.
4. That `/login` answers 200 for probes and smoke without following a redirect.
5. The smoke test for "default credential refused" needs a request body on smoke calls (APW-06). Until then the
   verification lane performs that assertion itself.
6. The upstream's own check commands, needed before `checks` can be filled in for the `dockerfile` variant.

## Evolving an Umami App Work

With `strategy: image`, a merged change in the fork does not reach the running app. Two supported ways forward:

- **Switch to building the fork.** Change `build.strategy` to `dockerfile` (and drop `build.image`). The upstream
  ships a multi-stage Dockerfile, so no overlay is needed. This is an ordinary App spec pull request — an agent may
  propose it, a person merges it.
- **Stay on the image** and use the App Work for configuration, domains and upstream tracking only.

The acceptance suite uses Umami for the runtime path and the fixture application and Cal.diy for the evolve loop
(see [ACCEPTANCE.md](../../../ACCEPTANCE.md)).

## Refreshing the pin

Read the digest for the new release tag from the Packages listing, re-read every row above at that release, update
`build.image` and `blueprint.version` in one pull request. The Blueprint stays `verified` only after the
verification lane's pass streak at the new digest.
