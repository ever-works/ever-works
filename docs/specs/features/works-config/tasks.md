# Task Breakdown: `works.yml` Source-Controlled Work Configuration

**Feature ID**: `works-config`
**Plan**: `./plan.md`
**Status**: `Done` (Retrospective — feature shipped via PR #395)
**Last updated**: 2026-05-01

---

This is a retrospective task list — every task below has already shipped.
It is preserved as the audit trail for the feature and as a template for
similar future work.

## Phase 1 — Service layer

- [x] **T1**. `WorksConfigService` with `loadFromRepository` (multi-path
      fallback) and `parse` (alias-aware).
- [x] **T2**. `WorksConfigWriterService` with `writeToDataRepository` and
      raw-field preservation.
- [x] **T3**. `WorksConfigImportPlannerService` for pre-import dry-run
      validation.
- [x] **T4**. `WorksConfigImportApplierService` for atomic application of
      parsed config to the work entity.
- [x] **T5**. `WorksConfigRestoreService` for re-reading the file when the
      user requests a config refresh.

## Phase 2 — Tests

- [x] **T6**. `works-config-data.spec.ts` — `mergeWorksConfigIntoDataConfig`
      covering metadata enrichment.
- [x] **T7**. `works-config.service.spec.ts` — parse / load /
      repository-reference parsing / cadence normalization.
- [x] **T8**. `works-config-writer.service.spec.ts` — round-trip preservation,
      field clearing, schedule object emission.
- [x] **T9**. `works-config-import-planner.service.spec.ts` — plugin id
      validation, error cases.

## Phase 3 — Integration

- [x] **T10**. Import flow reads `works.yml` and pre-fills the import form.
- [x] **T11**. Work generation pipeline calls the writer at the end of
      a successful run.
- [x] **T12**. Activity log entries cover parse failures, plugin-id
      failures, and sync failures.

## Phase 4 — Docs

- [x] **T13**. User-facing doc at `docs/features/works-config.md`.
- [x] **T14**. Cross-link from `docs/features/index.md` and the sidebar.
- [x] **T15**. Retrospective Spec Kit spec/plan/tasks (this work).

## Definition of Done

- [x] All tasks shipped.
- [x] Tests pass in CI.
- [x] User-facing doc present and linked.
- [x] Retrospective spec/plan/tasks present and reviewed.
- [x] Constitution gates verified — see `spec.md` §9.
