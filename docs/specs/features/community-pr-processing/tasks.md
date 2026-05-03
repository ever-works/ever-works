# Task Breakdown: Community PR Processing

**Feature ID**: `community-pr-processing`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-01

---

## Phase 1 — Schema

- [x] T1. Add `communityPrState` jsonb column to `works` (additive
      migration).

## Phase 2 — Service

- [x] T2. `CommunityPrProcessorService.processWork` with per-
      work `runExclusive` lock.
- [x] T3. PR listing + skip-already-processed logic.
- [x] T4. AI extraction via `AiFacadeService`.
- [x] T5. Schema validation + comment-on-failure path.
- [x] T6. Merge / close / comment branching.
- [x] T7. Incremental `communityPrState` persistence.

## Phase 3 — API + cron

- [x] T8. Manual trigger endpoint.
- [x] T9. Trigger.dev cron task fanning out per work.

## Phase 4 — Web / CLI

- [x] T10. "Process community PRs" UI control.
- [x] T11. CLI command wrapping the trigger endpoint.

## Phase 5 — Docs

- [x] T12. User-facing doc `docs/features/community-pr-processing.md`.
- [x] T13. Architectural doc `docs/agent-services/community-pr-service.md`.
- [x] T14. Retrospective spec/plan/tasks.

## Definition of Done

- [x] All tasks shipped, tests pass, docs present, constitution gates verified.
