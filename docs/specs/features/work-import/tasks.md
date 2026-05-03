# Task Breakdown: Work Import

**Feature ID**: `work-import`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-01

---

## Phase 1 — Detection + parsing

- [x] T1. `parseRepositoryReference` (HTTPS / SSH / slug → RepositoryTarget).
- [x] T2. `WorksConfigImportPlanner` dry-run.
- [x] T3. `AwesomeListImportPlanner` Markdown AST traversal.

## Phase 2 — Application

- [x] T4. `WorksConfigImportApplier` for atomic application.
- [x] T5. Slug uniqueness check (case-insensitive).
- [x] T6. Plugin id validation against the registry.

## Phase 3 — API

- [x] T7. `POST /api/works/import/preview`.
- [x] T8. `POST /api/works/import`.
- [x] T9. e2e tests.

## Phase 4 — Web / CLI

- [x] T10. Import wizard UI.
- [x] T11. CLI `work import` command.

## Phase 5 — Background

- [x] T12. Trigger.dev fan-out for Awesome-List normalisation.

## Phase 6 — Docs

- [x] T13. User-facing doc `docs/features/work-import.md`.
- [x] T14. Cross-links in `works-config` spec.
- [x] T15. Retrospective spec/plan/tasks.

## Definition of Done

- [x] All tasks shipped, tests pass, docs present, constitution gates verified.
