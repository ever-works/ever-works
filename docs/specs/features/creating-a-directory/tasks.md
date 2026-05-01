# Task Breakdown: Creating a Directory

**Feature ID**: `creating-a-directory`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-01

---

## Phase 1 — Service / API

- [x] T1. `DirectoryGenerationService.createDirectory(method, dto, user)`
      handling all five flavours.
- [x] T2. Slug uniqueness check + `[a-z0-9-]` validation.
- [x] T3. Provider cascade resolver.
- [x] T4. Three-repo provisioning via `GitFacadeService`.
- [x] T5. Trigger.dev dispatch for AI/Awesome generations.

## Phase 2 — Plugin form-schema integration

- [x] T6. `form-schema-provider` capability used by pipelines.
- [x] T7. Server endpoint to fetch the form schema for a given pipeline id.

## Phase 3 — Web UI

- [x] T8. New Directory page with method picker.
- [x] T9. AI Creation form (name, prompt, advanced settings).
- [x] T10. Manual form (name, slug, description, owner).
- [x] T11. Import wizard (URL → analyze → configure → confirm).
- [x] T12. Dynamic plugin form-fields rendering.

## Phase 4 — CLI

- [x] T13. `ever-works directory create` command.

## Phase 5 — Tests

- [x] T14. Unit tests on the resolver cascade.
- [x] T15. e2e tests for each creation flavour.
- [x] T16. Playwright spec covering the wizard.

## Phase 6 — Docs

- [x] T17. User-facing doc `docs/features/creating-a-directory.md`.
- [x] T18. Cross-links to import + plugin system.
- [x] T19. Retrospective spec/plan/tasks.

## Definition of Done

- [x] All tasks shipped, tests pass, docs present, constitution gates verified.
