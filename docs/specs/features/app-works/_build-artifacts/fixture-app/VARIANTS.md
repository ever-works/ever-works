# Variant branches

`CONTRIBUTING.md` points here. Every `variant/*` branch is **one small commit on top of `main`** whose only
job is to make a failure — or a specific build feature — observable from outside, so an acceptance scenario can
assert it. They are **never merged**; the acceptance harness selects one through the App spec's
`source.branch` (`blueprints/app-fixture-hello/.works/works.yml:19`).

Two rules keep them honest:

1. **One mechanism each.** If a branch needs two changes, it is two branches.
2. **The base app must stay working on `main`.** A variant may break the _build_, the _migration_ or the
   _startup_, but nothing in a variant may be needed for the happy path — `../APW-13-golden-paths/blueprints/app-fixture-hello/README.md`
   is the contract for what `main` must do.

## Application variants

| Branch                    | The single commit                                                                                            | The mechanism                                                                                                                                                                                                                                | Scenario   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `variant/build-oom`       | Add a `RUN` step to the `deps` stage that allocates until the runner kills it.                               | The step exceeds the runner's memory limit, so the build ends **exit 137** rather than a Docker error — the case a naive retry would loop on.                                                                                                | ACC-NEG-10 |
| `variant/baked-localhost` | Bake the public URL into the image: `ENV FIXTURE_PUBLIC_URL=http://localhost:8080`.                          | `GET /marker` then reports `localhost`, which the `marker` smoke check rejects (`bodyNotContains: ['localhost']`) — proving the platform did not silently accept a build-time URL.                                                           | ACC-NEG-11 |
| `variant/bad-migration`   | Break the **second** migration (`migrations/0002_ticks.sql`) with a syntax error.                            | `src/migrate.mjs` exits non-zero on the first failing file, so the `pre-deploy` Job fails and the rollout never starts. A broken _first_ migration would prove less: it cannot show that earlier files were applied and then rolled forward. | ACC-13-08  |
| `variant/slow-boot`       | Delay `GET /healthz` by 120 s (a `setTimeout` before the listener is ready, or a sleep in the startup path). | The startup probe's budget (`periodSeconds: 2`, `failureThreshold: 30` → 60 s) is exceeded, so the deployment is reported as not becoming ready instead of flapping green.                                                                   | ACC-13-08  |

## Build variants the Builds epic needs (Resolution R-23 — this fixture owns every one)

Each pairs a branch with a **profile** in [`profiles/`](./profiles/) — the App spec delta that makes the
scenario about the build rather than about the app.

| Branch                      | The single commit                                                                                                                            | Profile                                                             | Scenario             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------- |
| `variant/dockerfile-error`  | Make a `RUN` step exit non-zero (`exit 3`).                                                                                                  | —                                                                   | ACC-05-17            |
| `variant/missing-value`     | Nothing — the branch exists so the lane has a ref to pin.                                                                                    | [`missing-value.works.yml`](./profiles/missing-value.works.yml)     | ACC-05-14, ACC-05-17 |
| `variant/secret-in-image`   | Nothing, for the same reason.                                                                                                                | [`secret-in-image.works.yml`](./profiles/secret-in-image.works.yml) | ACC-05-15            |
| `variant/services-postgres` | Add a build stage that runs the migrations against the **declared build service** (`build.services`), using `src/migrate.mjs --label build`. | [`build-services.works.yml`](./profiles/build-services.works.yml)   | ACC-05-12            |
| `variant/build-timeout`     | Add a step that outlasts the limit (for example `RUN sleep 400`).                                                                            | [`build-timeout.works.yml`](./profiles/build-timeout.works.yml)     | ACC-05-17            |
| `variant/disk-full`         | Write a large file in a `RUN` step until the runner's disk is exhausted (`fallocate`/`dd`).                                                  | —                                                                   | ACC-05-17            |

**Why two of them change nothing:** `missing-value` and `secret-in-image` are scenarios about the _spec_, not
about the code. The branch exists only so the harness has a stable ref to select, and the profile carries the
whole delta — that is exactly what the README means by "the App spec differences live as profiles in the
Blueprint repository".

## The one workflow that must never run in a fork

`.github/workflows/variants.yml` is scheduled in this repository. An App Work created from a fork inherits it,
and the platform's Actions hygiene **must disable inherited workflows** before the first build
(`APW-02 FR-25`, `ACC-02-08`): the fixture is the smallest thing that proves the rule bites, because a fork
that kept it would run a scheduled job nobody asked for. `variants.yml` therefore carries a `schedule:` trigger
and writes a marker file — the scenario asserts the marker never appears in the fork.

## Regenerating the profiles

```bash
node profiles/_generate.mjs          # rewrite the five profiles from the base Blueprint
node profiles/_generate.mjs --check  # fail if any profile is out of date (use this in CI)
```

The generator reads `APW-13-golden-paths/blueprints/app-fixture-hello/.works/works.yml` and validates every
output against the App-spec JSON Schema, so a profile cannot drift from either the base spec or the schema.
