# Task Breakdown: Plugin System

**Feature ID**: `plugin-system`
**Status**: `Done` (Retrospective; ongoing as new plugins ship)
**Last updated**: 2026-05-01

---

## Phase 1 — SDK foundation

- [x] T1. `@ever-works/plugin` package skeleton.
- [x] T2. `IPlugin` + `BasePlugin` abstract.
- [x] T3. Capability interfaces under `src/<capability>/`.
- [x] T4. JSON Schema extensions: `x-secret`, `x-widget`, `x-envVar`.
- [x] T5. `AiOperations` LangChain wrapper.

## Phase 2 — Discovery + registry

- [x] T6. Static plugin discovery at boot (`packages/plugins/*`).
- [x] T7. Plugin registry service with capability index.
- [x] T8. Per-plugin settings schema validator.

## Phase 3 — Settings store + cascade

- [x] T9. `plugin_settings` table + encryption.
- [x] T10. Three-tier resolver: directory → user → admin.
- [x] T11. Secret redaction helpers + tests.

## Phase 4 — Facades

- [x] T12. `AiFacadeService`, `GitFacadeService`, `SearchFacadeService`,
      `DeployFacadeService`, `ScreenshotFacadeService`,
      `ContentExtractorFacadeService`.

## Phase 5 — First-party plugins

- [x] T13. Ship 39 first-party plugins under `packages/plugins/<id>/`.
- [x] T14. Each plugin has `everworks.plugin` metadata, JSON Schema
      settings, and at least one test.
- [x] T15. Each plugin is documented in
      `docs/plugin-system/<id>-plugin.md` and listed in `built-in-plugins.md`.

## Phase 6 — API + UI

- [x] T16. `/api/plugins/*` REST endpoints.
- [x] T17. Plugin settings UI rendered from JSON Schema.
- [x] T18. CLI `plugin` commands.

## Phase 7 — Docs

- [x] T19. `docs/plugin-system/` architecture guide.
- [x] T20. Per-plugin individual doc pages.
- [x] T21. Retrospective spec/plan/tasks.

## Ongoing

- New plugin → follow the
  [`creating-a-plugin`](../../../plugin-system/creating-a-plugin.md) guide,
  add to canonical `built-in-plugins.md`, add sidebar entry.

## Definition of Done

- [x] All 39 first-party plugins discovered and operational.
- [x] Three-tier cascade verified by tests.
- [x] Secret hygiene verified by redaction integration tests.
- [x] Constitution Principles I, II, VII, VIII, X all satisfied.
