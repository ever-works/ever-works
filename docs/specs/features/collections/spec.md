# Feature Specification: Collections

**Feature ID**: `collections`
**Status**: `Retrospective`
**Created**: 2026-05-01
**Last updated**: 2026-05-01
**Owner**: Ever Works Team

---

## 1. Overview

Collections are **editorial** groupings that cut across categories — "Editor's
Picks", "Best for Beginners", "Top Open Source", and similar curated lists.
They are independent of the category/tag taxonomy. An item belongs to
exactly one category, can have many tags, and may optionally belong to one
collection. Both AI-assigned and manually-managed collections are supported,
and they can be independently toggled on/off.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** I run a new work generation, **when** the Standard
  Pipeline plugin has `generate_collections: true`, **then** the AI
  proposes collection assignments for items where it sees a clear fit
  and the items get a `collection` field in their YAML.
- **Given** I want to add an "Editor's Picks" collection manually,
  **when** I `POST /api/works/:id/collections` with a name and
  optional description, **then** the platform stores it in
  `collections.yml` in the data repo and assigns it the slug
  `editors-picks`.
- **Given** I want to display collections on the website, **when** I set
  `collections_enabled: true` on the website settings, **then** the
  deployed site renders them; setting it to `false` hides them without
  deleting any data.
- **Given** an AI-generated collection only has `id` + `name`, **when** I
  `PUT /api/works/:id/collections/<id>` with `description`,
  `icon_url`, and `priority`, **then** the collection is enriched.

### 2.2 Edge cases & failures

- **Given** I delete a collection, **when** the deletion completes,
  **then** items previously assigned to that collection have their
  `collection` field cleared rather than the items being deleted.
- **Given** I create a collection with the same name as an existing one,
  **when** the platform slugifies it, **then** the duplicate name is
  rejected (case-insensitive comparison) before any data repo write.
- **Given** I want AI-generated collections off but manual ones on,
  **when** I set `generate_collections: false` on the Standard Pipeline
  plugin and leave `collections_enabled: true`, **then** the next
  generation does not emit collections and existing collections still
  render on the website.

## 3. Functional Requirements

- **FR-1** Collections MUST be a third taxonomy dimension alongside
  categories and tags, with cardinality 0–1 per item.
- **FR-2** Collection ids MUST be auto-slugified from the name; users MUST
  NOT be able to set the id directly.
- **FR-3** Collection name uniqueness MUST be enforced case-insensitively.
- **FR-4** Collection `name` MUST be ≤ 100 chars; `description` ≤ 500;
  `icon_url` ≤ 500; `priority` ≥ 0.
- **FR-5** The website's collection display MUST be independently toggled
  via `collections_enabled` on website settings.
- **FR-6** AI generation of collections MUST be independently toggled via
  `generate_collections` on the Standard Pipeline plugin settings.
- **FR-7** Both toggles MUST default to `true`.
- **FR-8** Collections MUST be persisted to `collections.yml` in the
  work's data repository on every CRUD mutation.
- **FR-9** Items reference collections by slug id in their YAML
  (`collection: editors-picks`).
- **FR-10** Deleting a collection MUST clear the `collection` field on
  every affected item (no orphans, no item deletion).
- **FR-11** The list endpoint MUST return collections via
  `GET /api/works/:id/categories-tags` alongside categories and
  tags (one round-trip for all three taxonomies).
- **FR-12** AI-assigned collections MUST contain only `id` + `name` until
  a user enriches them via update.

## 4. Non-Functional Requirements

- **Performance**: collection CRUD is a single git commit + push to the
  data repo; expect 500 ms–2 s end-to-end depending on git provider.
- **Reliability**: a failed git push leaves the database and the data repo
  unchanged (atomic from the user's perspective).
- **Security & privacy**: edit access required for create/update/delete;
  viewer access for read.
- **Observability**: collection mutations emit changelog entries
  (`collection_change`) per the [Work Changelog](../work-changelog/spec.md).
- **Compatibility**: collections are additive to the existing taxonomy;
  items without a collection still validate.

## 5. Key Entities & Domain Concepts

| Entity / concept       | Description                                                         |
| ---------------------- | ------------------------------------------------------------------- |
| Collection             | `{id, name, description?, icon_url?, priority?}` editorial grouping |
| `collections.yml`      | Per-work file in the data repo holding the collection list     |
| `collections_enabled`  | Website-side toggle controlling whether collections render          |
| `generate_collections` | Pipeline-side toggle controlling AI collection assignment           |
| Item collection ref    | Slug id stored in the item's YAML                                   |

## 6. Out of Scope

- Multi-collection items (cardinality is fixed at 0–1).
- Cross-work collections.
- Nested collections / sub-collections.
- Collections-only filtering at the API level (clients filter client-side).

## 7. Acceptance Criteria

- [x] Create / read / update / delete endpoints behave as specified.
- [x] Auto-slug from name; duplicate-name rejection.
- [x] AI generation toggle and website display toggle work independently.
- [x] Deleting a collection clears references in items, doesn't delete items.
- [x] `collections.yml` is committed to the data repo on every mutation.
- [x] Tests cover: CRUD, slug generation, duplicate detection, AI flow,
      deletion cascade, toggle independence.

## 8. Open Questions

_None on develop._

## 9. Constitution Gates

- [x] **I**: Standard Pipeline plugin handles collection generation —
      Principle I respected.
- [x] **II**: collection assignment uses the AI facade.
- [x] **III**: collections live in the data repo (`collections.yml`),
      not the database (only metadata is mirrored).
- [x] **IV**: AI generation runs inside the existing pipeline; no new
      background jobs.
- [x] **V**: no schema changes (data lives in the repo).
- [x] **VI**: covered in
      `packages/agent/src/services/__tests__/work-taxonomy.service.spec.ts`.
- [x] **VII**: no secrets involved.
- [x] **VIII**: N/A.
- [x] **IX**: this spec describes user-observable behaviour.
- [x] **X**: additive — items without a collection still validate.

## 10. References

- User-facing doc: [`../../../features/collections.md`](../../../features/collections.md)
- Related: [`taxonomy-system/spec.md`](../taxonomy-system/spec.md)
- Implementation:
  `packages/agent/src/services/work-taxonomy.service.ts`
- Pipeline integration:
  `packages/plugins/standard-pipeline/src/steps/categories-tags-processing.step.ts`
