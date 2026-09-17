# App Blueprint draft — Cal.diy (community build)

**Status:** `Draft` — seed content for the Blueprint repository `ever-works/cal-diy-template` (topic
`ever-works-app-blueprint`). **Owner:** [APW-13](../../spec.md). **Shape:** [CONTRACTS.md §1](../../../CONTRACTS.md).
**Unverified** in the sense of [APW-13 spec §4.5](../../spec.md): nothing here has run on a cluster.

This Blueprint tells Ever Works how to build and run a fork of `calcom/cal.diy` as an App Work. It contains
**no upstream source**: only [`.works/works.yml`](./.works/works.yml) and this README.

## What the Blueprint decides

| Concern                | Decision                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name and marks         | Displayed as **Cal.diy (community build)** with the trademark notice; logo and licence files are read-only to agents.                                                                                                                                                                                             |
| Licence                | MIT (green). Re-evaluated on every Upstream sync by the licence gate.                                                                                                                                                                                                                                             |
| Build                  | The upstream Dockerfile, target `runner`, 6 GB Node heap, 4 CPU / 12 GiB / 60 min, a throwaway Postgres 16 during the build whose URL is resolved from the `DATABASE_URL` env entry rather than written as a literal. `build.strategy` stays `dockerfile`: this edition publishes no image (see the facts table). |
| Secrets at build time  | None. The Dockerfile's build-only placeholders satisfy the framework; real values exist only at run time.                                                                                                                                                                                                         |
| Runtime                | One `web` component, writable root filesystem, 10-minute startup budget. The upstream image has no `USER` in any stage, so it runs as **root** and rewrites its public URL in place at boot.                                                                                                                      |
| Database migrations    | A `pre-deploy` job, so a failed migration stops the rollout.                                                                                                                                                                                                                                                      |
| First administrator    | Created by a `first-deploy` job over the in-cluster URL before the ingress is published; the email and password are prompted.                                                                                                                                                                                     |
| Scheduled calls        | Seven CronJobs whose routes exist at the pin; the rest are listed and disabled with the reason. `tasker` and `webhook-triggers` fire every minute, which the managed tier refuses (`cron_too_frequent`) — so managed hosting needs a ≥ 5-minute task queue or a tier exception.                                   |
| Cron credentials       | Both generated per App Work; nothing uses an example value.                                                                                                                                                                                                                                                       |
| Telemetry              | Disabled for the application (`CALCOM_TELEMETRY_DISABLED`) and for the run-time tooling (`TURBO_TELEMETRY_DISABLED`). Build-time framework telemetry cannot be configured through the upstream Dockerfile at the pin, which declares no `NEXT_TELEMETRY_DISABLED` ARG.                                            |
| Email                  | An SMTP App dependency is required.                                                                                                                                                                                                                                                                               |
| Evolve loop            | Agents load the upstream `AGENTS.md`; PRs are capped at 500 changed lines; `yarn type-check:ci --force` is a required check.                                                                                                                                                                                      |
| Upstream contributions | Off by default; always human-approved.                                                                                                                                                                                                                                                                            |

## Facts and where they were read

Every fact below was read on **2026-09-17** in the public upstream repository at commit
`6bc45298226f96ff79e0c070c8b2ce39727e8477` (committed 2026-09-14; the default-branch head on the day of reading).
"Read" is not "run" — see the unverified list.

| Fact                                                                                                                                                                         | Source (at the pin)                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Licence MIT                                                                                                                                                                  | repository metadata, `LICENSE`                                                                                                                                                                                                                                                                           |
| Upstream advisory: self-hosting at your own risk, "strictly recommended for personal, non-production use"                                                                    | `README.md` L1-L2 (a `[!WARNING]` block; L4-L5 points commercial users at Cal.com)                                                                                                                                                                                                                       |
| The trademark-notice wording is not in the repository — it comes from outside it (counsel)                                                                                   | `LICENSE` is plain MIT with no trademark clause; no `TRADEMARK` file exists. The wording is what `works.yml` `license.notice` carries                                                                                                                                                                    |
| Build stages, `ARG MAX_OLD_SPACE_SIZE=6144`, build-only secret placeholders, `EXPOSE 3000`, CMD                                                                              | `Dockerfile`                                                                                                                                                                                                                                                                                             |
| No `USER` instruction in any stage, so the image runs as **root** and rewrites its own files at boot                                                                         | `Dockerfile` L1/L53/L77 (three stages, no `USER`), `scripts/start.sh` L6 + `scripts/replace-placeholder.sh` (`sed -i`)                                                                                                                                                                                   |
| Base image `node:20` in every stage — a floating tag; Node 20 reached upstream end of life 2026-04-30                                                                        | `Dockerfile` L1/L53/L77. The framework needs Node ≥ 20.9; the root `package.json` declares no `engines`                                                                                                                                                                                                  |
| The build never migrates: `turbo prune`, `yarn install`, the tRPC/embed/web builds, then a cache delete                                                                      | `Dockerfile` L44-L51. The Prisma build task that migrates on build is never invoked; no `generateStaticParams`/`getStaticPaths` in `apps/web`                                                                                                                                                            |
| Boot sequence: rewrite the built URL (`http://localhost:3000` by default) → wait for `DATABASE_HOST` → migrate → seed → start                                                | `scripts/start.sh` L6-L11, `Dockerfile` L56/L84 (`ARG NEXT_PUBLIC_WEBAPP_URL` default)                                                                                                                                                                                                                   |
| `/api/version` returns the package version without touching the database                                                                                                     | `apps/web/app/api/version/route.ts`                                                                                                                                                                                                                                                                      |
| The version string is `6.2.0` — the same string as the older-licence release, so it does not identify this edition                                                           | `apps/web/app/api/version/route.ts` + `apps/web/package.json` L3                                                                                                                                                                                                                                         |
| Framework refuses to start without `NEXTAUTH_SECRET` / `CALENDSO_ENCRYPTION_KEY`; derives `NEXTAUTH_URL`                                                                     | `apps/web/next.config.ts`                                                                                                                                                                                                                                                                                |
| `CALENDSO_ENCRYPTION_KEY` must be 32 characters; `CRON_API_KEY`; telemetry opt-out variable                                                                                  | `.env.example`                                                                                                                                                                                                                                                                                           |
| First-run setup route body fields and password rule; "No setup needed." once a user exists                                                                                   | `apps/web/app/api/auth/setup/route.ts`                                                                                                                                                                                                                                                                   |
| Setup checks the user count **before** parsing the body, so an empty POST answers 400 once set up; validation errors are 422; errors are JSON carrying `message`             | `apps/web/app/api/auth/setup/route.ts` L29-L38, `apps/web/app/api/defaultResponderForAppDir.ts`                                                                                                                                                                                                          |
| `/auth/login` redirects to first-run setup while no user exists — status **307**                                                                                             | `apps/web/server/lib/auth/login/getServerSideProps.tsx`                                                                                                                                                                                                                                                  |
| The sign-in page asks next-auth for a CSRF token server-side, so the request goes to the auth base URL from inside the pod                                                   | `apps/web/server/lib/auth/login/getServerSideProps.tsx`, next-auth 4.24.13 `packages/next-auth/src/react/index.tsx` (`NEXTAUTH_URL_INTERNAL` first)                                                                                                                                                      |
| Three telemetry sources: the app's page-view collector, the Turbo binary that `yarn start` runs, and the build-time framework                                                | `packages/lib/telemetry.ts`, root `package.json` L66 (`turbo run start`), `Dockerfile` L9 (`CALCOM_TELEMETRY_DISABLED` is the only telemetry ARG)                                                                                                                                                        |
| Build-time values the Dockerfile accepts, and the ones it does **not**                                                                                                       | `Dockerfile` L6-L19 vs `packages/lib/constants.ts` L38-L40: `NEXT_PUBLIC_APP_NAME` defaults to "Cal.diy", `NEXT_PUBLIC_SUPPORT_MAIL_ADDRESS` to the upstream owner's address, `NEXT_PUBLIC_COMPANY_NAME` to "Cal.com, Inc."; `NEXT_PUBLIC_VAPID_PUBLIC_KEY` and `NEXT_PUBLIC_DISABLE_SIGNUP` have no ARG |
| Signup can be closed at **run** time through the `disable-signup` feature flag (table `Feature`), without a rebuild; invite links keep working                               | `apps/web/app/api/auth/signup/route.ts` L25-L33, `packages/prisma/migrations/20230601181657_disable_signup_feature_flag/migration.sql`, `packages/prisma/schema.prisma` L1369                                                                                                                            |
| `/api/tasks/cron` is **GET only**; the POST form has no route. Anonymous calls answer **401** on `tasks/*` and the raw-key routes but **403** on `calendar-subscriptions*`   | `apps/web/app/api/tasks/cron/route.ts` L5, `packages/features/tasker/api/{cron,cleanup}.ts`, `apps/web/app/api/cron/calendar-subscriptions/route.ts`                                                                                                                                                     |
| Cron handlers, methods and credential checks                                                                                                                                 | `apps/web/app/api/cron/*/route.ts`, `apps/web/app/api/tasks/{cron,cleanup}/route.ts`, `packages/features/tasker/api/{cron,cleanup}.ts`                                                                                                                                                                   |
| Cron schedules (`.github/workflows/cron-scheduleEmailReminders.yml` is headed "deprecated — use smtp with tasker instead"; `vercel.json` also lists two paths with no route) | `apps/web/vercel.json`, `.github/workflows/cron-*.yml`                                                                                                                                                                                                                                                   |
| `prisma db execute` reads `DATABASE_URL`; `prisma migrate deploy` reads `directUrl` = `DATABASE_DIRECT_URL`                                                                  | `packages/prisma/schema.prisma` L4-L8, `scripts/start.sh` L9                                                                                                                                                                                                                                             |
| Agent guidance: type check command, formatter form, PR size, draft PRs, ask before schema changes                                                                            | `AGENTS.md` L83-L85 (`yarn type-check:ci --force`, `yarn biome check --write .`, `TZ=UTC yarn test`), L32/L41 (500 lines, 10 files)                                                                                                                                                                      |
| Branding assets                                                                                                                                                              | `apps/web/public/`, `packages/ui/components/logo/`                                                                                                                                                                                                                                                       |

Public references: <https://github.com/calcom/cal.diy> · <https://github.com/calcom/cal.diy/blob/main/AGENTS.md>.

## Unverified — resolve on the first verification run

1. **Resolved by reading, one question left open.** The build never migrates (the Dockerfile's `RUN` steps are
   `turbo prune`, `yarn install`, the tRPC/embed/web builds and a cache delete — L44-L51) and upstream's own image
   test builds against a reachable, empty database (`.github/actions/docker-build-and-test/action.yml` L79-L117),
   so the Blueprint's empty throwaway database matches upstream. Whether a build with **no** database at all works
   is untested; the upstream-sync canary tries it once.
2. **Resolved: build services are reached on `127.0.0.1` with throwaway credentials.** APW-07 plan §4.6.2 gives the
   postgres build service `user`/`password`/`database` defaults of `ever-works-build`/`ever-works-build`/`app` on
   `127.0.0.1:5432`, and `url` = `directUrl`. The Blueprint therefore passes `DATABASE_URL` with `fromEnv` rather
   than as a literal (see `works.yml`, and rule R11's accepted warning).
3. **Resolved: APW-07 plan §4.6.2 / `APP_DEPENDENCY_OUTPUTS`.** `postgres` has `url`, `directUrl`, `host`, `port`,
   `database`, `user`, `password`; `smtp` has `host`, `port`, `user`, `password`, `from`, `secure`.
4. Memory request and limit for `web` — measure on the verification lane. TODO(verify) stays on the resources: the
   `runner` stage copies the whole monorepo install (`COPY --from=builder-two /calcom ./`, L83) rather than Next's
   standalone output, although `BUILD_STANDALONE=true`, so the image is large and the boot runs `next start` plus
   the migration and seed processes.
5. Whether `selected-calendars` and `sync-app-meta` do useful work in this edition (both disabled).
6. **Resolved: signup is closed at run time through the `disable-signup` feature flag** (table `Feature`; the
   first-deploy `close-signup` job sets it, pods pick it up within the flag cache's 5 minutes, and an administrator
   can reopen it under Settings → Admin → Flags). Invite links keep working. See the facts table above.
7. **Resolved: `yarn biome check .`** is the read-only form of the documented `yarn biome check --write .`
   (`AGENTS.md` L84); the check never writes to the checkout. Checks install nothing implicitly — APW-08 plan §2.3 —
   so each check command starts with `yarn install --immutable`. The upstream's "< 500 lines, < 10 files" PR
   guidance has no App spec field: only `agents.maxPullRequestChangedLines` exists.
8. A **non-root variant**: the upstream image runs as root and nothing in the App spec can change that. Run the
   golden-path lane only on a deploy target with `allowRoot: true`, or build a fork-side Dockerfile that sets a
   numeric non-root `USER` owning `apps/web/.next` and `apps/web/public` (unverified).
9. Run-time `NEXTAUTH_SECRET` / `CALENDSO_ENCRYPTION_KEY` that **differ from the build placeholders**: sign-in and
   one encrypted round trip (two-factor setup) work. The upstream README L574-L575 says they "Must match build
   variable"; the source at the pin reads them only at run time (`next.config.ts` L50-L51 has no `env` inlining and
   every `apps/web` usage is server code), and upstream's own image test builds without the args. The
   sign-in-plus-encrypted-round-trip itself has never been observed with differing values.
10. The `login` smoke and every readiness probe after bootstrap answer **before the ingress is published**
    (APW-06 plan §5.5 order: first-deploy jobs → in-cluster smoke → publish Ingress), because the sign-in page's
    server props call the auth base URL from inside the pod. `NEXTAUTH_URL_INTERNAL` (see `works.yml`) keeps that
    call in-cluster; what still needs hairpin routing is the absolute links and redirects built from
    `NEXT_PUBLIC_WEBAPP_URL`.
11. Whether the in-app support address and company name (`NEXT_PUBLIC_SUPPORT_MAIL_ADDRESS`,
    `NEXT_PUBLIC_COMPANY_NAME`, both defaulting to the upstream owner through `packages/lib/constants.ts` L39-L40)
    need a fork-side build change for a community build — owner/counsel decision, not a platform one.
12. The trademark-notice wording and the registered-mark symbol, confirmed by counsel before publishing (the
    repository carries no trademark statement of its own).
13. **Measure on the verification lane:** peak pod memory during boot (migrate + seed + start) and during one
    booking; boot-to-ready time; image size; build peak memory, disk and duration.

## Refreshing the pin

The pin lives in the Apps catalog entry's ref range (APW-03) and in the comment at the top of `works.yml`.

1. The weekly **upstream-sync canary** (APW-13 spec §4.5) builds and smoke-tests the upstream head. Wait for it to be
   green three runs in a row at the candidate commit.
2. Re-read every row of the facts table at the candidate commit. Any change to the Dockerfile, the start script,
   the setup route, a cron route or `.env.example` means editing `works.yml` in the same pull request. Also check
   the Dockerfile's **base image tag** and the framework's engine range (the pin builds on a floating `node:20`).
3. Re-check the licence. **Tag `v6.2.0` and older are a different licence and a different code base — never pin
   to them.** Pin a commit on `main` only: never resolve "latest tag" or "latest release", and never resolve a
   published image — there is no tag and no image for this edition. Record the **commit**, not the version string:
   `/api/version` answers `6.2.0` here too.
4. Open one pull request that bumps the comment, the catalog ref range and `blueprint.version`. A person merges it.
   The Blueprint is `verified` again only after the verification lane's pass streak at the new pin.

## What it runs

A fork of `calcom/cal.diy` (the MIT community edition of Cal.com), built from the upstream `Dockerfile` at
`target: runner` into **one `web` component** on port 3000 that carries four processes: the URL rewrite, a
`prisma migrate deploy`, the app-store seed and `next start`. `works.yml` is the whole definition; this README is
the maintainer's record of why each row is what it is (see _What the Blueprint decides_ and _Facts and where they
were read_ above). Upstream advises personal, non-production use (facts table), and the create form shows the
Blueprint's display name and trademark notice.

## Dependencies

A **Postgres 16** App dependency, used twice: at build time as the throwaway `build.services` database the
Dockerfile's `DATABASE_URL` argument points at (APW-07 plan §4.6.2), and at run time by the migration job and the
app. An **SMTP** App dependency is required — booking confirmations and password resets are email. Two credentials
are generated per App Work (`CRON_API_KEY`, `CRON_SECRET`) and nothing uses an example value.

## First run

The `migrate` **pre-deploy** job applies the Prisma migrations before any pod rolls out, so a failed migration stops
the deployment. The `bootstrap-admin` **first-deploy** job then creates the first administrator over the
in-cluster URL — before the ingress is published — and `close-signup` closes public signup in the same window. The
email address and password are prompted at creation; the smoke tests assert `/api/version` and `/auth/login` are
`200`, that first-run setup is closed (`400`) and that `/api/tasks/cron` refuses an anonymous call (`401`).

## Known limits

- The image runs as **root** (no `USER` in any stage) and rewrites its own files at boot, so it needs a deploy
  target that allows root and a **writable root filesystem**.
- A domain change needs new pods, not a rebuild — the boot-time rewrite starts from the URL baked into the image.
- `tasker` and `webhook-triggers` fire **every minute**, which the managed tier refuses (`cron_too_frequent`); the
  managed tier therefore needs a ≥ 5-minute task queue or a tier exception.
- The build needs a reachable Postgres; whether a database-less build works is untested.
- Memory, boot time and image size are estimates until the verification lane records them.
- The Blueprint is `Draft`: nothing here has run on a cluster.

## License and trademarks

The upstream project is MIT (`LICENSE` at the pin: "Copyright (c) 2020-present Cal.com, Inc."), classified
`green`. **This community build is not affiliated with or endorsed by Cal.com, Inc.**; the display name is
"Cal.diy (community build)" and `license.notice` carries the trademark notice. The repository itself contains no
trademark statement — the notice wording comes from outside it and is confirmed by counsel before publishing (see
the unverified list). The Blueprint's own repository licence is MIT.
