# Task Breakdown: Work Changelog

**Feature ID**: `work-changelog`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-01

---

## Phase 1 — Schema

- [x] T1. Add `activityType` + `changelog` columns to
      `work_generation_history` (additive migration).

## Phase 2 — Service

- [x] T2. `ActivityLogService` builders for each activity type.
- [x] T3. Pipeline finalisation hook records added/updated/removed items.
- [x] T4. Manual mutation hooks (item add/update/remove, taxonomy
      changes, comparison add/remove) record their entries.
- [x] T5. Community PR processor records `community_pr_merged`.

## Phase 3 — API

- [x] T6. `GET /api/works/:id/history` with pagination + filter.
- [x] T7. Server-side filter-group mapping.

## Phase 4 — Web

- [x] T8. History tab with pagination.
- [x] T9. Activity-type filter chips.
- [x] T10. Expandable entry details grouped by Added/Updated/Removed.

## Phase 5 — Tests

- [x] T11. Per-activity-type service tests.
- [x] T12. RECREATE flow records removed items.
- [x] T13. Pagination + filter integration tests.

## Phase 6 — Docs

- [x] T14. User-facing doc `docs/features/work-changelog.md`.
- [x] T15. UI behaviour doc `docs/web-dashboard/history-ui.md`.
- [x] T16. Retrospective spec/plan/tasks.

## Definition of Done

- [x] All tasks shipped, tests pass, docs present, constitution gates verified.
