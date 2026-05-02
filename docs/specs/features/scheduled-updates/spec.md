# Feature Specification: Scheduled Directory Updates

**Feature ID**: `scheduled-updates`
**Status**: `Retrospective`
**Created**: 2026-05-01
**Last updated**: 2026-05-01
**Owner**: Ever Works Team

---

## 1. Overview

A directory can be configured to re-run its generation pipeline on a
recurring cadence (hourly through monthly, plus the every-N-hours variants).
The platform handles fan-out via a Trigger.dev cron task, atomic per-schedule
claiming via a single SQL `UPDATE`, drift correction via a `scheduledFor`
anchor, retry-on-failure with exponential pause, and zombie recovery.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** I enable "weekly" scheduled updates on my directory, **when**
  a week passes since my last generation, **then** the platform
  automatically runs a fresh generation and I see the new result on the
  directory page.
- **Given** my schedule is `active`, **when** I click "Run Now", **then**
  a generation starts immediately without resetting my upcoming weekly
  slot.
- **Given** my schedule failed three times in a row, **when** the
  `maxFailureBeforePause` threshold is hit, **then** the schedule is
  auto-paused and I get a notification.
- **Given** my schedule is `paused`, **when** I re-enable it, **then**
  `nextRunAt` is recomputed and the schedule resumes on the next cron
  tick.

### 2.2 Edge cases & failures

- **Given** the dispatcher tick is slow and overlaps with the next tick,
  **when** both tries to claim the same due schedule, **then** exactly
  one succeeds and the other records `outcome: skipped`.
- **Given** a generation crashes without finalising, **when** the next
  dispatcher tick runs, **then** the schedule is detected as zombie
  (over `getScheduleStuckTimeoutMinutes` old in `GENERATING`) and
  flipped to `ERROR` so it becomes eligible again.
- **Given** my plan doesn't include the cadence I want, **when** I select
  `billingMode: usage`, **then** the platform allows the cadence on
  pay-per-use billing.
- **Given** my directory was deleted between the dispatcher's "find due"
  query and the actual dispatch, **when** the dispatch tries to run,
  **then** the outcome is `skipped` with reason `directory_not_found`.

## 3. Functional Requirements

- **FR-1** The system MUST expose `GET / PUT / DELETE / POST run` endpoints
  under `/api/directories/:id/schedule` for managing a directory's
  schedule.
- **FR-2** The system MUST accept all seven cadence values: `hourly`,
  `every_3_hours`, `every_8_hours`, `every_12_hours`, `daily`, `weekly`,
  `monthly`.
- **FR-3** The system MUST run a Trigger.dev cron task at
  `*/N * * * *` where `N = config.subscriptions.getDispatchIntervalMinutes()`.
- **FR-4** The dispatcher MUST claim each due schedule using a single
  atomic SQL `UPDATE … SET nextRunAt = NULL WHERE id = X AND status = ACTIVE
AND nextRunAt IS NOT NULL`. The first updater wins; the loser sees
  `affected = 0` and reports `outcome: skipped`.
- **FR-5** The dispatcher MUST preserve the original `nextRunAt` into
  `scheduledFor` at claim time and use it as the anchor for computing
  the next `nextRunAt` after completion (drift correction).
- **FR-6** The dispatcher MUST detect zombie schedules (status `GENERATING`
  older than `getScheduleStuckTimeoutMinutes`, default 60 min) and flip
  them to `ERROR` before claiming new work.
- **FR-7** The dispatcher MUST process schedules sequentially (not in
  parallel) within a single tick, capped by
  `config.subscriptions.getMaxBatch()`.
- **FR-8** The dispatcher MUST return a `DirectoryScheduleDispatchSummary`
  with `dueCount`, `dispatched`, `skipped`, `failed` counts and a per-
  entry breakdown including outcome and reason.
- **FR-9** On failure, the schedule's `failureCount` MUST increment; when
  it reaches `maxFailureBeforePause`, the schedule MUST be auto-paused
  and a notification sent.
- **FR-10** "Run Now" requests that fire before the next scheduled slot
  MUST preserve the existing `nextRunAt` (no schedule drift from manual
  runs).
- **FR-11** The system MUST support per-schedule `providerOverrides` for
  `ai`, `search`, `screenshot`, `contentExtractor`, `pipeline` plugin ids;
  each override MUST reference an installed plugin.
- **FR-12** The system MUST track per-schedule `billingMode` (`subscription`
  or `usage`); `usage` mode MUST allow cadences not included in the user's
  plan.

## 4. Non-Functional Requirements

- **Performance**: dispatcher tick completes within the cron interval
  (`getDispatchIntervalMinutes()`) at typical load; a single tick handles
  `getMaxBatch()` directories.
- **Reliability**: at-most-once dispatch per `nextRunAt` slot, even with
  overlapping ticks; multi-worker safe via the SQL CAS pattern.
- **Security & privacy**: schedule endpoints require directory edit rights;
  all cron tasks run server-side with elevated DB access.
- **Observability**: per-tick summary returned to Trigger.dev (visible in
  its dashboard); auto-pause emits a notification.
- **Compatibility**: cadence enum is additive; new cadences can be added
  without breaking existing schedules.

## 5. Key Entities & Domain Concepts

| Entity / concept                   | Description                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `DirectorySchedule`                | Per-directory schedule row: cadence, status, nextRunAt, scheduledFor, billingMode |
| `DirectoryScheduleStatus`          | Enum: `disabled` / `active` / `paused` / `canceled`                               |
| `DirectoryScheduleCadence`         | Enum: 7 values from hourly to monthly                                             |
| `DirectoryScheduleBillingMode`     | Enum: `subscription` / `usage`                                                    |
| `DirectoryScheduleDispatchSummary` | Trigger.dev task return value with counts + per-entry outcomes                    |
| `scheduledFor` (anchor)            | The original `nextRunAt` preserved at claim time; drift-correction reference      |

## 6. Out of Scope

- Custom cron expressions (only the seven canonical cadences are exposed).
- Schedule chaining (schedule A finishes → trigger schedule B).
- Per-step scheduling (the schedule fans out to a full generation, not
  individual pipeline steps).

## 7. Acceptance Criteria

- [x] All seven cadence values are accepted by the API.
- [x] Concurrent dispatchers cannot both claim the same schedule (CAS
      integration test).
- [x] Drift is bounded — a schedule that fires 90 s late stays anchored on
      its original slot.
- [x] Zombie recovery flips stuck schedules to ERROR after the configured
      timeout.
- [x] Auto-pause kicks in after `maxFailureBeforePause` consecutive failures.
- [x] "Run Now" before the next slot preserves the slot.
- [x] Provider overrides validate plugin ids against the registry.
- [x] `usage` billing mode allows cadences outside plan limits.

## 8. Open Questions

_None on develop._

## 9. Constitution Gates

- [x] **I**: N/A.
- [x] **II**: provider overrides are capability-keyed, not plugin-internal.
- [x] **III**: schedules don't replicate user content into the database;
      they reference the user's repo.
- [x] **IV**: dispatcher runs as a Trigger.dev `schedules.task` — the
      canonical example.
- [x] **V**: cadence enum extensions ship as additive migrations; the
      introduction of `scheduledFor` was a forward migration with default
      `null`.
- [x] **VI**: covered by repository spec, dispatcher spec, scheduling
      service spec, integration tests (`schedule.repository.spec.ts`,
      `directory-schedule-dispatcher.spec.ts`, `directory-schedule.service.spec.ts`).
- [x] **VII**: schedule rows do not store secrets.
- [x] **VIII**: N/A.
- [x] **IX**: this spec describes user-observable behaviour.
- [x] **X**: cadence enum and status enum are additive.

## 10. References

- User-facing doc: [`../../../features/scheduled-updates.md`](../../../features/scheduled-updates.md)
- Internal architecture:
  [`../../../agent-services/directory-schedule-dispatcher.md`](../../../agent-services/directory-schedule-dispatcher.md)
- Implementation:
    - `packages/agent/src/services/directory-schedule.service.ts`
    - `packages/agent/src/services/directory-schedule-dispatcher.service.ts`
    - `packages/agent/src/database/repositories/directory-schedule.repository.ts`
    - `packages/tasks/src/tasks/trigger/directory-schedule-dispatcher.task.ts`
- Related: [`works-config/spec.md`](../works-config/spec.md) (schedule
  cadence is mirrored to `works.yml`)
