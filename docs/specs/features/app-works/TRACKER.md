# App Works — status tracker

Updated as work lands. Two independent axes per epic: **spec** and **implementation**.

- **Spec**: `—` not started · `Draft` written · `Reviewed` · `Approved`
- **Impl**: `—` not started · `In progress` · `PR open` · `Merged` · `Verified` (its [ACCEPTANCE.md](./ACCEPTANCE.md) scenarios green on develop)

Last refreshed **2026-09-17**, verified against `develop` @ `e5f43f44d` (2026-09-17; authored against `a655b53ca`). No pull request exists for any epic
yet. Jira tickets do not exist yet: every epic carries `EW-TBD` until the owner files the program epic and
one story per epic (the newest id on 2026-09-17 was EW-816).

| ID     | Epic                                           | Wave  | Spec  | Impl | Jira   | Branch / PR | Notes                                                        |
| ------ | ---------------------------------------------- | ----- | ----- | ---- | ------ | ----------- | ------------------------------------------------------------ |
| APW-01 | App Work kind & create from any repository URL | 1     | Draft | —    | EW-TBD | —           |                                                              |
| APW-02 | Fork lifecycle                                 | 0 · 1 | Draft | —    | EW-TBD | —           | P0 (checkout keys, fork readiness) unblocks APW-01           |
| APW-03 | App spec, Apps catalog, license gate           | 1     | Draft | —    | EW-TBD | —           | Needs the `ever-works/apps` catalog repository               |
| APW-04 | App Provisioner                                | 1     | Draft | —    | EW-TBD | —           | Needs agent + skill entries in `ever-works/agents`, `skills` |
| APW-05 | Builds                                         | 1 · 3 | Draft | —    | EW-TBD | —           |                                                              |
| APW-06 | App runtime on Kubernetes                      | 1–3   | Draft | —    | EW-TBD | —           | Managed target stays off until APW-10 gate                   |
| APW-07 | App env & dependencies                         | 1 · 2 | Draft | —    | EW-TBD | —           |                                                              |
| APW-08 | Evolve loop                                    | 0 · 1 | Draft | —    | EW-TBD | —           | P0 = agent git tool fix (independent PR)                     |
| APW-09 | Upstream pull requests                         | 2     | Draft | —    | EW-TBD | —           |                                                              |
| APW-10 | Ever Works Apps hosting tier (launch gate)     | 2 · 3 | Draft | —    | EW-TBD | —           | Infra specifics in the private operations repository         |
| APW-11 | App Launcher & Apps registry API               | 1 · 3 | Draft | —    | EW-TBD | —           |                                                              |
| APW-12 | Ever ID                                        | 2 · 3 | Draft | —    | EW-TBD | —           | Cross-repository (Ever Works, Teams, Gauzy)                  |
| APW-13 | Golden paths & acceptance suite                | 1 · 2 | Draft | —    | EW-TBD | —           | Fixture app → Umami → Cal.diy                                |

## Merge order

1. **Wave 0 (independent, small):** APW-08 P0 (agent git tools) · APW-02 P0 (checkout keys, fork readiness).
2. **Wave 1 foundations (parallel):** APW-03 P1 · APW-02 P1 · APW-07 P1 · APW-11 P1.
3. **Wave 1 creation and running:** APW-01 P1 → APW-05 P1 → APW-06 P1 → APW-04 P1.
4. **Wave 1 loop:** APW-08 P1 → APW-13 P1 (the owner's example green on a user cluster).
5. **Wave 2:** APW-10 P1–P2 → APW-06 P2 · APW-07 P2 → APW-09 P2 · APW-12 P1 → APW-13 P2.
6. **Wave 3:** APW-05 P3 · APW-06 P3 · APW-10 P3 · APW-11 P2 · APW-12 P2–P3.

## Migration timestamp blocks

`1792` + two-digit epic + two-digit slot + `00000` (see README §7 rule 6). Newest migration on `develop`
when authored: `1791200100000-CreateOnboardingChecklists.ts`; on `ee45946e5` (re-verified 2026-09-17):
`1791240000000-AddSafetyRailsCore.ts`. Every reserved `1792…` timestamp is still above it. AW-24 P2 has reserved
`1791240100000-AddHeldActionExecution.ts`, also below the block.
