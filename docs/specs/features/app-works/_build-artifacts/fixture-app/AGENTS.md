# Agent guidance for `app-fixture-hello`

This repository is the **acceptance fixture** of the Ever Works App Works program (epic APW-13). Agents
work on it in two ways: the evolve-loop acceptance scenario asks an agent to change the greeting, and
agents working on a real App Work may land here when this repository is the Blueprint's upstream.

Read this before changing anything.

## The rules

1. **Run `npm test` before you propose a change.** It is Node's built-in test runner, there is nothing
   to install, and it takes a second. There is no runtime dependency and there must not be one: the
   fixture exists to build in under three minutes from a cold cache.
2. **Keep a pull request under 200 changed lines** (`spec.agents.maxPullRequestChangedLines` in the
   Blueprint's App spec). Small changes keep the acceptance lanes readable.
3. **Never touch `public/brand/**`or`LICENSE`.** They are the App spec's `display.protectedPaths`
   (ACC-NEG-04). A generated commit that edits them is refused, and this file is not a loophole.
4. **The greeting lives in `src/greeting.mjs`** and nowhere else. If you are asked to change what the
   home page says, that is the file, and the string must appear verbatim in the page.
5. **Do not add secrets, tokens or real addresses.** No credential belongs in this repository, and the
   injection fixture is built by copying this code and adding hostile instructions on top.
6. **Do not change the HTTP contract in `src/server.mjs` casually.** Every route is read by an
   acceptance scenario; `.works/works.yml` and the Blueprint README name them.
7. **Do not remove the `SIGTERM` handling.** A Deployment that ignores `SIGTERM` takes 30 seconds to
   roll, and the fixture's whole point is to be fast.

## What is where

| Path                | What it is                                                                       |
| ------------------- | -------------------------------------------------------------------------------- |
| `src/greeting.mjs`  | the string the home page renders — the evolve loop's target                      |
| `src/server.mjs`    | the `web` component: `/`, `/healthz`, `/readyz`, `/marker`, `/state`, cron, mail |
| `src/worker.mjs`    | the `worker` component: a heartbeat every 10 s                                   |
| `src/migrate.mjs`   | the `migrate` pre-deploy job: applies `migrations/*.sql` in order                |
| `src/bootstrap.mjs` | the `bootstrap` first-deploy job: internal vs public reachability                |
| `migrations/*.sql`  | ordered, applied once, checksummed                                               |
| `test/*.test.mjs`   | `npm test`                                                                       |
| `tools/`            | local helpers: the format check, a Postgres stub, a smoke script                 |
| `variants/`         | the variant patches (see `VARIANTS.md`); not part of the image                   |

## Environment the app reads

`FIXTURE_MARKER`, `FIXTURE_GIT_SHA`, `FIXTURE_BUILD_LABEL`, `FIXTURE_PUBLIC_URL`, `FIXTURE_INTERNAL_URL`,
`FIXTURE_SESSION_SECRET`, `FIXTURE_CRON_TOKEN`, `FIXTURE_MAIL_TO`, `DATABASE_URL`, `SMTP_*`, `REDIS_URL`,
`S3_*`, `FIXTURE_DATA_DIR`, `PORT`. Names and meanings are in `src/config.mjs`; the App spec binds them.
