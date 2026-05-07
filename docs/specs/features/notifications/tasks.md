# Task Breakdown: Notifications

**Feature ID**: `notifications`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-08

---

## Phase 1 — Schema

- [x] T1. Add `notifications` entity + repository
      (`packages/agent/src/entities/notification.entity.ts`,
      `packages/agent/src/database/repositories/notification.repository.ts`).
- [x] T2. Add type / category enums
      (`packages/agent/src/entities/notification.types.ts`).
- [x] T3. Indexes: `(userId, createdAt desc)`,
      `(userId, isPersistent)`, partial unique on `(userId,
      deduplicationKey)`.

## Phase 2 — Service

- [x] T4. `NotificationService.create` w/ `deduplicationKey` short-circuit.
- [x] T5. Race-condition recovery on Postgres `23505` / MySQL `ER_DUP_ENTRY` / SQLite `SQLITE_CONSTRAINT`.
- [x] T6. List / unread-count / persistent / mark-as-read / dismiss methods.
- [x] T7. Producer convenience methods:
      `notifyAiCreditsDepleted`, `notifyAiProviderError`,
      `notifyGenerationAccountError`, `notifySchedulePaused`,
      `notifyGitAuthExpired`.
- [x] T8. `clearByDeduplicationKey` so producers can clear on resolve.
- [x] T9. `cleanup()` returning `{expired, dismissed, old}`.

## Phase 3 — API

- [x] T10. `NotificationsController` (6 endpoints) behind `AuthSessionGuard`.
- [x] T11. `Math.min(limit, 100)` cap on list endpoint.
- [x] T12. 400 on dismissing persistent notifications.
- [x] T13. Cross-user reject via `findByIdAndUserId`.

## Phase 4 — Background Jobs

- [x] T14. `NotificationCleanupService` cron worker.
- [x] T15. `DistributedTaskLockService.runExclusive('notifications:cleanup', …)` guard.
- [x] T16. Outer error swallow + log so a failed window does not wedge later runs.

## Phase 5 — Web / CLI

- [x] T17. Web: header bell + panel + persistent banner consume the API.
- [ ] T18. CLI: not in scope — CLI is for work / generator surface.

## Phase 6 — Tests

- [x] T19. `NotificationsController` unit tests (10) — limit cap, persistent refusal, cross-user reject.
- [x] T20. `NotificationCleanupService` unit tests (4) — happy path, locked branch, error swallow.
- [ ] T21. **Follow-up**: producer / cleanup integration tests in `packages/agent` (Jest) hitting the real repository against a Postgres test container. Currently only the API-side controller + cleanup worker are covered by unit tests — see [#490](https://github.com/ever-works/ever-works/pull/490).

## Phase 7 — Docs

- [x] T22. This Spec Kit folder (spec / plan / tasks).
- [ ] T23. **Follow-up**: user-facing doc at `docs/features/notifications.md`
      describing what shows up in the bell and how to clear it.

## Definition of Done

- [x] Service implemented; all controller endpoints behind auth guard.
- [x] Race-condition recovery and persistent-dismissal protections in place.
- [x] Cleanup cron lock-guarded and error-tolerant.
- [x] Unit tests cover the API surface.
- [x] Spec / plan / tasks documents authored.

## Follow-ups discovered

- **T21**: integration tests for producer dedup race against a real DB
  would catch any drift between in-process check and the partial-unique
  index. Currently only unit tests cover the dedup-recovery branch.
- **T23**: user-facing doc — bell icon, persistent banner behaviour,
  what categories exist, how to clear them.
- **Notification preferences UI** — if user feedback asks for muting
  by category or quiet hours, this is the spec to amend.
