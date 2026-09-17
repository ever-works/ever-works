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
2. **Wave 1 foundations (parallel):** APW-03 P1 · APW-02 P1 · APW-07 P1 · APW-11 P1 · **APW-09 P1** (its own
   spec and ACCEPTANCE both place APW-09 P1 in Wave 1; this row previously omitted it — see the note below).
3. **Wave 1 creation and running:** APW-01 P1 → APW-05 P1 → APW-06 P1 → APW-04 P1.
4. **Wave 1 loop:** APW-08 P1 → APW-13 P1 (the owner's example green on a user cluster).
5. **Wave 2:** APW-10 P1–P2 → APW-06 P2 · APW-07 P2 → APW-09 P2 · APW-12 P1 → APW-13 P2.
6. **Wave 3:** APW-05 P3 · APW-06 P3 · APW-10 P3 · APW-11 P2 · APW-12 P2–P3.

**Two ordering issues to settle before Wave 1 starts** (both discovered 2026-09-17; neither blocks Wave 0):

- **APW-06 ↔ APW-07 declare each other.** `APW-06/spec.md:14` depends on APW-07 ("env values, App dependencies")
  and `APW-07/spec.md:13-14` depends on APW-06 ("deploy target, cluster access, domains"). The merge order above
  lands APW-07 P1 first, so one direction must be softened. Recommended: **APW-07 owns the env/dependency
  contracts and lands first; APW-06 consumes them** — and APW-07's stated dependency on APW-06 becomes a
  dependency on APW-06's *ports/interfaces* only, which APW-07 defines against in P1.
- **README's dependency column** was corrected on 2026-09-17 to match each epic's own `Depends on` line
  (APW-04 +07, APW-05 +02/+07, APW-06 +10, APW-08 +03, APW-11 +12). Keep the two in step: an epic's own spec wins.

## Migration timestamp blocks

`1792` + two-digit epic + two-digit slot + `00000` (see README §7 rule 6). Newest migration on `develop`
when authored: `1791200100000-CreateOnboardingChecklists.ts`; on `ee45946e5` (re-verified 2026-09-17):
`1791240000000-AddSafetyRailsCore.ts`. Every reserved `1792…` timestamp is still above it. AW-24 P2 has reserved
`1791240100000-AddHeldActionExecution.ts`, also below the block.
