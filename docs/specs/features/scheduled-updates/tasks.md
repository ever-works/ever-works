# Task Breakdown: Scheduled Work Updates

**Feature ID**: `scheduled-updates`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-01

---

## Phase 1 — Schema & contracts

- [x] T1. `WorkSchedule` entity, repository, contracts DTO.
- [x] T2. Migrations: initial table, cadence enum additions, `scheduledFor`,
      `providerOverrides`.

## Phase 2 — Service

- [x] T3. `WorkScheduleService` (CRUD + state transitions).
- [x] T4. `WorkScheduleRepository.tryMarkDispatched` — CAS claim.
- [x] T5. `WorkScheduleDispatcherService.dispatchDue`.
- [x] T6. Drift correction (`scheduledFor` anchor + `resolveAnchorDate`).
- [x] T7. Zombie recovery (`recoverStuckSchedules`).
- [x] T8. Auto-pause + notification.
- [x] T9. Run-now slot preservation (`isManualRunAheadOfSchedule`).

## Phase 3 — Trigger.dev

- [x] T10. `workScheduleDispatcherTask` (`schedules.task`) at
      `packages/tasks/src/tasks/trigger/work-schedule-dispatcher.task.ts`.

## Phase 4 — API

- [x] T11. Schedule controller endpoints (GET / PUT / DELETE / POST run).
- [x] T12. Schedule e2e tests.

## Phase 5 — Web / CLI

- [x] T13. Schedule UI on work detail page.
- [x] T14. CLI `work schedule` commands.

## Phase 6 — Docs

- [x] T15. User-facing doc `docs/features/scheduled-updates.md`.
- [x] T16. Architectural deep-dive
      `docs/agent-services/work-schedule-dispatcher.md`.
- [x] T17. Retrospective spec/plan/tasks.

## Definition of Done

- [x] All tasks shipped, tests pass, docs present, constitution gates verified.
