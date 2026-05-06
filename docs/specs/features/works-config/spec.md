# Feature Specification: `works.yml` Source-Controlled Work Configuration

**Feature ID**: `works-config`
**Branch**: `feat/works-yml-onboarding` (merged via PR #395)
**Status**: `Retrospective`
**Created**: 2026-05-01
**Last updated**: 2026-05-01
**Owner**: Ever Works Team

---

## 1. Overview

Each work's generation configuration (name, prompt, model, providers,
website-repo target, schedule cadence) is mirrored to a YAML file in the
**data repository** so the configuration is portable, reviewable in PRs, and
the same across environments. The platform reads the file when importing an
existing repo and writes it back after every successful generation.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** I have an existing data repo with a hand-authored `works.yml`,
  **when** I import it into the platform, **then** the import flow is
  pre-filled with the values from the file (name, prompt, model, providers,
  schedule), so I don't need to re-enter them.
- **Given** I generate a work through the platform UI, **when**
  generation completes successfully, **then** a fresh `works.yml` is
  committed to the data repo capturing the work's current
  configuration.
- **Given** I edit `works.yml` directly in the data repo and trigger an
  import, **when** the import runs, **then** the updated values become the
  work's new config.
- **Given** I clear a field (model, prompt) in the platform UI, **when** the
  next generation runs, **then** the field is removed from `works.yml`
  rather than left as an empty value.

### 2.2 Edge cases & failures

- **Given** the data repo contains malformed YAML at one of the candidate
  paths, **when** the platform attempts to read it, **then** the import
  surfaces an `Invalid works config at <path>: <reason>` error and the
  user can fix and retry.
- **Given** `works.yml` references a plugin id that's not installed, **when**
  the import is confirmed, **then** the import fails with a clear "plugin
  not installed" error before any database writes happen.
- **Given** the data repo has unknown top-level fields in `works.yml`,
  **when** the platform writes back after generation, **then** unknown
  fields are preserved on round-trip.
- **Given** the post-generation sync fails (data repo unreachable, push
  rejected), **when** generation otherwise completes, **then** the sync
  failure is logged to the activity log but the generation result is still
  marked completed.

## 3. Functional Requirements

- **FR-1** The system MUST attempt to read `works.yml` from the data repo root.
- **FR-2** The system MUST parse a successfully-read `works.yml` into a
  typed config and surface its values in the import flow's UI fields.
- **FR-3** The system MUST validate plugin id references in
  `works.yml.providers.{ai,search,screenshot,contentExtractor,pipeline}`
  against the installed plugin registry before allowing import to complete.
- **FR-4** The system MUST accept aliased field names: `prompt` for
  `initial_prompt`, `title` for `name`, `websiteRepo` /
  `website_repository` / `websiteRepository` for `website_repo`,
  `content_extractor` for `contentExtractor`.
- **FR-5** The system MUST accept the schedule field as either a bare cadence
  string (`"weekly"`) or an object (`{enabled: true, cadence: "weekly"}`),
  plus alternate keys `frequency` / `interval`.
- **FR-6** The system MUST treat `schedule.enabled: false` as "no schedule".
- **FR-7** After every successful generation the system MUST write `works.yml`
  at the data-repository root capturing the work's current
  configuration.
- **FR-8** The writer MUST preserve unknown top-level fields present in the
  existing file.
- **FR-9** The writer MUST remove keys that have been explicitly cleared
  (e.g. clearing `model` in the UI removes the `model` key from the file
  rather than writing an empty value).
- **FR-10** Sync failures (write/push errors) MUST be logged to the activity
  log without failing the generation itself.
- **FR-11** The system MUST accept all seven canonical cadence values:
  `hourly`, `every_3_hours`, `every_8_hours`, `every_12_hours`, `daily`,
  `weekly`, `monthly`, plus the dash-separated forms (`every-3-hours`,
  etc.) for compatibility.
- **FR-12** Unrecognized cadences MUST resolve to "no schedule" (null) rather
  than throw.

## 4. Non-Functional Requirements

- **Performance**: parsing a `works.yml` is O(file size); the pre-fill step
  must not measurably slow the import flow (target ≤ 100 ms for files
  under 16 KB).
- **Reliability**: post-generation sync uses the same git facade used by the
  rest of the system; failures are surfaced in the activity log within
  one generation cycle.
- **Security & privacy**: `works.yml` is committed to the user's repo, so
  it MUST NOT contain secrets. Plugin **ids** are committed; plugin
  **credentials** never are.
- **Observability**: parse errors and sync failures appear in the activity
  log with action type `work_import` or `work_sync` and the
  failing field path / reason.
- **Compatibility**: schema is forward-compatible — unknown fields are
  preserved; alias fields ensure older hand-authored files keep working.

## 5. Key Entities & Domain Concepts

| Entity / concept      | Description                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `WorksConfigSummary`  | Lightweight projection used in the import flow's UI (name, prompt, model, schedule)          |
| `ParsedWorksConfig`   | Full parse result; includes the raw object for round-trip preservation                       |
| `ResolvedWorksConfig` | Same as `ParsedWorksConfig` minus the raw blob — passed downstream into generation           |
| `RepositoryTarget`    | `{owner?, repo}` — accepts bare slugs, HTTPS, and SSH URLs; trailing `/` and `.git` stripped |

## 6. Out of Scope

- Two-way live sync (the file is written only at generation boundaries, not on
  every UI edit).
- Storing secrets in `works.yml` (intentionally — secrets stay in the
  encrypted plugin-settings store).
- Separate per-environment overrides inside `works.yml` (environments
  differ via the platform's settings cascade, not the file).

## 7. Acceptance Criteria

- [x] Importing a repo that has `works.yml` pre-fills the import form with
      parsed values.
- [x] All four candidate file paths are tried in priority order.
- [x] Importing a repo with malformed YAML surfaces a parse error with the
      file path.
- [x] Plugin id validation rejects unknown ids before the import completes.
- [x] After a successful generation, `works.yml` is committed to the data
      repo with the work's current config.
- [x] Round-tripping a file with unknown top-level fields preserves them.
- [x] Clearing a field in the UI removes the corresponding key from the file
      on the next sync.
- [x] All seven cadence values plus their dash-separated aliases resolve to
      the correct enum value.
- [x] Sync failures are logged but do not fail generation.
- [x] Tests cover: parse, write, round-trip, malformed YAML, plugin id
      validation, schedule object/string forms, alias fields.

## 8. Open Questions

_None — feature is shipped and stable on `develop`._

## 9. Constitution Gates

- [x] **Principle I (Plugin-first)**: N/A — this is a core feature, not a
      plugin integration. Plugin ids referenced by `works.yml` are validated
      against the registry.
- [x] **Principle II (Capability-driven)**: `providers.{ai,search,…}` keys
      map to capabilities, not to specific plugin internals.
- [x] **Principle III (Source-of-truth repos)**: this feature **is** the
      embodiment of Principle III for configuration — the data repo holds the
      config, the database mirrors it.
- [x] **Principle IV (Trigger.dev for background work)**: sync runs inline
      with generation; no new background jobs were needed.
- [x] **Principle V (Forward-only migrations)**: no new schema; the writer
      operates on existing entities.
- [x] **Principle VI (Tests)**: unit tests under
      `packages/agent/src/works-config/__tests__/`.
- [x] **Principle VII (Secret hygiene)**: `works.yml` is explicitly limited
      to non-secret config; secrets stay in the encrypted plugin-settings
      store.
- [x] **Principle VIII (Plugin counts)**: not affected.
- [x] **Principle IX (Behaviour-first)**: this spec describes what users
      observe; implementation in `plan.md`.
- [x] **Principle X (Backwards-compat)**: aliased field names; unknown
      fields preserved; alternate cadence forms accepted.

## 10. References

- User-facing doc: [`../../../features/works-config.md`](../../../features/works-config.md)
- Implementation: `packages/agent/src/works-config/` (service, writer,
  import planner, restore service)
- Related features:
    - [`work-import/spec.md`](../work-import/spec.md) (consumes the parsed config)
    - [`scheduled-updates/spec.md`](../scheduled-updates/spec.md) (consumes
      the cadence)
- PR: #395
