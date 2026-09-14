# Agent Workspace — status tracker

Updated as work lands. Two independent axes per epic: **spec** and **implementation**.

- **Spec**: `—` not started · `Draft` written · `Reviewed` · `Approved`
- **Impl**: `—` not started · `In progress` · `PR open` · `Merged` · `Verified` (e2e green on develop)

| ID    | Epic                            | Spec  | Impl        | Branch / PR  | Notes                                             |
| ----- | ------------------------------- | ----- | ----------- | ------------ | ------------------------------------------------- |
| AW-01 | Command palette & global search | Draft | Merged      | #2412        | P1                                                |
| AW-02 | Task board                      | Draft | Merged      | #2409        | P1                                                |
| AW-03 | My Decisions                    | Draft | PR open     | #2410        | P1                                                |
| AW-04 | Live Feed                       | Draft | PR open     | #2415        | P1                                                |
| AW-05 | Agent email                     | Draft | PR open     | #2418        | P1                                                |
| AW-06 | Knowledge library               | Draft | In progress | —            | P1                                                |
| AW-07 | Memory & context files          | Draft | PR open     | #2422        | P1                                                |
| AW-08 | Skills shelf                    | Draft | PR open     | #2424        | P1; repair (P2) and capture from a run (P3) next  |
| AW-09 | Runs & receipts                 | Draft | PR open     | #2414        | P1                                                |
| AW-10 | Schedules & calendar            | Draft | In progress | —            | P1                                                |
| AW-11 | Agent computers                 | Draft | PR open     | #2411, #2417 | P1 backend merged (#2411); web and node legs open |
| AW-12 | Chat & channels                 | Draft | PR open     | #2423        | P1 backend; conversation panel web part next      |
| AW-13 | Attention controls              | Draft | —           |              |                                                   |
| AW-14 | What's new                      | Draft | PR open     | #2416        | P1                                                |
| AW-15 | Connections, scopes & vault     | Draft | PR open     | #2421        | P1                                                |
| AW-16 | Models & tokens                 | Draft | —           |              |                                                   |
| AW-17 | Costs & caps                    | Draft | —           |              |                                                   |
| AW-18 | Shared dashboards               | Draft | —           |              |                                                   |
| AW-19 | Home                            | Draft | —           |              |                                                   |
| AW-20 | Onboarding                      | Draft | —           |              |                                                   |
| AW-21 | Capability catalogue            | Draft | —           |              |                                                   |
| AW-22 | Backup & export                 | Draft | —           |              |                                                   |
| AW-23 | Agent identity                  | Draft | —           |              |                                                   |
| AW-24 | Safety rails                    | Draft | —           |              |                                                   |
| AW-25 | Help centre                     | Draft | —           |              |                                                   |

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
