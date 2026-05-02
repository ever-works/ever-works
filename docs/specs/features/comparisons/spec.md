# Feature Specification: A vs B Comparisons

**Feature ID**: `comparisons`
**Status**: `Retrospective`
**Created**: 2026-05-01
**Last updated**: 2026-05-01
**Owner**: Ever Works Team

---

## 1. Overview

For any work with at least N items per category, the platform can
auto-generate SEO-optimised "A vs B" comparison pages between pairs of items
in the same category. Comparisons are produced by a dedicated plugin
(`comparison-generator`), follow a configurable cadence, and ship with the
website on the next deploy.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** my work has at least 3 items in a category, **when** I
  enable comparisons, **then** the platform schedules generation of pair
  comparisons across that category and ships them to my website on the
  next deploy.
- **Given** I want comparisons regenerated weekly, **when** I set
  `cadence_override: weekly`, **then** the comparison generator runs on a
  weekly cadence independent of the work's main schedule.
- **Given** I want extended analyses, **when** I enable
  `extended_analysis: true`, **then** each comparison includes seven
  deep-dive sections (use cases, pricing, integrations, etc.) instead of
  the standard summary.

### 2.2 Edge cases & failures

- **Given** a category has fewer than `min_items_for_comparison` items
  (default 3), **when** generation runs, **then** that category is skipped
  with a logged reason.
- **Given** I configure `max_comparisons` and the category has more than
  that many possible pairs, **when** generation runs, **then** the system
  selects the top-N highest-value pairs (by category importance × item
  quality score) and stops at the cap.
- **Given** my chosen `ai_provider` is not installed, **when** generation
  runs, **then** the comparison run fails with an explicit error and the
  activity log surfaces the missing plugin.

## 3. Functional Requirements

- **FR-1** The platform MUST ship a `comparison-generator` plugin with
  capability `form-schema-provider` and id `comparison-generator`.
- **FR-2** The plugin MUST be configurable per work with the settings
  `cadence_override`, `max_comparisons_mode`, `max_comparisons`,
  `min_items_for_comparison`, `ai_provider`, `ai_model`, `custom_prompt`,
  `extended_analysis`.
- **FR-3** The system MUST only generate comparisons when the category has
  at least `min_items_for_comparison` items (default 3, range 2–20).
- **FR-4** When `max_comparisons_mode = custom`, the system MUST cap total
  comparisons at `max_comparisons` (default 50, range 1–500).
- **FR-5** When `max_comparisons_mode = unlimited`, the system MUST generate
  every possible pair within the configured `min_items_for_comparison`
  threshold.
- **FR-6** The cadence override MUST accept `use_work`, `daily`,
  `weekly`, `monthly`. `use_work` inherits from the work's main
  schedule.
- **FR-7** Generated comparisons MUST be persisted to the work's data
  repository (so they ship with the website like any other content).
- **FR-8** Each generated comparison MUST be reproducible: the same input
  items + settings must produce a deterministic output structure (model
  nondeterminism aside).
- **FR-9** When `extended_analysis = true`, the comparison output MUST
  include the seven deep-dive sections.
- **FR-10** When `ai_provider` is set, the comparison generator MUST
  request that specific provider rather than the work's default AI
  provider.

## 4. Non-Functional Requirements

- **Performance**: comparison generation runs as background work — no API
  request blocks on it.
- **Reliability**: failure of one comparison must not abort the batch.
- **Security**: comparison generation reuses the work's plugin
  credentials; no separate auth.
- **Observability**: each batch produces an activity-log entry with
  counts of generated / skipped / failed comparisons.
- **Cost**: `max_comparisons` cap is the user's primary cost control; the
  platform must not exceed it silently.

## 5. Key Entities & Domain Concepts

| Entity / concept     | Description                                                  |
| -------------------- | ------------------------------------------------------------ |
| Comparison page      | An A vs B page between two items in the same category        |
| `cadence_override`   | Per-comparison schedule, independent from work schedule |
| Pair selection score | Heuristic to rank pairs when `max_comparisons_mode = custom` |
| Extended analysis    | 7-section deep-dive variant of the standard comparison       |

## 6. Out of Scope

- Cross-work comparisons (only within a single work's category).
- Three-way comparisons (only A vs B; multi-way is future work).
- User-authored comparisons (the feature is fully AI-generated).

## 7. Acceptance Criteria

- [x] Default cadence is `use_work` and inherits the work schedule.
- [x] Categories below `min_items_for_comparison` are skipped with logging.
- [x] `max_comparisons_mode = custom` caps total output at `max_comparisons`.
- [x] `max_comparisons_mode = unlimited` ignores the cap.
- [x] `extended_analysis: true` produces the 7-section variant.
- [x] `ai_provider`/`ai_model` overrides flow into comparison generation
      only — the work's regular generation still uses its own settings.
- [x] Tests cover threshold check, cap enforcement, override routing.

## 8. Open Questions

_None on develop._

## 9. Constitution Gates

- [x] **I — Plugin-first**: comparison generation is its own plugin
      (`comparison-generator`) — not embedded in core.
- [x] **II — Capability-driven**: comparisons consume AI through
      `AiFacadeService`, never direct LangChain calls.
- [x] **III — Source-of-truth repos**: comparison files are committed to
      the user's data repo.
- [x] **IV — Trigger.dev**: comparison batches run as Trigger.dev tasks
      when scheduled.
- [x] **V — Forward-only migrations**: only additive (new settings columns
      where applicable).
- [x] **VI — Tests**: covered in plugin's `__tests__`, plus
      `comparison-generator.service.spec.ts` in the agent package.
- [x] **VII — Secret hygiene**: comparison generation reuses the user's
      plugin credentials; no new secret storage.
- [x] **VIII — Plugin counts**: comparison-generator is in the canonical
      `built-in-plugins.md` list.
- [x] **IX — Behaviour-first**: this spec describes user-observable
      behaviour.
- [x] **X — Backwards-compat**: settings are additive; defaults preserve
      existing behaviour.

## 10. References

- User-facing doc: [`../../../features/comparisons.md`](../../../features/comparisons.md)
- Plugin: `packages/plugins/comparison-generator/`
- Service: `packages/agent/src/comparison-generator/`
- Plugin doc:
  [`../../../plugin-system/comparison-generator-plugin.md`](../../../plugin-system/comparison-generator-plugin.md)
