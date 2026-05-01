# Task Breakdown: Item Source Validation

**Feature ID**: `item-source-validation`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-01

---

## Phase 1 — Schema

- [x] T1. Item YAML `source_validation` blob shape defined in contracts.
- [x] T2. Migration: add `sourceValidationCadence` to
      `directory_schedules` (nullable additive).

## Phase 2 — Services

- [x] T3. Deterministic reachability checker.
- [x] T4. Content-extraction wrapper.
- [x] T5. AI accuracy evaluator with structured output.
- [x] T6. `ItemSourceValidationService.checkItem(directoryId, slug)`
      that orchestrates the three steps and persists the blob.

## Phase 3 — Integration

- [x] T7. Post-generation hook: validate every item after a successful
      run.
- [x] T8. `ItemSourceValidationSchedulerService` Trigger.dev cron task
      using the directory's cadence.
- [x] T9. Manual re-check endpoint with short-window cache.
- [x] T10. Apply-suggestion writes `source_url` and re-validates.

## Phase 4 — Web

- [x] T11. Items UI status indicator (warning vs persistent text).
- [x] T12. Action menu: Re-check source, Apply suggestion.
- [x] T13. Schedule UI exposes `sourceValidationCadence`.

## Phase 5 — Tests

- [x] T14. Reachability mapping (404/410 → broken; 5xx → unknown).
- [x] T15. End-to-end validate-item with AI mock.
- [x] T16. Cadence selection (own vs fallback).

## Phase 6 — Docs

- [x] T17. User-facing doc `docs/features/item-source-validation.md`.
- [x] T18. Cross-link in `scheduled-updates.md`.
- [x] T19. Retrospective spec/plan/tasks.

## Definition of Done

- [x] All tasks shipped, tests pass, docs present, constitution gates verified.
