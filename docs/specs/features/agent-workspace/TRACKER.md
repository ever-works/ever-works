# Agent Workspace — status tracker

Updated as work lands. Two independent axes per epic: **spec** and **implementation**.

- **Spec**: `—` not started · `Draft` written · `Reviewed` · `Approved`
- **Impl**: `—` not started · `In progress` · `PR open` · `Merged` · `Verified` (e2e green on develop)

Last refreshed **2026-09-16**, against `origin/develop` at #2425 and the open pull requests of
that date. Every claim below names the pull request it rests on.

| ID    | Epic                            | Spec  | Impl    | Branch / PR         | Notes                                                                                                             |
| ----- | ------------------------------- | ----- | ------- | ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| AW-01 | Command palette & global search | Draft | Merged  | #2412               | P1 merged (#2412); P2 and P3 not started                                                                          |
| AW-02 | Task board                      | Draft | Merged  | #2409               | P1 merged (#2409); P2 and P3 not started                                                                          |
| AW-03 | My Decisions                    | Draft | Merged  | #2410               | P1 merged (#2410); P2 and P3 not started                                                                          |
| AW-04 | Live Feed                       | Draft | Merged  | #2415               | P1 merged (#2415); P2 and P3 not started                                                                          |
| AW-05 | Agent email                     | Draft | Merged  | #2418               | P1 merged (#2418); P2 and P3 not started                                                                          |
| AW-06 | Knowledge library               | Draft | PR open | #2425, #2453        | P1 backend merged (#2425); P1 web open (#2453, reopened from #2430); P2 and P3 not started                        |
| AW-07 | Memory & context files          | Draft | PR open | #2422               | P1 open (#2422); P2 and P3 not started                                                                            |
| AW-08 | Skills shelf                    | Draft | PR open | #2424               | P1 open (#2424); repair (P2) and capture from a run (P3) not started                                              |
| AW-09 | Runs & receipts                 | Draft | Merged  | #2414               | P1 merged (#2414); P2 and P3 not started                                                                          |
| AW-10 | Schedules & calendar            | Draft | PR open | #2426               | P1 open (#2426); P2 and P3 not started                                                                            |
| AW-11 | Agent computers                 | Draft | Merged  | #2411, #2417, #2437 | P1 merged (#2411 backend, #2417 web and node); P2 take-over half merged (#2437); P2 teach half and P3 not started |
| AW-12 | Chat & channels                 | Draft | PR open | #2423, #2427        | P1 backend open (#2423); P1 web open (#2427, based on #2423 rather than on develop); P2 and P3 not started        |
| AW-13 | Attention controls              | Draft | PR open | #2439               | P1 open (#2439); P2 and P3 not started                                                                            |
| AW-14 | What's new                      | Draft | Merged  | #2416               | P1 merged (#2416); P2 and P3 not started                                                                          |
| AW-15 | Connections, scopes & vault     | Draft | Merged  | #2421               | P1 merged (#2421); P2, P3 and P4 not started                                                                      |
| AW-16 | Models & tokens                 | Draft | PR open | #2431               | P1 open (#2431); P2 and P3 not started                                                                            |
| AW-17 | Costs & caps                    | Draft | PR open | #2428               | P1 open (#2428); P2 and P3 not started                                                                            |
| AW-18 | Shared dashboards               | Draft | PR open | #2438               | P1 open (#2438); P2 and P3 not started                                                                            |
| AW-19 | Home                            | Draft | PR open | #2436               | P1 open (#2436); P2 and P3 not started                                                                            |
| AW-20 | Onboarding                      | Draft | PR open | #2454               | P1 open (#2454); P2 and P3 not started                                                                            |
| AW-21 | Capability catalogue            | Draft | PR open | #2432               | P1 open (#2432); P2 and P3 not started                                                                            |
| AW-22 | Backup & export                 | Draft | —       | —                   | No pull request merged or open; P1, P2 and P3 not started                                                         |
| AW-23 | Agent identity                  | Draft | —       | —                   | No pull request merged or open; P1, P2 and P3 not started                                                         |
| AW-24 | Safety rails                    | Draft | —       | —                   | No pull request merged or open; P1, P2 and P3 not started                                                         |
| AW-25 | Help centre                     | Draft | PR open | #2435               | P1 open (#2435); P2 and P3 not started                                                                            |

### How to read the Impl cell

- The phase names are the ones the epic's own `tasks.md` uses. Every epic has P1, P2 and P3;
  AW-15 also has a P4.
- Where one phase ships in more than one pull request (AW-06, AW-11, AW-12), the cell reports the
  least-advanced part: an epic reads `Merged` only when every pull request the landed phase needs is
  on `develop`, and `PR open` while any part of it is still open.
- No epic reads `Verified` yet. The legend defines `Verified` as e2e green on `develop`, and the
  Agent Workspace end-to-end specs first ran on `stage` after the merged epics had already landed;
  #2455 is the open pull request that fixes them.

### Program-wide work

- **#2403** — the program scaffolding, all 25 epic specs and this tracker. Merged.
- **#2455** — repairs the Agent Workspace end-to-end specs. Open against `develop`. It spans the
  merged epics rather than belonging to any one of them, so it has no row above.

## Merge order

Ordering is chosen so that each wave leaves `develop` shippable and the next wave has the
substrate it needs.

**Wave 1 — the spine** (nothing depends on anything else here)
AW-01 · AW-02 · AW-03 · AW-04 · AW-09

**Wave 2 — the loop closes**
AW-19 (needs 02/03/04) · AW-10 (needs 09) · AW-13 (needs 04) · AW-17 (needs 09)

**Wave 3 — the depth**
AW-05 · AW-06 · AW-07 · AW-08 · AW-12 · AW-15 · AW-16 · AW-23

**Wave 4 — the reach**
AW-11 · AW-18 · AW-20 · AW-21 · AW-22 · AW-24 · AW-25
