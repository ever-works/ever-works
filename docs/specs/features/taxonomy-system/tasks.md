# Task Breakdown: Taxonomy System

**Feature ID**: `taxonomy-system`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-01

---

## Phase 1 — Service

- [x] T1. `DirectoryTaxonomyService` with categories CRUD.
- [x] T2. Tags CRUD on the same service.
- [x] T3. Collections CRUD on the same service.
- [x] T4. `slugifyText()` shared util used everywhere.
- [x] T5. Case-insensitive duplicate-name guard.
- [x] T6. Slug id immutability on update.

## Phase 2 — Storage

- [x] T7. YAML readers/writers for `categories.yml`, `tags.yml`,
      `collections.yml`.
- [x] T8. Item YAML references by slug id.

## Phase 3 — Access control

- [x] T9. Wire `DirectoryOwnershipService.ensureAccess` into reads.
- [x] T10. Wire `ensureCanEdit` into writes.

## Phase 4 — API

- [x] T11. Controller endpoints for all three entity types.
- [x] T12. Combined `categories-tags` list endpoint (returns all three
      dimensions in one response).
- [x] T13. e2e tests for each endpoint and each role.

## Phase 5 — Pipeline integration

- [x] T14. Standard Pipeline categorization step routes through the
      taxonomy service.
- [x] T15. Tags deduplication / normalisation happens before persisting.

## Phase 6 — Web

- [x] T16. **Items → Categories / Tags / Collections** tabs.
- [x] T17. CRUD modals.

## Phase 7 — Observability

- [x] T18. `category_change`, `tag_change`, `collection_change` emit
      Directory Changelog entries.

## Phase 8 — Docs

- [x] T19. User-facing doc `docs/features/taxonomy-system.md`.
- [x] T20. Cross-link from `collections.md` and `directory-changelog.md`.
- [x] T21. Retrospective spec/plan/tasks.

## Definition of Done

- [x] All tasks shipped, tests pass, docs present, constitution gates verified.
