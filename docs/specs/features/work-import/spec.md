# Feature Specification: Work Import

**Feature ID**: `work-import`
**Status**: `Retrospective`
**Created**: 2026-05-01
**Last updated**: 2026-05-01
**Owner**: Ever Works Team

---

## 1. Overview

A user can bootstrap a new work in the platform from an **existing**
GitHub repository — either an Ever Works-style data repo (`works.yml` +
items folder) or an "Awesome List" README. The import flow detects the
repo's shape, parses the existing content, validates it against plugins
referenced in any `works.yml`, and creates the work with all parsed
metadata pre-filled.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** I have a data repo with `works.yml`, **when** I import it,
  **then** the import flow pre-fills the work's name, prompt, model,
  providers, and schedule from the file.
- **Given** I have an Awesome-List README, **when** I import it, **then**
  the platform parses the items and offers them as the seed for the
  work; further generation is on-demand.
- **Given** the source repo has neither `works.yml` nor a recognised
  Awesome-List structure, **when** I import it, **then** the platform
  falls back to creating a fresh work with the repo as the data repo.

### 2.2 Edge cases & failures

- **Given** the `works.yml` references a plugin id that's not installed,
  **when** I confirm the import, **then** the import is rejected with
  "plugin not installed" before any database writes occur.
- **Given** the source repo's slug conflicts with an existing work I
  own, **when** I attempt import, **then** the platform suggests a unique
  slug.
- **Given** the source repo is private and my git provider token doesn't
  have access, **when** I attempt the import, **then** I get a clear
  "cannot read repo" error with a link to fix permissions.

## 3. Functional Requirements

- **FR-1** The import flow MUST accept a GitHub URL (HTTPS, SSH, or
  `owner/repo` slug) and resolve it to a `RepositoryTarget`.
- **FR-2** The platform MUST attempt to read `works.yml` from the source
  repo at the four candidate paths defined by the
  [`works-config`](../works-config/spec.md) feature.
- **FR-3** When `works.yml` is found, the import flow MUST pre-fill the
  work's name, prompt, model, providers, and schedule from it.
- **FR-4** Plugin id validation against the registry MUST happen before
  any database writes.
- **FR-5** When `works.yml` is absent, the platform MUST attempt
  Awesome-List-style README parsing as a fallback.
- **FR-6** Slug conflicts MUST be detected case-insensitively and the user
  offered a unique alternative.
- **FR-7** The import MUST NOT mutate the source repo until the user
  confirms; pre-fill is read-only until confirmation.
- **FR-8** On confirmation, the platform MUST create the work entity,
  register the source repo as the data repo, and (if applicable) fan out
  schedule + comparison settings.
- **FR-9** The import MUST emit an activity-log entry on completion with
  counts (items detected, skipped, imported).

## 4. Non-Functional Requirements

- **Performance**: import flow returns a parsed-config preview within ~3 s
  for typical repos (≤ 1000 items).
- **Reliability**: pre-fill is a dry-run — failures don't leave partial
  state.
- **Security**: import uses the user's git provider plugin credentials.
- **Observability**: every import attempt logs the source repo and outcome.

## 5. Key Entities & Domain Concepts

| Entity / concept           | Description                                           |
| -------------------------- | ----------------------------------------------------- |
| `WorksConfigImportPlanner` | Dry-run validator that builds the import preview      |
| `WorksConfigImportApplier` | Applies the validated plan to the work entity    |
| Source-repo shape          | Detected: `works-config` / `awesome-list` / `unknown` |

## 6. Out of Scope

- Importing from non-GitHub providers (GitLab, Bitbucket) — currently
  GitHub only.
- Live two-way sync after import (use `works.yml` round-trip per
  [`works-config`](../works-config/spec.md)).

## 7. Acceptance Criteria

- [x] HTTPS, SSH, and `owner/repo` URL formats are accepted.
- [x] `works.yml`-based imports pre-fill all parsed fields.
- [x] Awesome-List parsing kicks in only when `works.yml` is absent.
- [x] Plugin id validation rejects unknown ids before DB writes.
- [x] Slug conflicts are detected case-insensitively.
- [x] Tests cover both source shapes plus failure paths.

## 8. Open Questions

_None on develop._

## 9. Constitution Gates

- [x] **I**: imports use existing plugins (git, AI) — no new integrations.
- [x] **II**: git access via facade.
- [x] **III**: source repo becomes the data repo — content stays in user
      ownership.
- [x] **IV**: long-running parts (Awesome-List item normalisation) run as
      background work.
- [x] **V**: only additive work schema fields (e.g. `worksConfigPath`
      column).
- [x] **VI**: import planner/applier have unit tests.
- [x] **VII**: git tokens never logged.
- [x] **VIII**: N/A.
- [x] **IX**: this spec describes user-observable behaviour.
- [x] **X**: import payload is additive — older clients without new fields
      still work.

## 10. References

- User-facing doc:
  [`../../../features/work-import.md`](../../../features/work-import.md)
- Related: [`works-config/spec.md`](../works-config/spec.md)
- Implementation: `packages/agent/src/import/`,
  `packages/agent/src/works-config/services/works-config-import-*.service.ts`
