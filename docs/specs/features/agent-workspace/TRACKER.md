# Agent Workspace — status tracker

Updated as work lands. Two independent axes per epic: **spec** and **implementation**.

- **Spec**: `—` not started · `Draft` written · `Reviewed` · `Approved`
- **Impl**: `—` not started · `In progress` · `PR open` · `Merged` · `Verified` (e2e green on develop)

Last refreshed **2026-09-21**, against `origin/develop` at #2505 and the open pull requests of
that date. Every claim below names the pull request it rests on. No Agent Workspace pull request
is open as of this refresh.

| ID    | Epic                            | Spec  | Impl        | Branch / PR         | Notes                                                                                                                  |
| ----- | ------------------------------- | ----- | ----------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| AW-01 | Command palette & global search | Draft | Merged      | #2412               | P1 merged (#2412); P2 and P3 not started                                                                               |
| AW-02 | Task board                      | Draft | Merged      | #2409               | P1 merged (#2409); P2 and P3 not started                                                                               |
| AW-03 | My Decisions                    | Draft | Merged      | #2410               | P1 merged (#2410); P2 and P3 not started                                                                               |
| AW-04 | Live Feed                       | Draft | Merged      | #2415               | P1 merged (#2415); P2 and P3 not started                                                                               |
| AW-05 | Agent email                     | Draft | Merged      | #2418               | P1 merged (#2418); P2 and P3 not started                                                                               |
| AW-06 | Knowledge library               | Draft | Merged      | #2425, #2453        | P1 merged in both halves: backend (#2425) and web (#2453, which superseded the closed #2430); P2 and P3 not started    |
| AW-07 | Memory & context files          | Draft | Merged      | #2422               | P1 merged (#2422); P2 and P3 not started                                                                               |
| AW-08 | Skills shelf                    | Draft | Merged      | #2424               | P1 merged (#2424); repair (P2) and capture from a run (P3) not started                                                 |
| AW-09 | Runs & receipts                 | Draft | Merged      | #2414               | P1 merged (#2414); P2 and P3 not started                                                                               |
| AW-10 | Schedules & calendar            | Draft | Merged      | #2426               | P1 merged (#2426); P2 and P3 not started                                                                               |
| AW-11 | Agent computers                 | Draft | Merged      | #2411, #2417, #2437 | P1 merged (#2411 backend, #2417 web and node); P2 take-over half merged (#2437); P2 teach half and P3 not started      |
| AW-12 | Chat & channels                 | Draft | Merged      | #2423, #2427        | P1 merged in both halves: backend (#2423) and web (#2427); P2 and P3 not started                                       |
| AW-13 | Attention controls              | Draft | Merged      | #2439               | P1 merged (#2439); P2 and P3 not started                                                                               |
| AW-14 | What's new                      | Draft | Merged      | #2416               | P1 merged (#2416); P2 and P3 not started                                                                               |
| AW-15 | Connections, scopes & vault     | Draft | Merged      | #2421               | P1 merged (#2421); P2, P3 and P4 not started                                                                           |
| AW-16 | Models & tokens                 | Draft | In progress | #2431               | P1 backend merged (#2431); **P1.e web has not landed** — nothing from it is on `develop`; P2 and P3 not started        |
| AW-17 | Costs & caps                    | Draft | In progress | #2428               | P1 merged as far as the read side (#2428); **P1.7 web has not landed** — no meter card or price list is on `develop`   |
| AW-18 | Shared dashboards               | Draft | In progress | #2438               | P1 publish backend merged (#2438); **the P1 web half has not landed** — there is no shared-view page on `develop`      |
| AW-19 | Home                            | Draft | Merged      | #2436               | P1 merged (#2436); P2 and P3 not started                                                                               |
| AW-20 | Onboarding                      | Draft | Merged      | #2454               | P1 merged (#2454); P2 and P3 not started                                                                               |
| AW-21 | Capability catalogue            | Draft | Merged      | #2432               | P1 merged (#2432); P2 and P3 not started                                                                               |
| AW-22 | Backup & export                 | Draft | In progress | #2465, #2470, #2480 | P1 archive merged (#2465), hardened by #2470 and #2480; **the P1 web half has not landed**; P2 and P3 not started      |
| AW-23 | Agent identity                  | Draft | In progress | #2459               | P1.a–P1.c merged (#2459); **P1.d web has not landed** — no identity card or status dot is on `develop`                 |
| AW-24 | Safety rails                    | Draft | In progress | #2461               | P1.1–P1.7 merged (#2461); **P1.8 web has not landed** — no safety tab or trust-ladder screen is on `develop`           |
| AW-25 | Help centre                     | Draft | Merged      | #2435               | P1 merged (#2435); P2 and P3 not started                                                                               |

### How to read the Impl cell

- The phase names are the ones the epic's own `tasks.md` uses. Every epic has P1, P2 and P3;
  AW-15 also has a P4.
- Where one phase ships in more than one pull request (AW-06, AW-11, AW-12), the cell reports the
  least-advanced part: an epic reads `Merged` only when every pull request the landed phase needs is
  on `develop`, and `PR open` while any part of it is still open.
- The six `In progress` rows are that rule applied to a phase that shipped its backend and stopped.
  Each of those pull requests changed **no file under `apps/web`** at all, while its epic's P1
  carries a Web section (AW-16 P1.e, AW-17 P1.7, AW-18 Phase 1 → Web, AW-22 T-31/T-42/T-43,
  AW-23 P1.d, AW-24 P1.8). None of the components those sections name is present on `develop`
  under any name, and no pull request is open to add them. Contrast the epics that do read
  `Merged`: each has its feature's web surface on `develop` — 15 files for AW-01, 11 for AW-14,
  8 for AW-25 — so the gap above is a real absence, not a renaming.
- No epic reads `Verified`, and none can. The legend defines `Verified` as e2e green on `develop`,
  but `.github/workflows/e2e.yml` is stage-only by an owner decision of 2026-07-30: there is
  deliberately no `pull_request` trigger and no `develop` push trigger. #2455 repaired the specs
  and merged on 2026-09-17; it did not make the gate green — every **E2E Tests** run since
  2026-09-18 has failed, the latest on 2026-09-21. Either the axis needs a definition the pipeline
  can satisfy (green on `stage`), or it stays permanently unreachable. That is an owner decision,
  so this refresh leaves the legend alone.

### Program-wide work

- **#2403** — the program scaffolding, all 25 epic specs and this tracker. Merged.
- **#2455** — repairs the Agent Workspace end-to-end specs. Merged 2026-09-17. It spans the merged
  epics rather than belonging to any one of them, so it has no row above. See the note on `Verified`:
  the suite still fails on `stage`.

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
