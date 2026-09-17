# App Blueprint draft — App fixture (hello)

**Status:** `Draft` — seed content for `ever-works/app-fixture-hello-template` (topic `ever-works-app-blueprint`).
**Owner:** [APW-13](../../spec.md). **Application:** `ever-works/app-fixture-hello` (built by APW-13; design in
[plan §4](../../plan.md)). **Shape:** [CONTRACTS.md §1](../../../CONTRACTS.md).

The fixture is not a product. It is the smallest application that makes **every App spec feature observable** from
outside the cluster, so an acceptance scenario can prove a behaviour by reading an HTTP response instead of trusting
a status field. It builds in well under three minutes and deploys in under one.

## Feature → how the fixture makes it observable

| App spec feature                        | Observable proof                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `build.strategy: dockerfile`, build arg | `GET /marker` → `buildLabel` equals the build-phase value                                                |
| `build.commitSha`                       | `GET /marker` → `sha` equals the commit the Build recorded                                               |
| Prompted env                            | `GET /marker` → `marker` equals the run-unique value typed at creation                                   |
| Generated env, never rotated            | `GET /state` → `secretFingerprint` (length + hash prefix, never the value) is identical across redeploys |
| `web` component, Service, Ingress       | The live URL answers                                                                                     |
| `worker` component                      | `GET /state` → `workerHeartbeatAt` is less than 30 seconds old                                           |
| Probes                                  | `/readyz` is 503 until migrated; a Deployment only turns ready afterwards                                |
| Volume                                  | `GET /state` → `uploadsWritable: true`                                                                   |
| `postgres` dependency                   | `GET /state` → `migrations` lists every applied file                                                     |
| `pre-deploy` job                        | `GET /state` → `migrations`; on `variant/bad-migration` the rollout never starts                         |
| `first-deploy` job before ingress       | `GET /state` → `bootstrap.sawInternalApp: true`, `bootstrap.sawPublicApp: false`                         |
| Cron                                    | `GET /state` → `cronTicks` increases; anonymous `POST /cron/tick` is 401                                 |
| `smtp` dependency                       | `POST /mail/test` → a message reaches the mail sink                                                      |
| Domain env                              | `GET /marker` → `publicUrl` is the assigned domain, never `localhost`                                    |
| Smoke tests                             | the four smoke checks above                                                                              |
| Checks                                  | `npm test` (Node's built-in test runner, no dependencies)                                                |
| Protected paths                         | `public/brand/logo.svg`                                                                                  |
| Evolve loop                             | `src/greeting.mjs` holds the string `GET /` renders; the agent changes it                                |
| Upstream workflows disabled on forks    | the application repository carries a scheduled workflow that must never run in a fork                    |

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
