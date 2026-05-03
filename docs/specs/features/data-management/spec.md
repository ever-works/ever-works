# Feature Specification: Data Management (Export / Import / GitHub Sync)

**Feature ID**: `data-management`
**Status**: `Retrospective`
**Created**: 2026-05-01
**Last updated**: 2026-05-01
**Owner**: Ever Works Team

---

## 1. Overview

Data Management provides three coordinated tools for moving an entire
account's configuration in and out of an Ever Works instance: **Export**
(download a versioned JSON snapshot), **Import** (upload that snapshot to
restore or migrate), and **GitHub Sync** (continuous backup of the same
data to a private GitHub repository, push or pull). The shared design
principle is uncompromising secret hygiene: real credentials never leave
the API surface, and sync repos never store usable secrets.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Export**: **Given** I want to migrate my account, **when** I click
  "Export" with `includeSecrets: true`, **then** I download a JSON file
  containing all my works, items, plugins, etc. — with secret
  values **masked** (`MASKED:sk-***1234`) so they're identifiable but
  unusable.
- **Import preview**: **Given** I have an export JSON, **when** I upload
  it to the preview endpoint, **then** I get a summary including
  work count, total items, missing-plugin warnings, masked-secret
  detection, and slug conflicts before any data changes.
- **Import apply**: **Given** I confirmed the preview and resolved
  conflicts, **when** I apply the import, **then** the platform
  creates/updates works and their relations, clones each data
  repo, writes items + categories + tags + collections + comparisons +
  site config + markdown templates, commits, and pushes — all atomic
  per work.
- **GitHub Sync push**: **Given** I configured a private
  `ever-works-config` repo, **when** I push, **then** the platform
  writes a structured manifest + per-work folders (with masked
  secrets) and commits.
- **GitHub Sync pull**: **Given** my config exists in the repo, **when**
  I pull, **then** the platform reads the structured files,
  reconstructs an export payload, and presents it as an import preview
  — same conflict-resolution flow as file import.

### 2.2 Edge cases & failures

- **Given** the import file contains masked secrets, **when** I apply,
  **then** every `MASKED:...` value is **skipped** and a per-plugin
  warning lists which keys need to be filled in by hand afterwards.
- **Given** my import file references a plugin that's not installed,
  **when** the preview runs, **then** the missing plugin id appears in
  `missingPlugins` and (on apply) those settings are skipped.
- **Given** an imported work's slug collides with an existing one,
  **when** I see the conflict, **then** I choose one of: `skip` (keep
  existing), `overwrite` (update existing), or `rename` (use a fresh
  slug).
- **Given** a malicious file tries to write to `works/../etc/passwd`,
  **when** GitHub Sync writes it, **then** `path.basename()` strips
  any traversal and only the safe slug component is used as a filename.
- **Given** my GitHub repo contains masked values from a previous push,
  **when** I pull, **then** **all** secret values are unconditionally
  ignored on import — masked or not — to prevent overwriting real
  credentials in the DB.

## 3. Functional Requirements

- **FR-1** Export MUST produce a versioned JSON file with `version`,
  `exportedAt`, `includesSecrets`, and `data` fields.
- **FR-2** Export MUST include: profile, works (with items,
  categories, tags, collections, comparisons, site config, markdown
  templates, schedules, advanced prompts, members, custom domains,
  work plugins), and user plugins.
- **FR-3** When `includeSecrets` is `true`, secret values MUST be
  **masked** as `MASKED:<first-3>***<last-4>` (or `MASKED:********`
  for values ≤ 8 chars). Real values MUST NEVER be exported.
- **FR-4** When `includeSecrets` is `false`, secret keys MUST be omitted
  entirely.
- **FR-5** Import preview MUST return: `valid`, `version`,
  `includesSecrets`, `hasMaskedSecrets`, `workCount`,
  `totalItemCount`, `userPluginCount`, `conflicts`, `missingPlugins`.
- **FR-6** Import apply MUST accept a `resolutions[]` array per
  conflicting slug, each with strategy `skip` / `overwrite` / `rename`.
- **FR-7** Import apply MUST detect any value still containing
  `MASKED:...` and SKIP it, recording a per-plugin warning.
- **FR-8** Import apply MUST persist works and their relations
  (members, domains, plugins, advanced prompts, schedules) atomically
  per-work; partial failures must not corrupt state.
- **FR-9** GitHub Sync MUST support a private repo (default name
  `ever-works-config`) and produce a structured layout with
  `manifest.json`, `profile.json`, per-work folders.
- **FR-10** GitHub Sync push MUST follow the same secret hygiene as
  export — masked or omitted, never real values.
- **FR-11** GitHub Sync pull MUST always ignore secret values
  regardless of what is in the repo (defence against masked values
  overwriting real DB credentials).
- **FR-12** All sync operations MUST validate slug components with
  `path.basename()` to prevent path traversal.

## 4. Non-Functional Requirements

- **Performance**: export of a typical account (10 dirs, 1000 items
  each) completes in ≤ 30 s. Import is bounded by git push time per
  work.
- **Reliability**: per-work atomicity means a single failed
  work doesn't break the rest of the import.
- **Security & privacy**: this feature exists almost entirely to make
  Constitution Principle VII durable across export/import/sync
  boundaries.
- **Observability**: import results return structured warnings + errors;
  the dashboard surfaces them as toasts and inline in the result panel.
- **Compatibility**: export format is versioned. Future versions can be
  added without breaking the v1 import path.

## 5. Key Entities & Domain Concepts

| Entity / concept     | Description                                                |
| -------------------- | ---------------------------------------------------------- |
| Export envelope      | `{version, exportedAt, includesSecrets, data}`             |
| Masked-secret format | `MASKED:<first-3>***<last-4>` or `MASKED:********`         |
| Conflict resolution  | Per-slug strategy: `skip` / `overwrite` / `rename`         |
| Sync manifest        | `manifest.json` at the repo root with version + timestamps |
| Path-traversal guard | `path.basename(slug)` enforced on every read/write         |

## 6. Out of Scope

- Selective per-work export (today export is all-or-nothing per user).
- Cross-user import (each user imports into their own account).
- Two-way live sync (push and pull are user-initiated, no continuous
  sync daemon).
- Rolling back an applied import (immutable once applied; users use
  git history of their data repos for that).

## 7. Acceptance Criteria

- [x] Real secrets never appear in any export, sync push, or API response.
- [x] Masked values on import are skipped with warnings.
- [x] Three conflict strategies all work as documented.
- [x] Path traversal blocked on both write and read.
- [x] Pull from GitHub presents the same preview/conflict flow as file
      import.
- [x] Pull always ignores secret values, regardless of file contents.
- [x] Tests cover masked redaction, masked detection, all three
      strategies, missing-plugin path, traversal attempts.

## 8. Open Questions

_None on develop._

## 9. Constitution Gates

- [x] **I — Plugin-first**: plugin settings exported/imported as data;
      plugins themselves not affected.
- [x] **II — Capability-driven**: data sync runs through the existing
      git facade.
- [x] **III — Source-of-truth repos**: export and sync READ the data
      repo; import WRITES to it. This feature respects the user's
      ownership.
- [x] **IV — Trigger.dev**: not used here; sync is user-initiated.
- [x] **V — Forward-only migrations**: no schema changes.
- [x] **VI — Tests**: heavy coverage on redaction, masking, conflict,
      traversal.
- [x] **VII — Secret hygiene**: this feature is the canonical
      enforcement of Principle VII at the boundary.
- [x] **VIII — Plugin counts**: N/A.
- [x] **IX — Behaviour-first**: this spec describes user-observable
      behaviour.
- [x] **X — Backwards-compat**: export format versioned.

## 10. References

- User-facing doc: [`../../../features/data-management.md`](../../../features/data-management.md)
- Implementation: `apps/api/src/account/` (export, import, sync
  services)
