# Task Breakdown: Work Members

**Feature ID**: `work-members`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-01

---

## Phase 1 — Schema

- [x] T1. `WorkMembership` entity + migration.

## Phase 2 — Service

- [x] T2. `WorkMembersService` with CRUD + leave.
- [x] T3. `WorkOwnershipService.ensureCanRead / ensureCanEdit /
ensureCanManage` helpers.
- [x] T4. Email lookup + duplicate-membership guard.
- [x] T5. Owner-cannot-leave guard.

## Phase 3 — API

- [x] T6. Members controller with the six endpoints.
- [x] T7. e2e tests for every permission-matrix cell.

## Phase 4 — Notifications

- [x] T8. Invite email template + mail facade dispatch.

## Phase 5 — Web

- [x] T9. **Settings → Members** UI.
- [x] T10. Invite modal with role picker.
- [x] T11. Permission matrix table on the page itself.

## Phase 6 — Docs

- [x] T12. User-facing doc `docs/features/work-members.md`.
- [x] T13. Retrospective spec/plan/tasks.

## Definition of Done

- [x] All tasks shipped, tests pass, docs present, constitution gates verified.
