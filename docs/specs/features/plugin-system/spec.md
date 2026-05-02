# Feature Specification: Plugin System

**Feature ID**: `plugin-system`
**Status**: `Retrospective`
**Created**: 2026-05-01
**Last updated**: 2026-05-01
**Owner**: Ever Works Team

---

## 1. Overview

The plugin system is the platform's mechanism for adding external
integrations — AI providers, search engines, screenshot services, content
extractors, deployment targets, git providers, pipeline generators, prompt
managers — without touching core code. Each plugin is a standalone
`packages/plugins/<id>/` workspace that declares its metadata and
capabilities. The platform discovers plugins at startup, loads their
settings schemas, and routes capability requests to active plugins through
**facades** that respect a three-tier settings cascade (work → user → admin).

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** I install the platform fresh, **when** the API boots, **then**
  all 39 packaged plugins are discovered, loaded, and visible in the
  plugin registry.
- **Given** I configure OpenAI as my AI provider for work A and
  Anthropic for work B, **when** each work generates content,
  **then** the corresponding provider is used — they never cross over.
- **Given** I configure an AI provider at the user level and override it
  at work level, **when** that work runs, **then** the
  work-level setting wins.
- **Given** a plugin author wants to add a new AI provider, **when** they
  scaffold a new package under `packages/plugins/<their-id>/`, declare
  `everworks.plugin` metadata, and implement the AI capability interface,
  **then** the plugin is auto-discovered on the next boot.

### 2.2 Edge cases & failures

- **Given** a plugin's settings schema is invalid JSON Schema, **when** the
  platform loads it, **then** the plugin is marked as failed-to-load and
  excluded from capability resolution; the API logs the error with the
  plugin id.
- **Given** a plugin's API key is missing for a work that selects it,
  **when** generation runs, **then** the run fails with a clear
  "missing credentials" error referencing the plugin's settings UI.
- **Given** I disable a plugin globally, **when** any work tries to
  use it, **then** the resolver falls back to the configured default
  (or fails with "no default available") rather than silently using the
  disabled plugin.

## 3. Functional Requirements

- **FR-1** Each plugin MUST be a standalone npm package under
  `packages/plugins/<id>/` with `everworks.plugin` metadata in its
  `package.json` declaring `id`, `name`, `version`, `category`,
  `capabilities`, and `description`.
- **FR-2** The platform MUST auto-discover plugins at startup by scanning
  `packages/plugins/*/package.json`.
- **FR-3** The platform MUST expose **15 capability interfaces** in
  `@ever-works/plugin/<capability>/`: `ai-provider`, `search`,
  `git-provider`, `deployment`, `screenshot`, `content-extractor`,
  `data-source`, `oauth`, `pipeline`, `form-schema-provider`,
  `prompt-provider`, plus internal helpers.
- **FR-4** The platform MUST resolve capability requests via facades
  (`AiFacadeService`, `GitFacadeService`, etc.) that consult the
  three-tier settings cascade: work → user → admin.
- **FR-5** Plugin settings MUST be defined as JSON Schema with custom
  extensions: `x-secret`, `x-widget`, `x-envVar`.
- **FR-6** Settings flagged `x-secret: true` MUST be encrypted at rest and
  MUST NOT be returned in any API response or activity-log entry
  (Constitution VII).
- **FR-7** Settings flagged `x-envVar: <NAME>` MUST also be readable from
  the corresponding environment variable as a fallback.
- **FR-8** Configuration modes MUST be supported: `admin-only`,
  `user-required`, `hybrid`. The mode determines who can configure the
  plugin and whether the platform supplies a default value.
- **FR-9** A plugin MUST be able to advertise multiple capabilities (e.g.
  Tavily provides both `search` and `content-extractor`); the resolver
  MUST handle multi-capability plugins correctly.
- **FR-10** The platform MUST ship 39 first-party plugins on `develop` (see
  canonical
  [built-in-plugins.md](../../../plugin-system/built-in-plugins.md)).

## 4. Non-Functional Requirements

- **Performance**: plugin discovery + settings schema load happen at boot;
  capability resolution is in-memory after the first lookup per request.
- **Reliability**: a single plugin failing to load MUST NOT prevent the
  rest of the system from starting.
- **Security**: secret fields are encrypted; never logged; redacted in
  error messages.
- **Observability**: plugin load failures emit warning logs with plugin id
    - reason; capability resolution failures emit error logs with the
      requested capability + scope.
- **Compatibility**: plugin SDK is versioned (`@ever-works/plugin@1.x`);
  breaking changes ship under a new major version.

## 5. Key Entities & Domain Concepts

| Entity / concept            | Description                                                             |
| --------------------------- | ----------------------------------------------------------------------- |
| `IPlugin`                   | The minimum contract every plugin implements                            |
| Capability interface        | Per-category contract (e.g. `IAiProvider`, `ISearchProvider`)           |
| Capability                  | A specific function: `ai-provider`, `search`, `screenshot`, etc.        |
| Configuration mode          | `admin-only` / `user-required` / `hybrid`                               |
| Plugin metadata block       | The `everworks.plugin` section of `package.json`                        |
| Settings schema             | JSON Schema with `x-secret`, `x-widget`, `x-envVar` extensions          |
| Plugin context              | Logger, cache, HTTP client, events, settings access — passed at runtime |
| Three-tier settings cascade | work → user → admin                                                |
| Facade                      | Capability-aware resolver/router (e.g. `AiFacadeService`)               |
| Default plugin              | Per-capability fallback when no scope override is set                   |

## 6. Out of Scope

- Hot-reloading plugins at runtime (require platform restart).
- Sandboxing plugins in a separate process (plugins run in the API
  process; trust is operational).
- Third-party plugin marketplace (only first-party plugins on `develop`).

## 7. Acceptance Criteria

- [x] All 39 packaged plugins are discovered on boot.
- [x] Each plugin builds with `tsup` and tests with `vitest`.
- [x] Three-tier settings cascade resolves correctly in unit tests.
- [x] `x-secret` fields are stripped from API responses (regression test).
- [x] Multi-capability plugins (e.g. Tavily) are resolved for each declared
      capability.
- [x] Plugin load failures don't crash the API.

## 8. Open Questions

- `[NEEDS CLARIFICATION: third-party plugin distribution model — npm
registry, embedded package, dynamic install?]`

## 9. Constitution Gates

- [x] **I**: this feature **is** the embodiment of Principle I.
- [x] **II**: this feature **is** the embodiment of Principle II.
- [x] **III**: plugins read/write to user repos, not the database.
- [x] **IV**: pipeline plugins (Trigger.dev-driven) wire into the cron
      infrastructure.
- [x] **V**: plugin settings stored via existing `plugin_settings` and
      `cache_entries` tables — no new schema required.
- [x] **VI**: every plugin has its own vitest suite plus integration tests
      in `packages/plugin/__tests__/`.
- [x] **VII**: `x-secret` is the canonical mechanism for secret hygiene.
- [x] **VIII**: `built-in-plugins.md` is the single source of truth for
      counts/lists.
- [x] **IX**: this spec describes user-observable behaviour.
- [x] **X**: SDK is versioned; breaking changes go to new major versions.

## 10. References

- User-facing docs: [`../../../plugin-system/`](../../../plugin-system/)
- Plugin SDK: `packages/plugin/`
- Plugin packages: `packages/plugins/`
- Constitution: [`.specify/memory/constitution.md`](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md)
- Canonical plugin list:
  [`../../../plugin-system/built-in-plugins.md`](../../../plugin-system/built-in-plugins.md)
