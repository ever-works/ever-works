# Feature Specification: Item Source Validation

**Feature ID**: `item-source-validation`
**Status**: `Retrospective`
**Created**: 2026-05-01
**Last updated**: 2026-05-01
**Owner**: Ever Works Team

---

## 1. Overview

For every item that has a `source_url`, the platform validates **two
separate things**: (1) whether the URL is reachable (an HTTP-driven
deterministic check) and (2) whether it is actually a _good_ source for
the item — relevant, specific, and ideally official (an AI-driven
qualitative check). The result lives on the item and is rendered as
compact status in the dashboard, with broken links surfaced as warnings
and accuracy issues surfaced as quieter status text. Validation runs
after generation by default and can also run on its own user-controlled
cadence.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** my work has a fresh generation run, **when** the
  pipeline finishes, **then** every item's `source_url` is validated
  and the result is stored on the item.
- **Given** I'm reviewing items in the dashboard, **when** an item has a
  broken source, **then** I see a clear warning indicator I can't
  miss.
- **Given** an item's source is reachable but generic (e.g. the
  homepage of a multi-product company), **when** I look at the item,
  **then** I see a lower-noise "generic" status rather than a warning
  — and an AI-suggested replacement URL in the action menu.
- **Given** I want validation more often than my generation cadence,
  **when** I set `sourceValidationCadence: weekly` while my
  generation is monthly, **then** validation runs weekly on its own
  schedule.
- **Given** an AI suggested a better source URL, **when** I click
  "Apply suggestion" in the action menu, **then** the item's
  `source_url` is replaced.

### 2.2 Edge cases & failures

- **Given** a `source_url` returns `404` or `410`, **when** validation
  runs, **then** `reachability_status` is set to `broken` (high
  confidence).
- **Given** a `source_url` returns an ambiguous error (timeout, 500),
  **when** validation runs, **then** `reachability_status` stays
  `unknown` rather than being shown as a false `broken`.
- **Given** I click "Re-check source" repeatedly, **when** it's been
  less than the cooldown window, **then** the cached result is
  returned without re-running git+extraction+AI.
- **Given** an item's URL is reachable but the AI can't decide
  accuracy, **when** validation completes, **then** `accuracy_status`
  is `unknown` and no warning is surfaced.

## 3. Functional Requirements

- **FR-1** Each item MUST carry an `ItemSourceValidation` blob with:
  `reachability_status` (`reachable` / `broken` / `unknown`),
  `accuracy_status` (`accurate` / `generic` / `weak` / `unknown`),
  `checked_at`, optional `confidence_score`, `is_relevant`,
  `is_specific`, `is_official`, `reason`, `suggested_source_url`.
- **FR-2** Reachability MUST be a deterministic HTTP check; only
  high-confidence dead-link signals (`404`, `410`) result in `broken`.
- **FR-3** Ambiguous failures (network timeouts, 5xx) MUST result in
  `unknown`, NOT `broken`.
- **FR-4** When the URL is not clearly broken, content extraction MUST
  be attempted; successful extraction is also evidence of
  reachability.
- **FR-5** AI source validation MUST run **separately** from
  reachability and produce its own `accuracy_status`.
- **FR-6** Validation MUST run automatically after every successful
  generation completion.
- **FR-7** Validation MUST also support an independent periodic
  scheduler controlled per-work by `sourceValidationCadence`.
- **FR-8** When `sourceValidationCadence` is unset, the work's
  main schedule cadence is used as the default.
- **FR-9** Manual single-item re-check via
  `POST /api/works/:id/check-item-health` MUST persist the
  result on the item.
- **FR-10** Repeated manual re-checks MUST be cached for a short
  window to avoid hammering external resources.
- **FR-11** Apply-suggestion MUST replace `source_url` with
  `suggested_source_url` when the user opts in via the item action
  menu.
- **FR-12** The UI MUST render broken as a strong warning, and
  reachable / accurate / generic / weak as compact persistent
  status text.

## 4. Non-Functional Requirements

- **Performance**: per-item validation is bounded by HTTP fetch +
  optional AI call (≈ 2–10 s typical).
- **Reliability**: validation failures don't block generation; results
  are best-effort.
- **Security & privacy**: HTTP fetches go through the platform's HTTP
  client, not the user's browser; no PII captured.
- **Observability**: validation cadence runs emit summary log entries
  with counts (reachable / broken / unknown).
- **Compatibility**: extending the validation blob with new optional
  fields is backwards-compatible.

## 5. Key Entities & Domain Concepts

| Entity / concept          | Description                                                       |
| ------------------------- | ----------------------------------------------------------------- |
| `ItemSourceValidation`    | Per-item blob with reachability + accuracy + AI metadata          |
| Reachability check        | Deterministic HTTP-based step                                     |
| Accuracy check            | AI step that runs only if not clearly broken                      |
| `sourceValidationCadence` | Per-work schedule field, falls back to main schedule cadence |
| Manual re-check           | User-initiated single-item re-validation with short-window cache  |
| `suggested_source_url`    | AI-proposed replacement URL                                       |

## 6. Out of Scope

- Crawling target sites for content quality beyond the source URL itself.
- Automatic source replacement (always user-confirmed).
- Cross-item dedup of sources (future enhancement).
- Per-user (vs per-work) validation schedules.

## 7. Acceptance Criteria

- [x] Reachability and accuracy stored separately.
- [x] Only `404` / `410` produce `broken`.
- [x] Validation runs after successful generation.
- [x] Independent cadence respected when set.
- [x] Manual re-check supported with cache.
- [x] Apply-suggestion replaces `source_url`.
- [x] Tests cover deterministic check, AI fallback, cadence selection.

## 8. Open Questions

_None on develop._

## 9. Constitution Gates

- [x] **I**: AI step uses provider plugins; content-extraction step
      uses extractor plugins.
- [x] **II**: facades route both AI and extraction calls.
- [x] **III**: validation result is mirrored back to the item YAML in
      the data repo.
- [x] **IV**: scheduled validation runs as a Trigger.dev task.
- [x] **V**: schema additions on the work schedule (additive
      column for `sourceValidationCadence`).
- [x] **VI**: tested per-step and end-to-end in
      `packages/agent/src/services/__tests__/`.
- [x] **VII**: no secret leakage.
- [x] **VIII**: N/A.
- [x] **IX**: behaviour-first.
- [x] **X**: validation blob is additive on items.

## 10. References

- User-facing doc: [`../../../features/item-source-validation.md`](../../../features/item-source-validation.md)
- Web UI: [`../../../web-dashboard/items-ui.md`](../../../web-dashboard/items-ui.md)
- Related: [`scheduled-updates/spec.md`](../scheduled-updates/spec.md)
- Implementation:
    - `packages/agent/src/services/item-source-validation-scheduler.service.ts`
    - `packages/agent/src/generators/data-generator/source-validation/`
