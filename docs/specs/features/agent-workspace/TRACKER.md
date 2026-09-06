# Agent Workspace — status tracker

Updated as work lands. Two independent axes per epic: **spec** and **implementation**.

- **Spec**: `—` not started · `Draft` written · `Reviewed` · `Approved`
- **Impl**: `—` not started · `In progress` · `PR open` · `Merged` · `Verified` (e2e green on develop)

| ID | Epic | Spec | Impl | Branch / PR | Notes |
| --- | --- | --- | --- | --- | --- |
| AW-01 | Command palette & global search | — | — | | |
| AW-02 | Mission board | — | — | | |
| AW-03 | My Decisions | — | — | | |
| AW-04 | Live Feed | — | — | | |
| AW-05 | Agent email | — | — | | |
| AW-06 | Knowledge library | — | — | | |
| AW-07 | Memory & context files | — | — | | |
| AW-08 | Skills shelf | — | — | | |
| AW-09 | Runs & receipts | — | — | | |
| AW-10 | Schedules & calendar | — | — | | |
| AW-11 | Agent computers | — | — | | |
| AW-12 | Chat & channels | — | — | | |
| AW-13 | Attention controls | — | — | | |
| AW-14 | What's new | — | — | | |
| AW-15 | Connections, scopes & vault | — | — | | |
| AW-16 | Models & tokens | — | — | | |
| AW-17 | Costs & caps | — | — | | |
| AW-18 | Shared dashboards | — | — | | |
| AW-19 | Home | — | — | | |
| AW-20 | Onboarding | — | — | | |
| AW-21 | Capability catalogue | — | — | | |
| AW-22 | Backup & export | — | — | | |
| AW-23 | Agent identity | — | — | | |
| AW-24 | Safety rails | — | — | | |
| AW-25 | Help centre | — | — | | |

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
