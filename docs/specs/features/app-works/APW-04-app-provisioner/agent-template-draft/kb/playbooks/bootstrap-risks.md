# Playbook — bootstrap risks

> DRAFT — `ever-works/agents` → `templates/app-provisioner/kb/playbooks/bootstrap-risks.md`.
> Seeded through `.works/agent.yml` (`kb.seedPaths: [kb/playbooks]`).

A bootstrap risk is anything that makes a freshly deployed app unsafe or unreliable **before** a person has touched it.
Each one is recorded in the output's `risks` list with the file that shows it, and each one has a spec-side answer.

| Risk                  | What it looks like in the repository                                                                    | What the spec does                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `bootstrap-endpoint`  | A setup/registration route that creates the first administrator and refuses nobody while no user exists | A `first-deploy` job that performs setup before any public route is published, plus a smoke test proving a second attempt is refused |
| `cron-auth`           | A scheduled route (cron, queue tick, webhook) that the app expects to be called, with no auth check     | A `cron` entry **only** after the route is found in code, with a generated auth secret and a negative smoke test                     |
| `swallowed-migration` | A start script that runs migrations and keeps booting when they fail                                    | Migrations move to a `pre-deploy` job whose exit code is checked; never a step in a start script                                     |
| `secret-shape`        | Code that truncates, hashes or rejects a key of the wrong length                                        | A typed generator plus a validation rule encoding the exact shape                                                                    |
| `build-memory`        | A build known to need a large heap (bundlers, compilers, monorepos)                                     | Declare build memory (up to the platform's ceiling) and a matching runtime-heap setting                                              |
| `open-signup`         | Registration open to the world on a self-hosted app that expects one administrator                      | Recorded as a risk in the report; the spec declares the first-deploy job and the negative smoke test                                 |
| `telemetry`           | Analytics or crash reporting enabled by default, sending data off the deployment                        | Recorded as a risk with the variable that controls it, so the user can decide                                                        |
| `trademark`           | A name or logo the deployment is not licensed to publish                                                | Recorded as a risk in the report, never silently renamed                                                                             |

## How to report a risk

One entry per risk: `kind`, the `file` that shows it, and a one-line `note` that says what could go wrong and what the
spec does about it. Never include a value, a token or a credential in a risk note — the variable name is enough.

## When a risk needs a decision

If the safe answer changes what the user gets (publishing a setup route, disabling telemetry, renaming a product), do
**not** decide it silently: propose the safe default, record the risk, and ask one question if the choice is genuinely
theirs.
