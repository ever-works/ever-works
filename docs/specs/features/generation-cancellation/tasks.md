# Task Breakdown: Generation Cancellation

**Feature ID**: `generation-cancellation`
**Plan**: `./plan.md`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-01

---

Retrospective task list — all items shipped via PR #383.

## Phase 1 — Contracts

- [x] **T1**. Add `CANCELLED` to `GenerateStatusType` enum in
      `packages/contracts/src/api/directory/generate-status.enum.ts`.
- [x] **T2**. Forward migration adjusting any DB check constraints that
      enumerated allowed status values.

## Phase 2 — Service

- [x] **T3**. `cancelGeneration(directoryId, user)` on
      `DirectoryGenerationService` with mode routing.
- [x] **T4**. Plumbing for in-process AbortController in the pipeline
      executor — signals cancellation between steps.
- [x] **T5**. `markCancelled` helper that closes the in-progress
      `GenerationHistory` row and updates directory status.

## Phase 3 — API

- [x] **T6**. `POST /api/directories/:id/cancel-generation` controller
      method with `@HttpCode(202)` and Swagger docs.
- [x] **T7**. e2e test in `apps/api/test/` covering all four modes.

## Phase 4 — Web

- [x] **T8**. Cancel control on the directory detail page.
- [x] **T9**. Cancel control on the activity views for in-progress runs.

## Phase 5 — Docs

- [x] **T10**. User-facing doc at
      `docs/features/generation-cancellation.md`.
- [x] **T11**. Updates to `directory-lifecycle.md` describing the new
      terminal state.

## Definition of Done

- [x] All tasks shipped.
- [x] Tests pass.
- [x] User-facing doc present.
- [x] Constitution gates verified.
