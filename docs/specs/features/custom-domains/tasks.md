# Task Breakdown: Custom Domains

**Feature ID**: `custom-domains`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-01

---

## Phase 1 — Schema & contracts

- [x] T1. `CustomDomain` entity + migration.
- [x] T2. DTOs for add / verify / list responses.

## Phase 2 — Service & facade

- [x] T3. `CustomDomainService` with CRUD + auto-promote.
- [x] T4. `DeployFacadeService.addDomain / removeDomain / verifyDomain`.
- [x] T5. Vercel plugin implementation of the deploy capability domain
      methods.

## Phase 3 — API

- [x] T6. Controller endpoints under
      `apps/api/src/plugins-capabilities/deploy/`.
- [x] T7. Edit-permission guard.
- [x] T8. e2e tests for add / verify / remove paths.

## Phase 4 — Web

- [x] T9. **Settings → Domains** UI.
- [x] T10. Per-domain DNS instruction display.
- [x] T11. Verification trigger button + status indicator.

## Phase 5 — CLI

- [x] T12. `ever-works work domain` commands.

## Phase 6 — Docs

- [x] T13. User-facing doc `docs/features/custom-domains.md`.
- [x] T14. Retrospective spec/plan/tasks.

## Definition of Done

- [x] All tasks shipped, tests pass, docs present, constitution gates verified.
