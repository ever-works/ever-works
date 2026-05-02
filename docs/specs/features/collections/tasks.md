# Task Breakdown: Collections

**Feature ID**: `collections`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-01

---

## Phase 1 — Service

- [x] T1. Add `Collection` shape to taxonomy types in `@ever-works/contracts`.
- [x] T2. Extend `DirectoryTaxonomyService` with `getCollections / createCollection / updateCollection / deleteCollection`.
- [x] T3. Slug generation + duplicate-name guard.
- [x] T4. Delete cleanup: clear `collection` field on all referencing items.

## Phase 2 — Pipeline integration

- [x] T5. `generate_collections` toggle on Standard Pipeline plugin settings.
- [x] T6. Categorization step assigns collections when toggle is on.

## Phase 3 — API

- [x] T7. Controller endpoints in `apps/api/src/directories/`.
- [x] T8. Include collections in the `categories-tags` list endpoint.
- [x] T9. e2e tests covering CRUD + delete cascade.

## Phase 4 — Web

- [x] T10. **Items → Collections** tab UI.
- [x] T11. Website-settings toggle for `collections_enabled`.

## Phase 5 — Storage

- [x] T12. Reader/writer for `collections.yml` in the data repo.
- [x] T13. Items YAML includes optional `collection` field.

## Phase 6 — Docs

- [x] T14. User-facing doc `docs/features/collections.md`.
- [x] T15. Cross-link from `taxonomy-system.md`.
- [x] T16. Retrospective spec/plan/tasks.

## Definition of Done

- [x] All tasks shipped, tests pass, docs present, constitution gates verified.
