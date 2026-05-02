# Feature Specification: Work Changelog

**Feature ID**: `work-changelog`
**Status**: `Retrospective`
**Created**: 2026-05-01
**Last updated**: 2026-05-01
**Owner**: Ever Works Team

---

## 1. Overview

The work changelog turns each work's History tab from a metrics
log into a reviewable audit trail. Every mutation — generation runs,
manual item edits, taxonomy changes, comparison creation/deletion,
community PR processing — produces a `WorkGenerationHistory` entry
with an `activityType` and a structured `changelog` payload listing
exactly what was added, updated, or removed.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** an AI generation run completed, **when** I open the History
  tab, **then** I see an entry with `activityType: 'generation'`, a
  summary line ("Generated 27 items, updated 5"), and an expandable
  list of every added/updated/removed item by name.
- **Given** I manually added an item, **when** I open History, **then** I
  see an entry with `activityType: 'item_added'` and the item name in
  the entry list.
- **Given** I created a comparison page, **when** I open History,
  **then** I see `activityType: 'comparison_added'` with the
  comparison name.
- **Given** a category was renamed, **when** I open History, **then** I
  see `activityType: 'category_change'` with `action: updated`,
  `name`, and `fieldsChanged: ['name']`.
- **Given** I want to filter, **when** I select an activity-type group
  in the UI, **then** only matching entries are shown
  (`generation` / `items` / `comparisons` / `taxonomy` / `community_pr`).

### 2.2 Edge cases & failures

- **Given** a `RECREATE` generation replaced the entire item set,
  **when** History is queried, **then** the entry includes the removed
  items as well as the new ones (so users can see what disappeared).
- **Given** thousands of changes happened in one run, **when** I open
  the entry, **then** the entry list is paginated client-side rather
  than rendered as one giant list.
- **Given** a community PR was processed, **when** History runs,
  **then** an entry with `activityType: 'community_pr_merged'` is
  created with a summary referencing the PR number.

## 3. Functional Requirements

- **FR-1** Every mutation that changes a work's content MUST
  produce a `WorkGenerationHistory` row with an `activityType`.
- **FR-2** The `changelog` payload MUST be structured:
  `{summary?, addedCount, updatedCount, removedCount, entries[]}`.
- **FR-3** Each `entries[]` item MUST be
  `{entityType, action, name, slug?, fieldsChanged?[]}` where
  `entityType ∈ {item, comparison, category, tag, collection}` and
  `action ∈ {added, updated, removed}`.
- **FR-4** The History API endpoint MUST support pagination (`limit`,
  `offset`) and an optional `activityType` filter group.
- **FR-5** Activity types MUST include: `generation`, `item_added`,
  `item_updated`, `item_removed`, `comparison_added`,
  `comparison_removed`, `category_change`, `tag_change`,
  `collection_change`, `community_pr_merged`.
- **FR-6** `RECREATE` generations MUST capture removed items in the
  changelog (the new set replaces the old).
- **FR-7** The History UI MUST support an expandable details view
  grouping entries by Added / Updated / Removed.
- **FR-8** Manual item edits MUST attach `fieldsChanged[]` to the
  changelog entry so reviewers know which fields were touched.

## 4. Non-Functional Requirements

- **Performance**: a History page (default 20 entries) returns in
  ≤ 200 ms for a work with 100 K history rows.
- **Reliability**: changelog write is part of the same transaction as
  the underlying mutation — no orphan history entries, no missing
  entries.
- **Security & privacy**: history requires viewer access on the
  work; secret fields are never written to changelog entries.
- **Observability**: the changelog itself IS the observability surface
  for content changes.
- **Compatibility**: new activity types can be added without breaking
  existing UI; the UI groups by known prefixes and falls back
  gracefully.

## 5. Key Entities & Domain Concepts

| Entity / concept           | Description                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `WorkGenerationHistory`    | Per-work log row with status, duration, metrics, activityType, changelog            |
| `WorkChangelog`            | `{summary?, addedCount, updatedCount, removedCount, entries[]}`                     |
| `WorkChangelogEntry`       | `{entityType, action, name, slug?, fieldsChanged?[]}`                               |
| Activity-type filter group | UI-level grouping: `generation`, `items`, `comparisons`, `taxonomy`, `community_pr` |

## 6. Out of Scope

- Per-field diffs (we record `fieldsChanged[]` names, not before/after
  values).
- Reverting a change from history (one-way audit trail).
- Cross-work changelogs (per-work only).

## 7. Acceptance Criteria

- [x] Every mutation produces a history row with `activityType`.
- [x] Pagination + filter parameters supported on the API.
- [x] UI shows summary + expandable details with Added/Updated/Removed
      grouping.
- [x] `RECREATE` runs include removed items.
- [x] Tests cover all activity types and pagination.

## 8. Open Questions

_None on develop._

## 9. Constitution Gates

- [x] **I**: N/A (no plugin involved in changelog).
- [x] **II**: N/A.
- [x] **III**: changelog mirrors what's in the data repo — DB serves as
      the audit log of repo writes.
- [x] **IV**: writes happen inline with the mutation; no new background
      work.
- [x] **V**: `changelog` jsonb column is additive on
      `work_generation_history`.
- [x] **VI**: covered by service tests in
      `packages/agent/src/activity-log/` and `work-history/`.
- [x] **VII**: changelog never includes secret values.
- [x] **VIII**: N/A.
- [x] **IX**: behaviour-first.
- [x] **X**: payload is JSON — additive evolution.

## 10. References

- User-facing doc: [`../../../features/work-changelog.md`](../../../features/work-changelog.md)
- Web UI doc: [`../../../web-dashboard/history-ui.md`](../../../web-dashboard/history-ui.md)
- Related: [`scheduled-updates/spec.md`](../scheduled-updates/spec.md),
  [`community-pr-processing/spec.md`](../community-pr-processing/spec.md),
  [`taxonomy-system/spec.md`](../taxonomy-system/spec.md)
- Implementation:
    - `packages/agent/src/activity-log/`
    - `packages/agent/src/entities/work-generation-history.entity.ts`
