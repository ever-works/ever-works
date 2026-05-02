# Task Breakdown: Data Management

**Feature ID**: `data-management`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-01

---

## Phase 1 — Export

- [x] T1. Per-directory aggregator service.
- [x] T2. Secret redactor based on plugin JSON schemas.
- [x] T3. `POST /api/account/export` controller.

## Phase 2 — Import preview

- [x] T4. Envelope validator + version check.
- [x] T5. Masked-secret detector.
- [x] T6. Missing-plugin detector.
- [x] T7. Slug conflict detector.
- [x] T8. `POST /api/account/import/preview` controller.

## Phase 3 — Import apply

- [x] T9. Per-directory transactional applier.
- [x] T10. `MASKED:` skipper with per-plugin warning.
- [x] T11. Three conflict strategies (skip / overwrite / rename).
- [x] T12. Data repo writer (clone, write, commit, push).

## Phase 4 — GitHub Sync

- [x] T13. Sync configuration store.
- [x] T14. Push: structured file writer with `path.basename` guard.
- [x] T15. Pull: structured file reader, payload reconstruction.
- [x] T16. Pull-secrets ignored unconditionally.
- [x] T17. Apply-pull reusing the import flow.

## Phase 5 — Web

- [x] T18. **Settings → Data** UI with three panels.
- [x] T19. Drag-and-drop import upload.
- [x] T20. Conflict-resolution UI.
- [x] T21. Toast notifications + warning display.

## Phase 6 — Tests

- [x] T22. Redactor edge cases (short values, non-string, nested).
- [x] T23. Masked detection across all settings shapes.
- [x] T24. Path-traversal attempts on push and pull.
- [x] T25. End-to-end roundtrip (export → import) preserves data.

## Phase 7 — Docs

- [x] T26. User-facing doc `docs/features/data-management.md`.
- [x] T27. Retrospective spec/plan/tasks.

## Definition of Done

- [x] All tasks shipped, tests pass, secret hygiene verified, docs present.
