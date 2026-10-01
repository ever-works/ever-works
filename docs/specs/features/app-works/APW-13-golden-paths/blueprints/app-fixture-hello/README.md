# App Blueprint draft — App fixture (hello)

**Status:** `Draft` — seed content for `ever-works/app-fixture-hello-template` (topic `ever-works-app-blueprint`).
**Owner:** [APW-13](../../spec.md). **Application:** `ever-works/app-fixture-hello` (built by APW-13; design in
[plan §4](../../plan.md)). **Shape:** [CONTRACTS.md §1](../../../CONTRACTS.md).

The fixture is not a product. It is the smallest application that makes **every App spec feature observable** from
outside the cluster, so an acceptance scenario can prove a behaviour by reading an HTTP response instead of trusting
a status field. It builds in well under three minutes and deploys in under one (both to be confirmed by the fixture
CI's first recorded timings — see the unverified list below).

## Feature → how the fixture makes it observable

| App spec feature                        | Observable proof                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `build.strategy: dockerfile`, build arg | `GET /marker` → `buildLabel` equals the build-phase value                                                                                                                                                                                                                                                          |
| `build.commitSha`                       | `GET /marker` → `sha` equals the commit the Build recorded                                                                                                                                                                                                                                                         |
| Prompted env                            | `GET /marker` → `marker` equals the run-unique value typed at creation                                                                                                                                                                                                                                             |
| Generated env, never rotated            | `GET /state` → `secretFingerprint` (length + hash prefix, never the value) is identical across redeploys                                                                                                                                                                                                           |
| `web` component, Service, Ingress       | The live URL answers                                                                                                                                                                                                                                                                                               |
| `worker` component                      | `GET /state` → `workerHeartbeatAt` is less than 30 seconds old                                                                                                                                                                                                                                                     |
| Probes                                  | `/readyz` is 503 until migrated; a Deployment only turns ready afterwards                                                                                                                                                                                                                                          |
| Volume                                  | `GET /state` → `uploadsWritable: true`                                                                                                                                                                                                                                                                             |
| `postgres` dependency                   | `GET /state` → `migrations` lists every applied file                                                                                                                                                                                                                                                               |
| `pre-deploy` job                        | `GET /state` → `migrations`; on `variant/bad-migration` the rollout never starts                                                                                                                                                                                                                                   |
| `first-deploy` job before ingress       | `GET /state` → `bootstrap.sawInternalApp: true`, `bootstrap.sawPublicApp: false`                                                                                                                                                                                                                                   |
| Cron                                    | `GET /state` → `cronTicks` increases; anonymous `POST /cron/tick` is 401                                                                                                                                                                                                                                           |
| `smtp` dependency                       | `POST /mail/test` → a message reaches the mail sink                                                                                                                                                                                                                                                                |
| Domain env                              | `GET /marker` → `publicUrl` is the assigned domain, never `localhost`                                                                                                                                                                                                                                              |
| Smoke tests                             | the four smoke checks above                                                                                                                                                                                                                                                                                        |
| Non-root image                          | the pod starts under the platform's default security context, which needs a **numeric** `USER`. **Open:** the draft Dockerfile has `USER node` — a _name_, which kubelet refuses as `image_user_unverifiable`; the fix is `USER 1000` (plan §4.1, T22)                                                             |
| Managed-tier eligibility                | not yet: the `tick` cron fires every 2 minutes and the managed tier refuses anything more frequent than every 5 minutes (`cron_too_frequent`) — the managed-tier profile carries the ≥ 5-minute schedule                                                                                                           |
| Checks                                  | `npm test` (Node's built-in test runner, no dependencies) and `npm run format:check` (`node tools/format-check.mjs` — the repository's own dependency-free formatting gate, so a check job installs nothing beyond `npm ci`; the image build uses `npm ci --omit=dev`, keeping its single `pg` runtime dependency) |
| Protected paths                         | `public/brand/logo.svg`                                                                                                                                                                                                                                                                                            |
| Evolve loop                             | `src/greeting.mjs` holds the string `GET /` renders; the agent changes it                                                                                                                                                                                                                                          |
| Upstream workflows disabled on forks    | the application repository carries a scheduled workflow that must never run in a fork                                                                                                                                                                                                                              |

## Variant branches in the application repository

Selected by the harness through `source.branch`. Each is a single small commit on top of `main`.

| Branch                    | Makes this happen                                                | Scenario   |
| ------------------------- | ---------------------------------------------------------------- | ---------- |
| `variant/build-oom`       | a build step exhausts the runner's memory (exit 137)             | ACC-NEG-10 |
| `variant/baked-localhost` | the public URL is baked at build time as `http://localhost:8080` | ACC-NEG-11 |
| `variant/bad-migration`   | the second migration fails                                       | ACC-13-08  |
| `variant/slow-boot`       | `/healthz` answers only after 120 s (beyond the startup budget)  | ACC-13-08  |

Variants the Builds epic needs (program Resolution R-23 — this Blueprint's owner creates every fixture branch). The
App spec differences live as profiles in the Blueprint repository (see below).

| Branch                      | Makes this happen                                                                  | Profile                     | Scenario      |
| --------------------------- | ---------------------------------------------------------------------------------- | --------------------------- | ------------- |
| `variant/dockerfile-error`  | a Dockerfile step exits non-zero                                                   | —                           | ACC-05-17     |
| `variant/missing-value`     | the build needs a build value that is left unset                                   | `missing-value.works.yml`   | ACC-05-14, 17 |
| `variant/secret-in-image`   | a secret build value is copied into the final image's environment                  | `secret-in-image.works.yml` | ACC-05-15     |
| `variant/services-postgres` | a build stage migrates the throwaway build database, never the App Work's database | `build-services.works.yml`  | ACC-05-12     |
| `variant/build-timeout`     | a build step outlasts a 5-minute build limit                                       | `build-timeout.works.yml`   | ACC-05-17     |
| `variant/disk-full`         | a build step fills the runner's disk                                               | —                           | ACC-05-17     |

## Profiles

`profiles/all-dependencies.works.yml` in the Blueprint repository adds a Redis and an object-storage dependency; the
fixture then also reports `redisPing` and `bucketRoundTrip` in `GET /state`. The harness commits it as the App spec
on a test branch when those App dependency kinds ship (APW-07).

`profiles/missing-value.works.yml`, `profiles/secret-in-image.works.yml`, `profiles/build-services.works.yml` and
`profiles/build-timeout.works.yml` are complete App specs that differ from `.works/works.yml` only in the build values,
build services or build time limit their variant needs ([plan §4.4](../../plan.md)).

## Why the fixture lives in `ever-works` but its test copies do not

`ever-works/app-fixture-hello` is the canonical, harmless source. The acceptance lanes never fork it directly:
they create throwaway upstream repositories from it in the test organization, so every run gets a fresh fork
network and nothing the harness does touches a repository users can see. See [ACCEPTANCE.md §0](../../../ACCEPTANCE.md).

## Unverified — resolve on the first verification run

1. **Build and deploy timings.** "Well under three minutes" and "under one minute" are estimates, and ACC-13-01's
   `< 3 min` cold-build budget and the fixture CI's 120 s threshold rest on them. Replace both with the fixture CI's
   first recorded docker-build wall time, and add APW-05's default "Reclaim runner disk" step to the budget, which
   the current estimate omits.
2. **The `format` check's tool — resolved.** `npm run format:check` is `node tools/format-check.mjs`, the
   repository's own dependency-free gate (LF endings, no trailing whitespace, exactly one final newline, tabs in
   code and spaces in YAML); `npm ci` adds nothing to it. `format:write` is the fixing form. The check can turn
   `required: true` once a lane has run it.
3. **The managed-tier profile.** The base spec's `tick` cron fires every 2 minutes, which `ever-works-apps` refuses
   (`cron_too_frequent`); the managed-tier profile carries `*/5 * * * *` instead. Confirm on a managed-tier lane.
4. **The numeric `USER` — still open.** The draft Dockerfile's last user instruction is `USER node`, a **name**:
   kubelet refuses that under the platform's default `runAsNonRoot` (`image_user_unverifiable`). The fix is a
   numeric `USER 1000` (the uid the `node` user already has) in the fixture Dockerfile, after which only a real
   rollout proves kubelet accepts it.
5. Nothing here has run: the Blueprint is `Draft`, and `blueprint.sha` is still forty zeros until the release
   workflow stamps it.

## What it runs

A purpose-built Node application (`ever-works/app-fixture-hello`, built by APW-13; source design in
[plan §4](../../plan.md)) with a `web` component that answers `/`, `/healthz`, `/readyz`, `/marker`, `/state`,
`/cron/tick` and `/mail/test`, and a `worker` component that writes a heartbeat every 10 seconds. Nothing is
imported from a real product: every response is a fact an acceptance scenario can assert.

## Dependencies

A **Postgres 16** App dependency (migrations are applied by the `pre-deploy` job) and an **SMTP** App dependency
(`POST /mail/test` sends to the prompted address and the lane reads the mail sink). The `all-dependencies` profile
adds Redis and object storage for the lanes that need every dependency kind present. One secret is generated per
App Work (`FIXTURE_SESSION_SECRET`) and one token (`FIXTURE_CRON_TOKEN`); the marker, the mail address and the build
label are prompted or fixed values.

## First run

`migrate` (`pre-deploy`) applies `migrations/*.sql` in order and exits non-zero on any failure, so
`variant/bad-migration` stops the rollout. `bootstrap` (`first-deploy`) records whether the **public** URL already
served this app — it must not have, because first-deploy jobs run after the pod is ready and before the ingress is
published. Smoke tests then assert `/healthz`, `/readyz`, `/marker` (never `localhost`) and that an anonymous
`POST /cron/tick` is `401`.

## Known limits

- The `tick` cron fires every 2 minutes, so the base spec is not eligible for managed hosting as written.
- Build and deploy timings are estimates until the fixture CI records them.
- The Blueprint is `Draft`; `blueprint.sha` is forty zeros until the release workflow stamps it, so it cannot be
  applied from the catalog until then.

## License and trademarks

MIT (`LICENSE` in the application repository and in this Blueprint repository). The fixture is not a product and
carries no third-party marks: the only brand asset is `public/brand/logo.svg`, which exists so ACC-NEG-04 can prove
that an agent cannot change a protected path.
